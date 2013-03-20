var Nightlies = module.exports = function (opts) {
  if (!(this instanceof Nightlies)) return new Nightlies(opts);
 
  this.jenkins = opts.jenkins;
 
  opts.server.get('/nightly/:repo', this.nightlies.bind(this));
  opts.server.get('/nightlies', function (req, res, next) {
    res.setHeader('Location', '/html/nightlies.html');
    res.send(302);
    return next();
  });
};

Nightlies.prototype.nightlies = function (req, res, next) {
  var args = {
    tree: 'builds[id,runs[url,artifacts[relativePath,fileName]]]',
    depth: 2,
  };
  this.jenkins.buildReport(req.params.repo, args, function (e, r, b) {
    var results = {};
    b.builds.forEach(function (build) {
      var result = results[build.id] = results[build.id] || {};
      build.runs.forEach(function (run) {
        var platform = run.url.match(/label=(\w+)/);
        var arch = run.url.match(/DESTCPU=(\w+)/);
        var key = '';

        if (platform) key = platform[1];
        if (arch) key += '-' + arch[1];

        var sub = result[key] = result[key] || [];
        run.artifacts.forEach(function (artifact) {
          if (!artifact) return;
          sub.push({
            name: artifact.fileName,
            url: run.url + 'artifact/' + artifact.relativePath,
          });
        });
      });
    });
    res.json(200, results);
    return next();
  });
};
