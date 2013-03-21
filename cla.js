var GoogleClientLogin = require("googleclientlogin").GoogleClientLogin;
var request = require('request');

var CLA = module.exports = function (opts) {
  if (!(this instanceof CLA)) return new CLA(opts);
  this.config = opts.config;
};

CLA.prototype.exists = function (email, cb) {
  var self = this;

  // TODO cache login info
  var googleAuth = new GoogleClientLogin({
    email: this.config.GOOGLE_USERNAME,
    password: this.config.GOOGLE_PASSWORD,
    service: 'spreadsheets',
    accountType: GoogleClientLogin.accountTypes.google
  });

  googleAuth.on(GoogleClientLogin.events.login, function(){
    var headers = {
      Authorization: 'GoogleLogin auth='+ googleAuth.getAuthId(),
    };
    var url = 'https://spreadsheets.google.com/feeds/list/'+ self.config.CLA_KEY +'/od6/private/full/'
    var qs = {
      alt: 'json',
      sq: '"e-mail" = "'+ email +'"',
    };
    request.get({ url: url, qs: qs, headers: headers, json: true}, function (e, r, b) {
      if (b && b.feed && b.feed.entry)
        cb(b.feed.entry);
      else
        cb(null);
    });
  });
  googleAuth.login();
};
