/**
 * Mock-only theme toggle. Cycles system -> light -> dark, matching the real
 * app's contract in frontend/src/styles/tokens.css: an explicit choice stamps
 * data-theme on <html>; "system" removes it and prefers-color-scheme decides.
 */
(function () {
  const STORAGE_KEY = 'pypa.mock.theme';
  const root = document.documentElement;
  const order = ['system', 'light', 'dark'];

  function apply(theme) {
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);
    const btn = document.getElementById('mock-theme-toggle');
    if (btn) btn.textContent = 'Theme: ' + theme;
  }

  function current() {
    try {
      return localStorage.getItem(STORAGE_KEY) || 'system';
    } catch {
      return 'system';
    }
  }

  function set(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
    apply(theme);
  }

  window.mockToggleTheme = function () {
    const next = order[(order.indexOf(current()) + 1) % order.length];
    set(next);
  };

  apply(current());
})();
