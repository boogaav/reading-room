// "Keep this" — the button that puts what you are reading on your shelf.
//
// Only appears once the server confirms a session, so a visitor is never shown
// a control that cannot work. The page describes itself through `describe()`,
// because a book and an atlas know different things about themselves.

const KEEP = '＋';

export async function wireKeep(btn, describe) {
  if (!btn) return;

  let me = null;
  try {
    const r = await fetch('/api/library/me');
    const out = await r.json();
    if (!out.signedIn) return;          // stays hidden
    me = out.library.username;
  } catch { return; }

  btn.hidden = false;
  let held = false;

  const paint = () => {
    btn.textContent = held ? '✓' : KEEP;
    btn.title = held ? `Kept in ${me}` : `Keep this in ${me}`;
    btn.setAttribute('aria-label', btn.title);
    btn.classList.toggle('on', held);
  };
  paint();

  btn.addEventListener('click', async () => {
    if (held) return;
    const item = describe();
    if (!item?.href) return;
    try {
      const r = await fetch(`/api/library/${encodeURIComponent(me)}/items`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(item),
      });
      held = r.ok;
    } catch { held = false; }
    paint();
  });
}
