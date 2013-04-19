function testReport() {
  var path = window.location.pathname.split('/');
  var buildId = path.slice(-3)[0]

  jQuery('#main-panel > h2').nextAll().remove();
  jQuery('#main-panel > table > tbody > tr:gt(0)').each(function (idx, row) {
    var failed = jQuery(jQuery(this).children('td:eq(3)')[0]).text();
    if (failed === '0') return;

    var label = jQuery(this).children('td:eq(0)').text();
    var npath = path.slice();
    npath.pop()
    npath.pop()
    npath.push(label);
    npath.push('tapTestReport');
    npath.push('');
    var url = npath.join('/');

    jQuery('#main-panel > h2').after('<h3>'+label+'</h3><a id="'+label+'"></a><div id="failed-'+idx+'">Loading</div>');
    jQuery('#failed-'+idx).load(url + ' #main-panel > table:eq(1)');
  });
};

function prChanges(match) {
  var notepad = jQuery('img').filter(function () { return jQuery(this).attr('src').match(/48x48\/notepad.png$/); });

  if (!notepad.length) return;

  var changes = notepad.parent().next();

  changes.html('Changes <ol></ol>');

  var ol = jQuery('ol');

  jQuery.getJSON(window.location.pathname + 'api/json', function (build) {
    var prpath;

    build.actions.forEach(function (action) {
      if (!action.parameters) return;
      action.parameters.forEach(function (parameter) {
        if (parameter.name === 'PR_PATH')
          prpath = parameter.value;
      });
    });

    if (!prpath) return;

    prpath = '/ghapi' + prpath.replace('pull', 'pulls') + '/commits';

    jQuery.getJSON(prpath, function (commits) {
      //console.log(prpath, commits);
      commits.forEach(function (commit) {
        var msg = commit.commit.message.split(/\n/)[0];
        msg += ' (<a href="' + commit.html_url + '">commit: ' + commit.sha + '</a>)';
        ol.append('<li>' + msg + '</li>');
      });
    });
  });
}

jQuery(function () {
  if (window.location.pathname.match(/testReport\/$/))
    testReport();

  var match = window.location.pathname.match(/pullrequest\/(\d+|(lastCompletedBuild))\//);

  if (match)
    prChanges(match);
});
