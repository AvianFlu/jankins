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

jQuery(function () {
  if (window.location.pathname.match(/testReport\/$/))
    testReport();
});
