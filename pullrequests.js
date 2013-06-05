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

  this.checkState();

  this.server.on('github', this.github.bind(this));
  this.server.get('/:user/:repo/pull/:id', this.getPR.bind(this));
  this.server.post('/:user/:repo/pull/:id', this.buildPR.bind(this));

  this.jenkins.on('message', this.message.bind(this));

  setInterval(this.checkState.bind(this), 10 * 60 * 1000);

  this.log.info({state: 'initialized', url: this.url});
};

PullReq.prototype.checkState = function () {
  var self = this;
  var qs = {
    depth: 0,
  };
  this.db.each("SELECT url FROM pull_requests WHERE url IS NOT NULL AND status = 'BUILDING'", function (err, row) {
    var url = row.url;
    var uo = u.parse(url);
    self.log.info({url: uo.pathname}, 'query jenkins state');
    self.jenkins._api(uo.pathname, qs, function (e, r, b) {
      if (e) {
        self.log.error(e);
        return;
      }
      self.log.info({url: url, body: b}, 'jenkins state');
      if (b.building === false) {
        self.finished(url);
      }
    });
  });
};

PullReq.prototype.syncLabels = function (pr) {
  var branch = pr.base.ref;

  if (!/^(master|v\d+.\d+)$/.test(branch)) {
    this.log.info({ pullrequest: pr }, 'ignoring pr for nonversion branch');
    return;
  }

  var self = this;

  var user = pr.base.repo.owner.login;
  var repo = pr.base.repo.name;

  var opts = {
    user: user,
    repo: repo,
    number: pr.number,
  };

  self.gh.issues.getRepoIssue(opts, function (err, issue) {
    if (err) {
      self.log.error({pullreq: pr, err: err}, 'failed to get issue for pull request');
      return;
    }

    var labels = {};

    issue.labels.forEach(function (label) {
      labels[label.name] = true;
    });

    if (labels.pr) {
      self.log.info({ pullreq: pr, issue: issue, labels: labels}, 'already tagged');
      return;
    }

    labels.pr = true;
    labels[branch] = true;

    var edit = {
      user: user,
      repo: repo,
      number: pr.number,
      title: pr.title,
      labels: Object.keys(labels),
    };

    self.gh.issues.edit(edit, function (err, ni) {
      if (err) {
        self.log.error({err: err, pullreq: pr, issue: issue, edit: edit}, 'failed to edit issue with new labels');
        return;
      }
      self.log.info({edit: edit}, 'added labels to issue');
    });
  });
};

PullReq.prototype.github = function (payload, evt) {
  var self = this, prpath, base, head;

  if (evt !== 'pull_request') {
    self.log.info({event: evt}, 'pull requests ignoring event');
    return;
  }

  this.syncLabels(payload.pull_request);

  if (payload.pull_request && payload.action === 'synchronize') {
    base = payload.pull_request.base;
    prpath = '/' + base.repo.full_name;
    prpath += '/pull/' + payload.number;

    self.log.info({prpath: prpath}, 'resync');

    self.db.get("SELECT COUNT(*) FROM pull_requests WHERE pr = ?", prpath, function (err, pr) {
      if (err) {
        self.log.error({prpath: prpath, err: err});
        return;
      }

      if (!pr) {
        self.log.info({prpath: prpath}, 'not found');
        return;
      }

      var opts = {
        PR: payload.number,
        PR_PATH: prpath,
        REBASE_BRANCH: base.ref,
      };

      self.log.info({prpath: prpath, opts: opts}, 'already built, scheduling rebuild');

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

    self.db.get('SELECT * FROM whitelist WHERE username = ?', payload.sender.login, function (err, user) {
      if (err) {
        self.log.error({user: payload.sender.login, err: err});
        return;
      }

      if (!user) {
        self.log.info({user: payload.sender.login}, 'not a whitelisted user');
        return;
      }

      var opts = {
        PR: payload.number,
        PR_PATH: prpath,
        REBASE_BRANCH: base.ref,
      };

      self.log.info({prpath: prpath, user: user.username, opts: opts}, 'initiated build');

      self.triggerBuild(self.jenkins, base.repo.name, prpath, 'Nodejs-Jenkins', opts, function (err, pr) {
        self.log.info({prpath: prpath}, 'scheduled build');
      });
    });

    var url = payload.pull_request.url + '/commits';

    this.log.info({url: url}, 'checking commits for value');
    this.ghrest.get(u.parse(url).pathname, function (e, req, res, b) {
      if (e) {
        self.log.error({err: e, req: req, res: res, body: b});
        return;
      }

      var
        invalidCommits = [],
        emails = {};

      self.log.info({url: url, commits: b});

      b.forEach(function (commit) {
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
          mdwn.push('You can fix all these things *without* opening another issue.');
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
  self.db.get("SELECT * FROM pull_requests WHERE pr = ? ORDER BY buildNumber DESC LIMIT 1",
    req.path(), function (err, pr) {

    if (err) return next(err);

    if (!pr) {
      pr = {
        status: 'UNKNOWN',
      };
    }

    if (pr.results)
      pr.result = JSON.parse(pr.results);

    res.json(200, pr);
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

  var pr = {};

  pr.status = 'BUILDING';
  pr.started = Date.now();
  pr.by = user;

  var jurl = b.url + b.nextBuildNumber + '/';

  pr.lastBuild = b.nextBuildNumber;
  pr.url = jurl;

  self.log.info({prpath: prpath, url: jurl}, 'now interested');

  var cmd = "INSERT INTO pull_requests (pr, url, started_by, status, buildNumber) ";
  cmd += "VALUES (?, ?, ?, ?, ?)";

  var params = [prpath, jurl, user, 'BUILDING', b.nextBuildNumber];

  self.db.run(cmd, params, function (err, result) {
    if (err) return next(err);
    return next(null, pr);
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
    log: self.log,
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
  this.log.info({repo: repo, path: path, user: user, opts: opts}, 'build started');
  jenkins.build(repo + '-pullrequest', opts, this.buildStarted.bind(this, path, user, next));
};

PullReq.prototype.finished = function (jurl) {
  var self = this;

  var qs = {
    depth: 2,
  }

  var oj = u.parse(jurl).pathname;
  self.log.info({action: 'finished', url: jurl, path: oj}, 'finished');

  self.jenkins._api(oj, qs, function (e, r, build) {
    self.log.info({url: oj, body: build, err: e});
    if (!build || e) {
      self.log.info({err: e, url: jurl, res: r});
      return;
    }

    var params = {};

    var user;

    build.actions = build.actions || [];

    build.actions.forEach(function (action) {
      if (action.parameters) {
        action.parameters.forEach(function (parameter) {
          params[parameter.name] = parameter.value;
        });
      }

      if (action.causes)
        user = action.causes[0].userId;
    });

    self.log.info({action: 'finished', params: params, url: jurl});

    if (!params.PR_PATH) return;

    var interested = params.PR_PATH;

    self.db.get("DELETE FROM pull_requests WHERE url = ?", [jurl], function (err, pr) {
      if (err) {
        self.log.error({prpath: interested, err: err});
        return;
      }

      if (!pr)
        pr = {};

      pr.pr = interested;
      pr.buildNumber = build.number;
      pr.user = user;
      pr.created = new Date(build.timestamp);

      self.log.info({action: 'finished', url: jurl, params: params, pr: pr});

      var urls = [];
      build.runs.forEach(function (run) {
        if (run.number != build.number) return;

        run.artifacts.forEach(function (artifact) {
          if (artifact.fileName.match(/\.tap$/i)) {
            urls.push(run.url + 'artifact/' + artifact.relativePath);
          }
        });
      });

      self.log.info({params: params, urls: urls}, 'get artifacts');
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

        self.log.info({url: url}, 'downloading artifact');

        request.get(url).pipe(testresults).once('end', function () {
          self.log.info({url: url, test: testresults.results.list}, 'parsing test result');
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

        self.log.info({prpath: pr.pr, results: results}, 'finished with results');

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

        var sql = '';
        sql += "INSERT INTO pull_requests(pr, url, buildNumber, started_by, status, results, created) ";
        sql += "VALUES (?, ?, ?, ?, ?, ?, ?)";

        var params = [
          pr.pr,
          pr.url,
          pr.buildNumber,
          pr.user,
          pr.status,
          JSON.stringify(pr.result),
          pr.created,
        ];

        self.db.run(sql, params, function (err, res) {
          if (err) {
            self.log.error({sql: sql, err: err});
            return;
          }
          // TODO trigger any websockets?
        });
      });
    });
  });
};

PullReq.prototype.message = function (msg) {
  if (msg.build && msg.build.phase == 'FINISHED') {
    this.finished(msg.build.full_url);
  }
};
