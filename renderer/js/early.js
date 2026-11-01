// Runs before the first paint (a classic script, so it blocks): on Android the library lives in localStorage,
// and the theme saved with it is applied at once — no light splash flashing before a dark theme loads.
(function () {
  // macOS: the window keeps its own traffic lights, so the titlebar makes room for them (styles.css, html.mac)
  try { if (window.sds && window.sds.platform === 'darwin') document.documentElement.classList.add('mac'); } catch (e) {}
  // economy mode is decided once per start (the heavy parts are simply never created), so it reads here
  try { if (localStorage.getItem('sds-eco') === '1') document.documentElement.classList.add('eco'); } catch (e) {}
  try {
    var th = localStorage.getItem('sds-theme');
    if (!th) return;
    document.documentElement.dataset.theme = th;
    document.documentElement.dataset.tone = th === 'deep' || th === 'obsidian' ? 'dark' : 'light';
  } catch (e) {}
})();
