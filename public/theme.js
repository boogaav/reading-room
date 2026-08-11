// Ink or paper.
//
// The choice is applied by a tiny inline script in <head> before anything
// paints — a module would load too late and the page would flash the wrong
// theme. This file only handles the toggle and telling the map about it.

export const THEME_KEY = 'readingroom.theme';

export function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  // Anything that cannot be themed with CSS alone — the map's tiles — listens.
  window.dispatchEvent(new CustomEvent('themechange', { detail: { theme: next } }));
  return next;
}

export function toggleTheme() {
  return applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

/** Wires a button to the toggle and keeps its label in step. */
export function wireThemeToggle(btn) {
  if (!btn) return;
  const paint = () => {
    const dark = currentTheme() === 'dark';
    btn.textContent = dark ? '☾' : '☀';
    btn.title = dark ? 'Read on paper' : 'Read in ink';
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(!dark));
  };
  btn.addEventListener('click', () => { toggleTheme(); paint(); });
  window.addEventListener('themechange', paint);
  paint();
}
