'use strict';

var
  Benchmark = require('./benchit'),
  config = require('./config'),
  httpProxy = require('http-proxy'),
  Jenkins = require('./jenkins'),
  PullReq = require('./pullrequests'),
  redis = require('redis'),
  restify = require('restify'),
  request = require('request'),
  url = require('url');

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

  if (payload) server.emit('github', payload);

  console.log('proxy');
  // this isn't as robust as we want because of redirects?
  //proxy.proxyRequest(req, res);
  var u = url.format({
    protocol: 'http',
    hostname: config.JENKINS_HOSTNAME,
    pathname: req.path(),
    port: config.JENKINS_PORT,
  });
    
  payload = {payload: JSON.stringify(payload)};
  console.log(u, payload);
  request.post({url: u, form: payload, followAllRedirects: true}, function () {
    res.send(200);
    return next();
  });
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
