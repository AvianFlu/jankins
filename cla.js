var GoogleClientLogin = require("googleclientlogin").GoogleClientLogin;
var Jenkins = require('./jenkins');
var restify = require('restify');
var qs = require('querystring');

var CLA = module.exports = function (opts) {
  if (!(this instanceof CLA)) return new CLA(opts);
  this.config = opts.config;

  this.log = opts.log.child({plugin: 'cla'});

  var self = this;

  function validUser (req, res, next, cb) {
    if (!req.query.JENKINS_USERNAME || !req.query.JENKINS_API_TOKEN)
      return next(new Error('You must supply a Jenkins username and api key'));

    var jenkins = new Jenkins({
      hostname: self.config.JENKINS_HOSTNAME,
      port: self.config.JENKINS_PORT,
      username: req.query.JENKINS_USERNAME,
      password: req.query.JENKINS_API_TOKEN,
      log: self.log,
    });

    jenkins.validUser(function (valid) {
      if (!valid) return next(new Error('You must supply valid Jenkins credentials'));
      cb();
    });
  }

  opts.server.get('/cla/email/:email', function (req, res, next) {
    validUser(req, res, next, function () {
      self.email(req.params.email, function (entry) {
        res.json(200, entry);
        return next();
      });
    });
  });

  opts.server.get('/cla/fullname/:fullname', function (req, res, next) {
    validUser(req, res, next, function () {
      self.fullname(req.params.fullname, function (entry) {
        res.json(200, entry || {});
        return next();
      });
    });
  });

  opts.server.get('/cla/either/:fullname/:email', function (req, res, next) {
    validUser(req, res, next, function () {
      self.full_or_email(req.params.fullname, req.params.email, function (entry) {
        res.json(200, entry || {});
        return next();
      });
    });
  });
  this.log.info({state: 'initialized', url: this.url});
};

CLA.prototype.login = function (cb) {
  var self = this;

  // TODO cache login info
  var googleAuth = new GoogleClientLogin({
    email: this.config.GOOGLE_USERNAME,
    password: this.config.GOOGLE_PASSWORD,
    service: 'spreadsheets',
    accountType: GoogleClientLogin.accountTypes.google
  });

  googleAuth.on(GoogleClientLogin.events.login, function(){
    self.auth = googleAuth.getAuthId();
    var url = 'https://spreadsheets.google.com';

    var reqopts = {
      url: url,
      headers: {
        Authorization: 'GoogleLogin auth='+ self.auth,
      },
    };

    self.log.info({reqopts: reqopts}, 'creating cla client');

    reqopts.log = self.log;

    self.client = restify.createJsonClient(reqopts);

    cb();
  });
  googleAuth.login();
};

CLA.prototype.query = function (query, cb) {
 var self = this;

  if (!this.auth)
    return this.login(this.query.bind(this, query, cb));

  var qstr = { alt: 'json', sq: query, };
  var url = '/feeds/list/'+ self.config.CLA_KEY +'/od6/private/full?';
  url += qs.stringify(qstr);

  self.log.info({query: query, url: url});

  self.client.get(url, function (e, req, res, b) {
    self.log.info({query: query, url: url, body: b, err: e}, 'we have a response');

    if (res.statusCode === 403) {
      self.log.info({err: e, req: req, res: res}, 'logging into google docs');
      return self.login(self.query.bind(self, query, cb));
    }

    if (b && b.feed && b.feed.entry) cb(b.feed.entry);
    else cb(null);
  });
};

CLA.prototype.email = function (email, cb) {
  // TODO dear god, sqlinject google docs?
  this.query('"e-mail" = "' + email + '"', cb);
};

CLA.prototype.fullname = function (name, cb) {
  // TODO dear god, sqlinject google docs?
  this.query('"fullname" = "' +name + '"', cb);
};

CLA.prototype.full_or_email = function (name, email, cb) {
  // TODO dear god, sqlinject google docs?
  var q = '"fullname" = "' + name + '" or ';
  q += '"e-mail" = "' + email + '"';

  this.query(q, cb);
};

CLA.prototype.emails = function (emails, cb) {
  var q = emails.map(function (e) { return '"e-mail" = "' + e + '"'; })
  // Only add the OR if there's more than one email
  if (q.length > 1) q = q.join(' OR ');
  else q = q[0];
  this.query(q, cb);
};
