'use strict';

var
  dgram = require('dgram'),
  EE = require('events').EventEmitter,
  restify = require('restify'),
  request = require('request'),
  slide = require('slide'),
  qs = require('querystring'),
  url = require('url'),
  util = require('util');

var Jenkins = module.exports = function (opts) {
  if (!(this instanceof Jenkins)) return new Jenkins(opts);

  EE.call(this);

  this.log = opts.log.child({plugin: 'jenkins'})

  var fmt = {
    protocol: opts.ssl ? 'https' : 'http',
    hostname: opts.hostname,
    username: opts.username,
    password: opts.password,
    port: opts.port,
  };

  if (opts.username)
    fmt.auth = opts.username + ':' + opts.password;

  this.url = url.format(fmt);

  this.state = 'UNKNOWN';

  this.client = restify.createJsonClient({
    url: this.url,
    version: '*',
    log: this.log,
  });

  if (opts.interval) {
    this.interval = Math.max(+opts.interval, 1000);
    this._checkStateInterval = setInterval(this._checkState.bind(this),
      this.interval);
    this._checkState();
  }

  if (opts.udp) {
    opts.udp = opts.udp.split(':').reverse();
    this.udp = dgram.createSocket('udp4');
    this.udp.on('message', this._msg.bind(this));
    var port = +opts.udp[0];
    var host = opts.udp[1];
    this.udp.bind(port, host);
  }

  this.log.info({state: 'initialized', url: this.url});
};
util.inherits(Jenkins, EE);

Jenkins.prototype._msg = function (msg) {
  this._checkState();

  if (!msg) return;

  try {
    msg = JSON.parse(msg.toString('utf8'));
    this.emit('message', msg);
  } catch (e) {
    this.emit('jsonError', e, msg);
  }
};

Jenkins.prototype._api = function (command, parameters, cb) {
  var self = this;

  if (!(command instanceof Array)) command = [command];

  if (!cb) {
    cb = parameters;
    parameters = {};
  }

  if (command.length >= 1 && command[0])
    command.unshift('');

  command = command.concat(['api', 'json'])

  var url = command.join('/');

  url += '?' + qs.stringify(parameters);

  this.log.info({url: url});

  this.client.get(url, function (e, req, res, body) {
    if (e) self.log.error({url: url, err: e});
    self.log.debug({url: url, body: body});
    if (cb) cb(e, res, body);
  });
};

Jenkins.prototype._checkState = function () {
  var self = this;
  this._api('', {tree: 'jobs[name,color]'}, function (e, r, jstate) {
    if (!jstate) return;

    var oldstate = self.state;
    self.state = 'IDLE';

    var active = [];
    var i, job;

    for (i in jstate.jobs) {
      job = jstate.jobs[i];
      if (job.color.match(/_anime$/)) {
        active.push(job.name);
        self.state = 'ACTIVE';
      }
    }

    if (self.state != oldstate)
      self.emit('state', oldstate, active);
  });
};

Jenkins.prototype.quietDown = function (cb) {
  this._api('quietDown', cb);
};

Jenkins.prototype.cancelQuietDown = function (cb) {
  this._api('cancelQueitDown', cb);
};

Jenkins.prototype.queue = function (cb) {
  this._api('queue', cb);
};

Jenkins.prototype.build = function (job, parameters, cb) {
  if (!cb) {
    cb = parameters;
    parameters = undefined;
  }

  var url = '/job/' + job + '/buildWithParameters?' + qs.stringify(parameters);
  this.client.post(url, function (e, req, res, body) {
    //self.log.info({url: url, body: body});
    if (cb) cb(e, res, body);
  });
};

Jenkins.prototype.buildReport = function (job, id, args, cb) {
  var command = [
    'job',
    job,
  ];

  if (!cb) {
    cb = args;
    args = id;
    id = undefined;
  }

  if (!cb) {
    cb = args;
    args = { depth: 10 };
  }

  if (id) {
    command.push(id);
  }

  this._api(command, args, cb);
};

Jenkins.prototype.artifacts = function (job, files, id, cb) {
  this.buildReport(job, id, {depth: 10}, function (e, r, report) {
    var urls = [], i, j, run, artifact;
    for (i in report.runs) {
      run = report.runs[i];
      for (j in run.artifacts) {
        artifact = run.artifacts[j];
        if (artifact.relativePath && files.indexOf(artifact.fileName) > -1) {
          urls.push(run.url + '/artifact/' + artifact.relativePath);
        }
      }
    }

    var results = {};
    var errs = [];
    slide.asyncMap(urls, function (url, cb) {
      // TODO XXX FIXME should be restify
      request.get(url, function (e, r, b) {
        if (e) errs.push(e);
        if (b) results[url] = b;
        cb();
      });
    }, function () {
      cb(errs, results, report);
    });
  });
};

Jenkins.prototype.validUser = function (cb) {
  this._api('me', {}, function (e, r, b) {
    cb(r.statusCode === 200);
  });
};
