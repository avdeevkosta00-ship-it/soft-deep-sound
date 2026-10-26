// Runs before the first paint (a classic script, so it blocks): on Android the library lives in localStorage,
// and the theme saved with it is applied at once — no light splash flashing before a dark theme loads.
(function () {
  try {
    var th = localStorage.getItem('sds-theme');
    if (!th) return;
    document.documentElement.dataset.theme = th;
    document.documentElement.dataset.tone = th === 'deep' || th === 'obsidian' ? 'dark' : 'light';
  } catch (e) {}
})();
