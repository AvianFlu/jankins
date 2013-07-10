var path = require('path');
var spawn = require('child_process').spawn;
var slide = require('slide');

var RepoCache = module.exports = function (options) {
  if (!(this instanceof RepoCache)) return new RepoCache(options);

  this.log = options.log.child({plugin: 'RepoCache'});
  options.server.on('github', this.github.bind(this));
};

RepoCache.prototype.github = function (payload, evt) {
  if (evt !== 'push') return;

  if (!payload || !payload.ref) {
    this.log.info({payload: payload}, 'invalid push event');
    return;
  }

  if (payload.repository.owner.name !== 'joyent') {
    this.log.info({payload: payload}, 'invalid repository owner')
    return;
  }

  var m = payload.repository.name.match(/(node|libuv)$/);

  if (!m) {
    this.log.info({payload: payload}, 'Invalid repository name');
    return;
  }

  var name = m[1];

  var gitdir = path.join(__dirname, 'html', name + '.git');

  var self = this;

  slide.chain([
    [s, this.log, 'git', ['--git-dir='+gitdir, 'remote', 'update']],
    [s, this.log, 'git', ['--git-dir='+gitdir, 'update-server-info']],
  ], function () {
    self.log.info({repo: name}, 'repo updated');
  });
};

function s(log, cmd, args, next) {
  log.info({cmd: cmd, args: args}, 'repocache starting');
  var self = this;
  child = spawn(cmd, args, {stdio: 'ignore'});
  child.on('exit', function(code) {
    if (code !== 0) {
      log.error({cmd: cmd, args: args, code: code}, 'failed');
      return;
    }
    next();
  });
};
