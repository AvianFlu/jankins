var GHApi = module.exports = function (options) {
  if (!(this instanceof GHApi)) return new GHApi(options);
  this.options = options;

  this.options.server.get('/ghapi/.*', this.proxy.bind(this))
};

GHApi.prototype.proxy = function (req, res, next) {
  var url = '/repos' + req.path().replace(/^\/ghapi/, '');

  this.options.ghrest.get(url, function (e, jreq, jres, b) {
    res.json(jres.statusCode, b);
    return next();
  });
};
