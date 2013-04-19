var request = require('request');

var GHApi = module.exports = function (options) {
  if (!(this instanceof GHApi)) return new GHApi(options);
  this.options = options;

  this.options.server.get('/ghapi/.*', this.proxy.bind(this))
};

GHApi.prototype.proxy = function (req, res, next) {
  var path = 'https://api.github.com/repos' + req.path().replace(/^\/ghapi/, '');

  request.get({ url: path, json: true}, function (e, r, b) {
    res.json(r.statusCode, b);
    return next();
  });
};
