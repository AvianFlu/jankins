'use strict';

var Jenkins = require('./jenkins');

var PullReq = module.exports = function (opts) {
  if (!(this instanceof PullReq)) return new PullReq(opts);
  this.server = opts.server;
  this.db = opts.db;
  this.config = opts.config;
  this.jenkins = opts.jenkins;

  this.interest;

  var self = this;

  self.db.get('pullrequest-interest', function (err, obj) {
    self.interest = obj ? JSON.parse(obj) : {};
  });

  this.server.post('/github', this.github.bind(this));
  this.server.get('/:user/:repo/pull/:id', this.getPR.bind(this));
  this.server.post('/:user/:repo/pull/:id', this.buildPR.bind(this));

  this.jenkins.on('message', this.message.bind(this));
};

PullReq.prototype.github = function (req, res, next) {
  var payload;

  if (req.params.payload) {
    try {
      payload = JSON.parse(req.params.payload)
    } catch (e) {
    }
  } else {
    payload = req.params;
  }

  //TODO

  console.log(payload);

  res.send(200);
  return next();
};

PullReq.prototype.getPR = function (req, res, next) {
  var self = this;
  self.db.get(req.path(), function (err, obj) {
    if (err) return next(err);

    if (!obj) {
      obj = {
        status: 'UNKNOWN',
      };
    } else {
      obj = JSON.parse(obj);
    }

    res.json(200, obj);
    return next();
  });
};

PullReq.prototype.buildPR = function (req, res, next) {
  var self = this;

  if (!req.query.JENKINS_USERNAME || !req.query.JENKINS_API_TOKEN)
    return next(new Error('You must supply a Jenkins username and api key'));

  var jenkins = Jenkins({
    hostname: self.config.JENKINS_HOSTNAME,
    username: req.query.JENKINS_USERNAME,
    password: req.query.JENKINS_API_TOKEN,
  });

  jenkins.build(req.params.repo + '-pullrequest', {PR:req.params.id}, function (e, r, b) {
    if (e) return next(e);
    if (r.statusCode != 200) return next(new Error('Jenkins status code ' + r.statusCode));

    self.db.get(req.path(), function (err, pr) {
      if (err) return next(err);

      if (pr) pr = JSON.parse(pr);
      else pr = {};

      pr.status = 'BUILDING';
      pr.started = Date.now();
      pr.by = req.query.JENKINS_USERNAME;

      var jurl = b.url + b.nextBuildNumber + '/';

      pr.lastBuild = b.nextBuildNumber;
      pr.url = jurl;

      self.interest[jurl] = req.path();

      self.db.set('pullrequest-interest', JSON.stringify(self.interest), function (err, rres) {
        // TODO cancel interest?
        if (err) return next(err);

        self.db.set(req.path(), JSON.stringify(pr), function (err, rres) {
          // TODO cancel interest?
          if (err) return next(err);

          res.json(200, pr);
          return next();
        });
      });
    });
  });
};

PullReq.prototype.message = function (msg) {
  var self = this;

  if (msg.build && msg.build.phase == 'FINISHED') {
    var interested = self.interest[msg.build.full_url];
    if (!interested) return;

    delete self.interest[msg.build.full_url];
    self.db.set('pullrequest-interest', JSON.stringify(self.interest));

    self.db.get(interested, function (err, pr) {
      if (!pr) return;

      pr = JSON.parse(pr);

      // TODO what if they have multiple test plans?
      self.jenkins.artifacts(msg.name, ['test.tap'], msg.build.number, function (errs, results, report) {
        var i, platform, arch, result, key, file;
        // TODO store multiple results
        result = pr.result = pr.result || {};

        for (i in results) {
          if (!i) return;

          // TODO don't make this so job specific
          platform = i.match(/label=(\w+)/);
          platform = platform ? platform[1] : '';
          arch = i.match(/DESTCPU=(\w+)/);
          arch = arch ? arch[1] : '';

          key = platform;
          if (arch) key += '-' + arch;

          result[key] = [];

          file = results[i];

          file.split(/\n/).forEach(function (line) {
            if (!line || !line.trim() || line.match(/^(ok|1|#|Tap)/i)) return;

            var match = line.match(/^not ok (\d+) - (.*)/);

            if (match) {
              result[key].push({
                url: i,
                number: +match[1],
                desc: match[2]
              });
            }
          });
        }

        pr.status = msg.build.status;
        pr.url = msg.build.full_url;

        self.db.set(interested, JSON.stringify(pr), function (err, res) {
          // TODO trigger any websockets?
        });
      });
    });
  }
};
