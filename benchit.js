'use strict';

var
  exec = require('child_process').exec,
  slide = require('slide'),
  spawn = require('child_process').spawn;

var BenchIT = module.exports = function (opts) {
  if (!(this instanceof BenchIT)) return new BenchIT(opts);

  this.jenkins = opts.jenkins;
  this.server = opts.server;
  this.config = opts.config;
  this.db = opts.db;

  this.idle = undefined;
  this.lastCommit = undefined;
  this.commits = [];

  this.buildHistory();

  this.jenkins.on('state', this.transition.bind(this));
};

BenchIT.prototype.checkState = function (oldstate, active) {
  var self = this;

  var bold = this.state;
  this.state = this.jenkins.state;

  if (this.jenkins.state == 'ACTIVE') {
    active.forEach(function (job) {
      if (job.match(/benchmark$/))
        self.state = 'BENCHMARK';
    });
  }

  if (self.state != bold)
    self.transition(bold);
};

BenchIT.prototype.clearIdle = function () {
  if (this.idle) {
    clearTimeout(this.idle);
    this.idle = undefined;
  }
};

BenchIT.prototype.transition = function (oldstate) {
  var self = this;
  switch (this.state) {
    case 'IDLE':
      if (oldstate == 'BENCHMARK') {
        // should this come from a message instead?
        this.reportResults();
        this.jenkns.queue(function (e, r, queue) {
          self.jenkins.cancelQuietDown(function (e, r, body) {
            if (!queue.items.length)
              self.nextCommit();
          });
        });
      } else {
        this.idle = setTimeout(this.nextCommit.bind(this), BUILD_QUIET_TIME);
      }
      break;
    case 'ACTIVE':
      this.clearIdle();
      break;
    case 'BENCHMARK':
      this.clearIdle();
      if (oldstate == 'IDLE')
        this.quietDown();
      break;
  };
};

// TODO periodically rebuild history?
BenchIT.prototype.buildHistory = function (cb) {
  var self = this;

  self.db.get('bench/lastCommit', function (err, commit) {
    self.lastCommit = commit;
    slide.chain([
      [exec, 'git --git-dir=' + self.config.REPO_PATH + '.git pull'],
      [exec, 'git --git-dir=' + self.config.REPO_PATH + '.git log --pretty=oneline v0.9.2..HEAD'],
    ], function (err, stdouts, stderrs) {
      self.commits = [];
      stdouts[1].split('\n').forEach(function (line) {
        var commit = line.split(' ')[0];
        if (commit) self.commits.push(commit);
      });
      if (self.lastCommit) {
        var idx = self.commits.indexOf(self.lastCommit);
        if (idx >= 0)
          self.commits = self.commits.slice(0, idx);
      }
    });
  });
};

BenchIT.prototype.nextCommit = function () {
  this.lastCommit = this.commits.pop();
  slide.chain([
    [self.db.set, 'bench/lastCommit', self.lastCommit],
    [self.jenkins.build, {GIT_COMMIT:self.lastCommit}],
  ], function () {
  });
};

BenchIT.prototype.reportResults = function () {
  var self = this;
  self.jenkins.buildReport('nodejs-benchmark', function (e, r, build) {
    var commit;

    build.actions = build.actions || [];
    build.actions.forEach(function (action) {
      var i;
      if (action.parameters)
        for (i in action.parameters)
          if (action.parameters[i].name === 'GIT_COMMIT')
            commit = action.parameters[i].value;
    });

    self.jenkins.artifacts('nodejs-benchmark', ['bench.out'], --build.nextBuildNumber, function (errs, files) {
      var result = {
        commit: commit,
        results: [],
      };

      Object.keys(files).forEach(function (url) {
        var file = files[url];

        var platform = url.match(/label=(\w+)/)[1];
        var arch = url.match(/DESTCPU=(\w+)/)[1];

        var benchs = {
          platform: platform,
        };

        file.split(/\r?\n/).forEach(function (line) {
          if (!line) return;
          line = line.split(':');
          var name = line[0].trim();
          var bench = benchs[name] = benchs[name] || [];
          bench.push(+line[1].trim());
        });

        result.results.push(benchs);
      });

      self.db.set('bench/' + commit, JSON.stringify(result));
    });
  });
};
