'use strict';

var
  CLA = require('./cla'),
  Jenkins = require('./jenkins'),
  request = require('request'),
  slide = require('slide'),
  tap = require('tap'),
  u = require('url'),
  util = require('util');

var PullReq = module.exports = function (opts) {
  if (!(this instanceof PullReq)) return new PullReq(opts);

  this.log = opts.log.child({plugin: 'pullrequests'});

  this.cla = new CLA(opts);

  this.server = opts.server;
  this.db = opts.db;
  this.config = opts.config;
  this.jenkins = opts.jenkins;
  this.gh = opts.github;
  this.ghrest = opts.ghrest;

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

  this.log.info({state: 'initialized', url: this.url});
};

PullReq.prototype.checkState = function () {
  var self = this;
  var urls = Object.keys(this.interest);
  var qs = {
    depth: 0,
  };
  slide.asyncMap(urls, function (url, cb) {
    var uo = u.parse(url + '/api/json');
    uo.host = null;
    uo.port = self.config.JENKINS_PORT.toString();
    uo.pathname = uo.pathname.replace(/\/\//g, '/');
    uo = u.format(uo);
    // TODO XXX FIXME use jenkins library
    request.get({url: uo, qs: qs, json: true}, function (e, r, b) {
      if (e) {
        self.log.info(e);
        return cb();
      }
      if (b.building === false) {
        self.finished(url);
        cb();
      }
    });
  }, function () {});
};

PullReq.prototype.github = function (payload) {
  var self = this, prpath, base, head;

  if (payload.pull_request && payload.action === 'synchronize') {
    base = payload.pull_request.base;
    prpath = '/' + base.repo.full_name;
    prpath += '/pull/' + payload.number;

    self.log.info({prpath: prpath}, 'resync');

    self.db.get(prpath, function (err, pr) {
      if (err || !pr) return;

      var opts = {
        PR: payload.number,
        PR_PATH: prpath,
        REBASE_BRANCH: base.ref,
      };

      self.triggerBuild(self.jenkins, base.repo.name, prpath, 'Nodejs-Jenkins', opts, function (err, pr) {
        self.log.info({prpath: prpath}, 'scheduled build');
      });
    });
  }

  if (payload.pull_request && payload.action === 'opened') {
    base = payload.pull_request.base;
    head = payload.pull_request.head;

    prpath = '/' + base.repo.full_name;
    prpath += '/pull/' + payload.number;

    self.log.info({prpath: prpath}, 'opened');

    // TODO this should come from db
    if (self.config.WHITELIST[payload.sender.login]) {
      self.log.info({prpath: prpath}, 'initiated build');
      var opts = {
        PR: payload.number,
        PR_PATH: prpath,
        REBASE_BRANCH: base.ref,
      };
      self.triggerBuild(self.jenkins, base.repo.name, prpath, 'Nodejs-Jenkins', opts, function (err, pr) {
        self.log.info({prpath: prpath}, 'scheduled build');
      });
    }

    // TODO there's probably a saner way to do this, like prpath/commits
    var url = head.repo.compare_url
      .replace(/{base}/, base.sha)
      .replace(/{head}/, head.sha);

    // TODO XXX FIXME restify
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

PullReq.prototype.setStatus = function (prpath, state, desc, target_url) {
  var self = this;
  var url = '/repos' + prpath.replace('pull', 'pulls') + '/commits';
  this.ghrest.get(url, function (e, jreq, r, b) {
    if (!b.length) return;

    var parts = prpath.split('/');

    var user = parts[1];
    var repo = parts[2];

    b.forEach(function (commit) {
      var obj = {
        user: user,
        repo: repo,
        sha: commit.sha,
        state: state,
        description: desc,
        target_url: target_url,
      };
      self.gh.statuses.create(obj);
    });
  });
};

PullReq.prototype.buildStarted = function (prpath, user, next, e, r, b) {
  var self = this;

  if (e) return next(e);
  if (r.statusCode != 200) return next(new Error('Jenkins status code ' + r.statusCode));

  self.setStatus(prpath, 'pending');

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

  function go() {
    self.triggerBuild(jenkins, req.params.repo, req.path(), user, opts, started);
  }

  if (!opts.REBASE_BRANCH) {
    this.ghrest.get('/repos' + req.path().replace('pull', 'pulls'), function (e, jreq, r, b) {
      if (b && b.base) opts.REBASE_BRANCH = b.base.ref;
      go();
    });
  } else {
    go();
  }
};

PullReq.prototype.triggerBuild = function (jenkins, repo, path, user, opts, next) {
  jenkins.build(repo + '-pullrequest', opts, this.buildStarted.bind(this, path, user, next));
};

PullReq.prototype.finished = function (jurl) {
  var self = this;

  var qs = {
    depth: 2,
  }

  self.log.info('finished', jurl);

  // TODO XXX FIXME jenkins restify client
  request.get({url: jurl + '/api/json', qs: qs, json: true}, function (e, r, build) {
    if (!build || e) {
      self.log.info({err: e, url: jurl, res: r});
      return;
    }

    var params = {};

    build.actions.forEach(function (action) {
      if (!action.parameters) return;
      action.parameters.forEach(function (parameter) {
        params[parameter.name] = parameter.value;
      });
    });

    self.log.info({action: 'finished', params: params, url: jurl});

    if (!params.PR_PATH) return;

    var interested = params.PR_PATH;

    self.db.get(interested, function (err, pr) {
      if (!pr) {
        pr = {};
      } else {
        pr = JSON.parse(pr);
      }

      if (pr.lastBuild > build.number) {
        self.log.info({action: 'dropped', pr: pr, url: url, build: build})
        delete self.interest[jurl];
        self.db.set('pullrequest-interest', JSON.stringify(self.interest));
        return;
      } else {
        self.log.info({action: 'finished', url: url, params: params, pr: pr});
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

        var state;

        switch (build.result) {
          case 'SUCCESS':
            state = 'success';
            break;
          case 'UNSTABLE':
            state = 'error';
            break;
          default:
            state = 'failure';
            break;
        };

        var msg = [];

        Object.keys(results).forEach(function (k) {
          if (results[k].length)
            msg.push(k + ': ' + results[k].length);
        });

        if (msg.length)
          msg = 'Failing tests -- ' + msg.join(', ');
        else
          msg = undefined;

        self.setStatus(interested, state, msg, jurl);

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
