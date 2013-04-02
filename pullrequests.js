'use strict';

var
  CLA = require('./cla'),
  Jenkins = require('./jenkins'),
  request = require('request'),
  slide = require('slide'),
  tap = require('tap'),
  util = require('util');

var PullReq = module.exports = function (opts) {
  if (!(this instanceof PullReq)) return new PullReq(opts);

  this.cla = new CLA(opts);

  this.server = opts.server;
  this.db = opts.db;
  this.config = opts.config;
  this.jenkins = opts.jenkins;
  this.gh = opts.github;

  this.interest;

  var self = this;

  self.db.get('pullrequest-interest', function (err, obj) {
    self.interest = obj ? JSON.parse(obj) : {};
    self.checkState();
  });

  this.server.on('github', this.github.bind(this));
  this.server.get('/:user/:repo/pull/:id', this.getPR.bind(this));
  this.server.post('/:user/:repo/pull/:id', this.buildPR.bind(this));

  this.jenkins.on('message', this.message.bind(this));

  setInterval(this.checkState.bind(this), 10 * 60 * 1000);
};

PullReq.prototype.checkState = function () {
  var self = this;
  var urls = Object.keys(this.interest);
  var qs = {
    depth: 0,
  };
  slide.asyncMap(urls, function (url, cb) {
    request.get({url: url + '/api/json', qs: qs, json: true}, function (e, r, b) {
      if (e) {
        console.log(e);
        return cb();
      }
      if (b.building === false) {
        self.finished(url);
        //console.log(b);
        cb();
      }
    });
  }, function () {});
};

PullReq.prototype.github = function (payload) {
  var self = this, prpath, base, head;

  if (payload.pull_request && payload.action === 'opened') {
    base = payload.pull_request.base;
    head = payload.pull_request.head;

    prpath = '/' + base.repo.full_name;
    prpath += '/pull/' + payload.number;

    console.log('pull req ' + prpath + ' ' + payload.action);

    if (self.config.WHITELIST[payload.sender.login]) {
      console.log('initiating build for', prpath, payload.sender.login);
      var opts = {
        PR: payload.number,
        PR_PATH: prpath,
        REBASE_BRANCH: base.ref,
      };
      self.jenkins.build(base.repo.name + '-pullrequest', opts,
        self.buildStarted.bind(self, prpath, 'Nodejs-Jenkins', function (err, pr){
          console.log('scheduled ' + prpath);
        })
      );
    }

    var url = head.repo.compare_url
      .replace(/{base}/, base.sha)
      .replace(/{head}/, head.sha);

    request.get({url: url, json: true}, function (e, r, b) {
      var
        invalidCommits = [],
        emails = {};

      b.commits.forEach(function (commit) {
        var errors = [];

        var messageLines = commit.commit.message.split(/\n/);

        messageLines.forEach(function (line, idx) {
          if (idx === 0) {
            if (line.length > 50)
              errors.push('First line of commit message must be no longer than 50 characters');

            if (line.indexOf(':') < 1)
              errors.push('Commit message must indicate the subsystem this commit changes');
          } else if (idx === 1 && line.length > 0) {
            errors.push('Second line of commit must always be empty');
          } else if (idx > 1 && line.length > 72) {
            errors.push('Commit message line too long: ' + idx);
          }
        });

        emails[commit.commit.author.email] = commit.commit.author.name;

        if (errors.length) {
          commit.errors = errors;
          invalidCommits.push(commit);
        }
      });

      self.cla.emails(Object.keys(emails), function (b) {
        b = b || [];

        var found = {};
        b.forEach(function (c) {
          found[c['gsx$e-mail']['$t']] = true;
        });

        var clas = [];

        Object.keys(emails).forEach(function (e) {
          if (!found[e]) clas.push(emails[e]);
        });

        var mdwn = [];

        invalidCommits.forEach(function (commit) {
          var repo = payload.pull_request.head.repo.full_name;
          var sha = commit.sha;
          mdwn.push('');
          mdwn.push('Commit '+ repo + '@' + sha +' has the following error(s):');
          mdwn.push('');
          commit.errors.forEach(function (error) {
            mdwn.push(' * ' + error);
          });
        });

        if (clas.length) {
          mdwn.push('');
          mdwn.push('The following commiters were not found in the CLA:');
          mdwn.push('');
          clas.forEach(function (email) {
            mdwn.push(' * ' + email);
          });
        }

        if (mdwn.length) {
          mdwn = ['Thank you for contributing this pull request!'
            + ' Here are a few pointers to make sure your submission'
            + ' will be considered for inclusion.'].concat(mdwn);

          mdwn.push('');
          mdwn.push('Please see [CONTRIBUTING.md](https://github.com/joyent/node/blob/master/CONTRIBUTING.md) for more information');

          var r = {
            number: payload.number,
            repo: payload.pull_request.base.repo.name,
            user: payload.pull_request.base.user.login,
            body: mdwn.join('\n'),
          };

          self.gh.issues.createComment(r, function (err, res) {
          });
        }
      });
    });
  }
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

PullReq.prototype.buildStarted = function (prpath, user, next, e, r, b) {
  var self = this;

  if (e) return next(e);
  if (r.statusCode != 200) return next(new Error('Jenkins status code ' + r.statusCode));

  self.db.get(prpath, function (err, pr) {
    if (err) return next(err);

    if (pr) pr = JSON.parse(pr);
    else pr = {};

    pr.status = 'BUILDING';
    pr.started = Date.now();
    pr.by = user;

    var jurl = b.url + b.nextBuildNumber + '/';

    pr.lastBuild = b.nextBuildNumber;
    pr.url = jurl;

    self.interest[jurl] = prpath;

    self.db.set('pullrequest-interest', JSON.stringify(self.interest), function (err, rres) {
      // TODO cancel interest?
      if (err) return next(err);

      self.db.set(prpath, JSON.stringify(pr), function (err, rres) {
        // TODO cancel interest?
        if (err) return next(err);

        return next(null, pr);
      });
    });
  });
};

PullReq.prototype.buildPR = function (req, res, next) {
  var self = this;

  if (!req.query.JENKINS_USERNAME || !req.query.JENKINS_API_TOKEN)
    return next(new Error('You must supply a Jenkins username and api key'));

  var jenkins = Jenkins({
    hostname: self.config.JENKINS_HOSTNAME,
    port: self.config.JENKINS_PORT,
    username: req.query.JENKINS_USERNAME,
    password: req.query.JENKINS_API_TOKEN,
  });

  var opts = util._extend({
    PR: req.params.id,
    PR_PATH: req.path(),
  }, req.query);

  function started(err, pr) {
    if (err)
      return next(err);

    res.send(200, pr);
  }

  var user = req.query.JENKINS_USERNAME;

  jenkins.build(req.params.repo + '-pullrequest', opts, self.buildStarted.bind(self, req.path(), user, started));
};

PullReq.prototype.finished = function (jurl) {
  var self = this;

  var qs = {
    depth: 2,
  }

  console.log('finished', jurl);

  request.get({url: jurl + '/api/json', qs: qs, json: true}, function (e, r, build) {
    if (!build || e) {
      console.log(e);
      console.log(r);
      return;
    }

    var params = {};

    build.actions.forEach(function (action) {
      if (!action.parameters) return;
      action.parameters.forEach(function (parameter) {
        params[parameter.name] = parameter.value;
      });
    });

    console.log(params);
    if (!params.PR_PATH) return;

    var interested = params.PR_PATH;

    self.db.get(interested, function (err, pr) {
      if (!pr) {
        pr = {};
      } else {
        pr = JSON.parse(pr);
      }

      if (pr.lastBuild > build.number) {
        console.log('historical build, dropped', jurl, build.number);
        return;
      } else {
        console.log('finished', jurl, pr);
      }

      var urls = [];
      build.runs.forEach(function (run) {
        if (run.number != build.number) return;

        run.artifacts.forEach(function (artifact) {
          if (artifact.fileName.match(/\.tap$/i)) {
            urls.push(run.url + 'artifact/' + artifact.relativePath);
          }
        });
      });

      var results = {};
      slide.asyncMap(urls, function (url, cb) {
        var platform, arch, key, testresults;

        platform = url.match(/label=(\w+)/);
        platform = platform ? platform[1] : '';
        arch = url.match(/DESTCPU=(\w+)/);
        arch = arch ? arch[1] : '';

        key = platform;
        if (arch) key += '-' + arch;

        testresults = tap.createConsumer();
        results[key] = [];

        request.get(url).pipe(testresults).once('end', function () {
          testresults.results.list.forEach(function (test) {
            if (!test.ok) {
              results[key].push({
                url: url,
                number: test.id,
                desc: test.name,
              });
            }
          });

          cb();
        });
      }, function () {
        pr.status = build.result;
        pr.url = jurl;
        pr.result = results;

        self.db.set(interested, JSON.stringify(pr), function (err, res) {
          // TODO trigger any websockets?
        });

        delete self.interest[jurl];
        self.db.set('pullrequest-interest', JSON.stringify(self.interest));
      });
    });
  });
};

PullReq.prototype.message = function (msg) {
  if (msg.build && msg.build.phase == 'FINISHED') {
    this.finished(msg.build.full_url);
  }
};
