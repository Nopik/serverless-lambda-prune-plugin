Serverless Lambda Prune Plugin
=============================

When developing with [Serverless](http://serverless.com/) framework your AWS account will quickly hit the 1.5GB total lambda size limit. This plugin will iteratively scan all lambdas in your AWS account (not only lambdas defined in the project!) and remove their old versions.

Most recent versions and versions with aliases are not deleted.

Usage
=====

`sls function prune`

Options:

`--number number` / `-n number`: keep `number` most recent versions (default: 5)
