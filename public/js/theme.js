// Loaded in <head> (blocking) so the saved theme is applied before the page paints.
// Only a harmless UI preference is kept in the browser; all real data lives on the server.
(function () {
  var theme = 'dark';
  try { theme = localStorage.getItem('th_theme') || 'dark'; } catch (e) { /* storage blocked: use default */ }
  document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark');
})();
