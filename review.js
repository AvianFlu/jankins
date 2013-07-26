'use strict';

var Review = module.exports = function (opts) {
  if (!(this instanceof Review)) return new Review(opts);

  this.log = opts.log.child({plugin: 'review'});
  this.config = opts;
  this.jenkins = opts.jenkins;

  opts.server.on('github', this.github.bind(this));
};

Review.prototype.github = function (payload, evt) {
  if (evt !== 'push') return;

  if (!payload || !payload.ref) {
    this.log.info({payload: payload}, 'Not a valid Push Event');
    return;
  }

  if (payload.repository.owner.name !== 'joyent') {
    this.log.info({payload: payload}, 'Invalid repository owner');
    return;
  }

  if (!/(node|libuv)/.test(payload.repository.name)) {
    this.log.info({payload: payload}, 'Invalid repository name');
    return;
  }

  if (/\/(master|v\d+\.\d+)$/.test(payload.ref)) {
    this.log.info({payload: payload}, 'Invalid branch to build');
    return;
  }

  var self = this;
  var opts = {GIT_BRANCH: payload.ref.replace('refs/heads/', '')};
  var name = payload.repository.name + '-review';

  this.log.info({opts: opts, jobName: name}, 'triggering random branch build');

  this.jenkins.build(name, opts, function (e, r, b) {
    if (e) self.log.error(e);
    else self.log.info({opts: opts}, 'triggered random branch build');
  })
};
