Serverless Lambda Prune Plugin
=============================

When developing with [Serverless](http://serverless.com/) framework your AWS account will quickly hit the 1.5GB total lambda size limit. This plugin will iteratively scan all lambdas in your AWS account (not only lambdas defined in the project!) and remove their old versions.

Most recent versions and versions with aliases are not deleted.

Installation
============

`npm install serverless-lambda-prune-plugin`

and add into /s-project.json :

    "plugins": [
      "serverless-lambda-prune-plugin"
    ],

Usage
=====

`sls function prune -r "us-east-1"`

Options:

`--number number` / `-n number`: keep `number` most recent versions (default: 5)
`--region region` / `-r region`
