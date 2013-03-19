'use strict';

var
  Benchmark = require('./benchit'),
  config = require('./config'),
  httpProxy = require('http-proxy'),
  Jenkins = require('./jenkins'),
  PullReq = require('./pullrequests'),
  redis = require('redis'),
  restify = require('restify');

var jenkins = Jenkins({
  hostname: config.JENKINS_HOSTNAME,
  username: config.JENKINS_USER,
  password: config.JENKINS_API_TOKEN,
  port: config.JENKINS_PORT,
  udp: config.UDP,
  interval: config.CHECK_INTERVAL,
});

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

var db = redis.createClient();

var opts = {
  server: server,
  db: db,
  config: config,
  jenkins: jenkins,
};

var PR = PullReq(opts);
//var BM = Benchmark(opts);
