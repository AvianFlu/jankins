'use strict';

var
  Benchmark = require('./benchit'),
  bunyan = require('bunyan'),
  config = require('./config'),
  Github = require('github'),
  httpProxy = require('http-proxy'),
  Jenkins = require('./jenkins'),
  Nightlies = require('./nightlies'),
  path = require('path'),
  PullReq = require('./pullrequests'),
  redis = require('redis'),
  restify = require('restify'),
  request = require('request'),
  url = require('url'),
  util = require('util');

var jenkins = Jenkins({
  hostname: config.JENKINS_HOSTNAME,
  username: config.JENKINS_USER,
  password: config.JENKINS_API_TOKEN,
  port: config.JENKINS_PORT,
  udp: config.UDP,
  interval: config.CHECK_INTERVAL,
});

config = util._extend({
  JENKINS_USER: undefined,
  JENKINS_API_TOKEN: undefined,
  JENKINS_HOSTNAME: undefined,
  JENKINS_PORT: undefined,
  REPO_PATH: undefined,
  UDP: undefined,
  CHECK_INTERVAL: undefined,
  BIND_PORT: undefined,
  BIND_IP: undefined,
  GOOGLE_USERNAME: undefined,
  GOOGLE_PASSWORD: undefined,
  CLA_KEY: undefined,
  GITHUB_AUTH: undefined,
  WHITELIST: {},
  DB_PREFIX: '',
}, config);

var server = restify.createServer();

server
.use(restify.acceptParser(server.acceptable))
//.use(restify.authorizationParser())
.use(restify.dateParser())
.use(restify.queryParser())
//.use(restify.jsonp())
.use(restify.gzipResponse())
.use(restify.bodyParser())
//.use(restify.conditionalRequest())
;

/*
server.on('after', restify.auditLogger({
  log: bunyan.createLogger({
    name: 'audit',
    stream: process.stdout
  })
}));
//*/

server.listen(config.BIND_PORT, config.BIND_IP);

var proxy = new httpProxy.HttpProxy({
  target: {
    host: config.JENKINS_HOSTNAME,
    port: config.JENKINS_PORT,
  },
});

server.on('NotFound', function (req, res, next) {
  proxy.proxyRequest(req, res);
});

server.post(/\/github-webhook\/?/, function (req, res, next) {
  var payload;

  if (req.params.payload) {
    try {
      payload = JSON.parse(req.params.payload)
    } catch (e) {
    }
  } else {
    payload = req.params;
  }

  if (payload) {
    process.nextTick(function () {
      server.emit('github', payload);
    });
  }

  // this isn't as robust as we want because of redirects?
  //proxy.proxyRequest(req, res);
  var u = url.format({
    protocol: 'http',
    hostname: config.JENKINS_HOSTNAME,
    pathname: req.path(),
    port: config.JENKINS_PORT,
  });
    
  payload = {payload: JSON.stringify(payload)};
  request.post({url: u, form: payload, followAllRedirects: true}, function () {
    res.send(200);
    return next();
  });
});

server.get(/html\/.*/, restify.serveStatic({
  directory: __dirname,
}));

var db = redis.createClient();

var _set = db.set;
db.set = function (key, obj, cb) {
  return _set.call(this, config.DB_PREFIX+key, obj, cb);
};

var _get = db.get;
db.get = function (key, cb) {
  return _get.call(this, config.DB_PREFIX+key, cb);
};

var github = new Github({ version: '3.0.0', debug: true });
github.authenticate({
  type: 'oauth',
  token: config.GITHUB_AUTH,
});

var opts = {
  server: server,
  db: db,
  config: config,
  jenkins: jenkins,
  github: github,
};

var PR = PullReq(opts);
//var BM = Benchmark(opts);
var NL = Nightlies(opts);
