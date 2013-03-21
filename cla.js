var GoogleClientLogin = require("googleclientlogin").GoogleClientLogin;
var Jenkins = require('./jenkins');
var request = require('request');

var CLA = module.exports = function (opts) {
  if (!(this instanceof CLA)) return new CLA(opts);
  this.config = opts.config;

  var self = this;

  function validUser (req, res, next, cb) {
    if (!req.query.JENKINS_USERNAME || !req.query.JENKINS_API_TOKEN)
      return next(new Error('You must supply a Jenkins username and api key'));

    var jenkins = new Jenkins({
      hostname: self.config.JENKINS_HOSTNAME,
      port: self.config.JENKINS_PORT,
      username: req.query.JENKINS_USERNAME,
      password: req.query.JENKINS_API_TOKEN,
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
    cb();
  });
  googleAuth.login();
};

CLA.prototype.query = function (key, value, cb) {
 var self = this;

  if (!this.auth)
    return this.login(this.query.bind(this, key, value, cb));

  var url = 'https://spreadsheets.google.com/feeds/list/'+ self.config.CLA_KEY +'/od6/private/full/'

  var reqopts = {
    url: url,
    json: true,
    qs: {
      alt: 'json',
      sq: '"' + key + '" = "'+ value +'"',
    },
    headers: {
      Authorization: 'GoogleLogin auth='+ self.auth,
    },
  }

  request.get(reqopts, function (e, r, b) {
    if (r.statusCode === 403) {
      return self.login(self.query.bind(self, key, value, cb));
    }

    if (b && b.feed && b.feed.entry) cb(b.feed.entry);
    else cb(null);
  });
};

CLA.prototype.email = function (email, cb) {
  this.query('e-mail', email, cb);
};

CLA.prototype.fullname = function (name, cb) {
  this.query('fullname', name, cb);
};
