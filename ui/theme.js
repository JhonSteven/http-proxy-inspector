// Runs before first paint so the page does not flash the wrong theme.
(function () {
  var saved = null;
  try {
    saved = localStorage.getItem('http-proxy-inspector-theme');
  } catch (e) {}
  var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  document.documentElement.setAttribute('data-theme', saved || (prefersDark ? 'dark' : 'light'));
})();
