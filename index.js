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
              if( (toKeep > 0) && (v.Version != '$LATEST') ) {
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
            }, { concurrency: 1 });
          });
        }, { concurrency: 1 });

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
  }
  return LambdaPrune;
};
