'use strict';

var
  Benchmark = require('./benchit'),
  bunyan = require('bunyan'),
  config = require('./config'),
  fs = require('fs'),
  Github = require('github'),
  GHApi = require('./ghapi'),
  httpProxy = require('http-proxy'),
  Jenkins = require('./jenkins'),
  Nightlies = require('./nightlies'),
  path = require('path'),
  PullReq = require('./pullrequests'),
  restify = require('restify'),
  request = require('request'),
  Review = require('./review'),
  sqlite3 = require('sqlite3'),
  url = require('url'),
  util = require('util');

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
  LOGS: [{
    stream: process.stderr,
  }],
}, config);

var log = bunyan.createLogger({
  name: 'jankins',
  streams: config.LOGS,
  serializers: bunyan.stdSerializers,
});

var jenkins = Jenkins({
  hostname: config.JENKINS_HOSTNAME,
  username: config.JENKINS_USER,
  password: config.JENKINS_API_TOKEN,
  port: config.JENKINS_PORT,
  udp: config.UDP,
  interval: config.CHECK_INTERVAL,
  log: log,
});

var server = restify.createServer({
  log: log,
});

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

server.on('after', restify.auditLogger({
  log: log,
}));

server.on('uncaughtException', function (req, res, route, err) {
  log.error(err);
});

server.listen(config.BIND_PORT, config.BIND_IP);

var proxy = new httpProxy.HttpProxy({
  target: {
    host: config.JENKINS_HOSTNAME,
    port: config.JENKINS_PORT,
  },
});

server.on('NotFound', function (req, res, next) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Expose-Headers', 'Link, X-RateLimit-Limit, X-RateLimit-Remaining, X-OAuth-Scopes, X-Accepted-OAuth-Scopes');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, If-Match, If-Modified-Since, If-None-Match, If-Unmodified-Since, X-Requested-With');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE');
  if (req.method === 'OPTIONS') {
    log.info({CORS: true, req: req, res: res});
    res.send(204);
    return next();
  }
  log.info({proxy: true, url: req.path()});
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

  var githubEvent = req.headers['x-github-event'];

  if (payload) {
    process.nextTick(function () {
      log.info({github: payload, headers: req.headers});
      server.emit('github', payload, githubEvent);
    });
  }

  if (githubEvent != 'push') {
    res.send(200);
    return next();
  }

  // this isn't as robust as we want because of redirects?
  //proxy.proxyRequest(req, res);
  var u = url.format({
    protocol: 'http',
    hostname: config.JENKINS_HOSTNAME,
    pathname: req.path(),
    port: config.JENKINS_PORT,
  });
    
  var p = {payload: JSON.stringify(payload)};
  // TODO XXX restify
  request.post({url: u, form: p, followAllRedirects: true}, function () {
    res.send(200);
    return next();
  });
});

server.get(/html\/.*/, restify.serveStatic({
  directory: __dirname,
}));

var db = new sqlite3.Database(config.DB);

db.on('error', function (err) {
  log.error({plugin: 'db', err: err});
});

db.exec(fs.readFileSync('./jankins.sql', 'utf8'));

var github = new Github({ version: '3.0.0', debug: true });
github.authenticate({
  type: 'oauth',
  token: config.GITHUB_AUTH,
});

var ghrest = restify.createJsonClient({
  url: 'https://api.github.com',
  version: '*',
  userAgent: 'github-youre-absurd/9001.0 (Useless)',
  log: log,
});

var opts = {
  server: server,
  db: db,
  config: config,
  jenkins: jenkins,
  github: github,
  ghrest: ghrest,
  log: log,
};

var PR = PullReq(opts);
//var BM = Benchmark(opts);
var NL = Nightlies(opts);
var GHAPI = GHApi(opts);
var RV = Review(opts);
