'use strict';

module.exports = function(SPlugin, serverlessPath) {
  const path = require( 'path' ),
  SUtils = require( path.join( serverlessPath, 'utils' ) ),
  context = require( path.join( serverlessPath, 'utils', 'context' ) ),
  SCli = require( path.join( serverlessPath, 'utils', 'cli' ) ),
  AWS = require( 'aws-sdk' ),
  BbPromise = require( 'bluebird' );

  let params = {};
  if( process.env.AWS_REGION ) {
    params.region = process.env.AWS_REGION;
  }

  let Lambda = new AWS.Lambda( params );
  BbPromise.promisifyAll( Object.getPrototypeOf( Lambda ), { suffix: 'Asynchronously' } );

  let APIGateway = new AWS.APIGateway( params );
  BbPromise.promisifyAll( Object.getPrototypeOf( APIGateway ) );

  class LambdaPrune extends SPlugin {
    constructor(S) {
      super(S);
    }
    static getName() {
      return 'net.nopik.' + LambdaPrune.name;
    }
    registerActions() {
      this.S.addAction(this.prune.bind(this), {
        handler:       'prune',
        description:   `Delete old/unused lambda versions from your AWS account`,
        context:       'function',
        contextAction: 'prune',
        options:       [
          {
            option:      'number',
            shortcut:    'n',
            description: 'Keep last N versions (default: 5)'
          }
        ]
      });
      this.S.addAction(this.apigPrune.bind(this), {
        handler:       'apigPrune',
        description:   `Delete old/unused API Gateway deployments from your AWS account`,
        context:       'endpoint',
        contextAction: 'prune',
        options:       [
          {
            option:      'number',
            shortcut:    'n',
            description: 'Keep N latest versions (default: 5)'
          }
        ]
      });
      return BbPromise.resolve();
    }
    registerHooks() {
      return Promise.resolve();
    }

    _slowdownRequests( f ){
      return new BbPromise( function( resolve, reject ){
        let doCall = function(){
          f()
            .then(resolve)
            .catch(function(error) {
              if( error.message == 'Rate Exceeded.' ) {
                SCli.log("'Too many requests' received, sleeping 5 seconds");
                setTimeout( doCall, 5000 );
              } else
                reject( error );
            });
        };

        doCall();
      });
    }

    _listLambdas(evt){
      let _this =  this;

      //TODO: handle marker for pagination?
      return _this._slowdownRequests( function(){ return Lambda.listFunctionsAsynchronously({}); } ).then(function(functions){
        BbPromise.map(functions.Functions, function(f){
          return BbPromise.all([
            _this._slowdownRequests( function(){ return Lambda.listAliasesAsynchronously({ FunctionName: f.FunctionName }); } ),
            _this._slowdownRequests( function(){ return Lambda.listVersionsByFunctionAsynchronously({ FunctionName: f.FunctionName }); } )
          ]).spread(function( aliases, versions ){
            SCli.log( `Pruning ${f.FunctionName}, found ${aliases.Aliases.length} aliases and ${versions.Versions.length} versions` );

            let keepVersions = aliases.Aliases.map(function(a){
              return a.FunctionVersion;
            });

            keepVersions.push( '$LATEST' );

            let vs = versions.Versions.sort(function( v1, v2 ){
              if( v1.LastModified < v2.LastModified ) {
                return 1;
              } else {
                if( v1.LastModified > v2.LastModified ) {
                  return -1;
                } else {
                  return 0;
                }
              }
            });

            let toKeep = evt.number;
            vs.forEach(function( v ){
              if( (toKeep > 0) && (v.Version != '$LATEST') && (keepVersions.indexOf( v.Version ) < 0) ) {
                keepVersions.push( v.Version );
                toKeep--;
              }
            });

            return BbPromise.map(versions.Versions, function (v){
              if( keepVersions.indexOf( v.Version ) < 0 ) {
                SCli.log( `Deleting version ${v.Version} of ${f.FunctionName} function` );

                return _this._slowdownRequests( function(){ return Lambda.deleteFunctionAsynchronously({
                  FunctionName: f.FunctionName,
                  Qualifier: v.Version
                }); });
              }
            }, { concurrency: 3 });
          });
        }, { concurrency: 3 });

        return evt;
      });
    }

    prune(evt) {
      let _this = this;

      if (_this.S.cli) {
        evt = JSON.parse(JSON.stringify(this.S.cli.options));
        if (_this.S.cli.options.nonInteractive) _this.S._interactive = false
      }

      _this.evt = evt;

      if( !_this.evt.number ){
        _this.evt.number = 5;
      }

      return this.S.validateProject()
        .bind(_this)
        .then(function() {
          return _this.evt;
        })
        .then(_this._listLambdas);
    }
    _listApiStages( restApiId ){
      return this._slowdownRequests( function(){
        return APIGateway.getStagesAsync({ restApiId: restApiId });
      }).then(function(res){
        return res.item;
      });
    }
    _listDeployments( restApiId ){
      let _this = this;
      let getPage = function(items, position) {
        return _this._slowdownRequests( function(){
          return APIGateway.getDeploymentsAsync({
            restApiId: restApiId,
            position: position
          }).then( function(data){
            data.items.forEach(function(item){
              item.date = new Date( item.createdDate );
            });
            items = items.concat( data.items );
            if( data.position ) {
              return getPage( items, data.position );
            } else {
              return items;
            }
          });
        });
      };
      return getPage( [] );
    }
    _deleteDeployments( restApiId, deployments ){
      let _this = this;
      return BbPromise.map( deployments, function(d){
        SCli.log( `Deleting deployment ${ d.id } created on ${ d.createdDate }` );
        return _this._slowdownRequests( function(){
          return APIGateway.deleteDeploymentAsync({
            deploymentId: d.id,
            restApiId: restApiId
          });
        });
      }, { concurrency: 3 } );

    }
    apigPrune(evt){
      let _this = this;

      if (_this.S.cli) {
        evt = JSON.parse(JSON.stringify(this.S.cli.options));
        if (_this.S.cli.options.nonInteractive) _this.S._interactive = false
      }

      _this.evt = evt;

      if( !_this.evt.number ){
        _this.evt.number = 5;
      }

      return this.S.validateProject()
          .bind(_this)
          .then(function() {
            return _this.evt;
          })
          .then(function(){
            //FIXME: this takes first API id from first found stage; consider more clever way
            let restApiId =_this.S._projectJson.stages[ Object.getOwnPropertyNames( _this.S._projectJson.stages )[ 0 ] ][ 0 ].restApiId;
            return BbPromise.all([
              _this._listApiStages( restApiId ),
              _this._listDeployments( restApiId )
            ]).spread(function( stages, deployments ){
              let stage_deployments = stages.map(function(s){
                return s.deploymentId;
              })
              let to_keep = evt.number;
              let deployments_to_remove = deployments.sort( function( d1, d2 ) {
                if( d1.date < d2.date ) {
                  return 1;
                } else {
                  if( d1.date > d2.date ) {
                    return -1;
                  } else {
                    return 0;
                  }
                }
              }).filter( function(d){
                if( stage_deployments.indexOf( d.id ) >= 0 ) {
                  return false;
                } else {
                  if( 0 < to_keep ){
                    to_keep--;
                    return false;
                  } else {
                    return true;
                  }
                }
              });
              SCli.log( `Found ${ stages.length } stages and ${ deployments.length } deployments; ${ deployments_to_remove.length } deployments to be removed` );
              return _this._deleteDeployments( restApiId, deployments_to_remove );
            });
          });
    }

  }
  return LambdaPrune;
};
