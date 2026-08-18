// The hall: paste a link, get a book.
//
// Two ways in, and the field decides which without being told. Something that
// parses as a Wikipedia URL is resolved directly — one request, then go.
// Anything else is treated as a title and searched, because a reader who knows
// what they want should not have to go and find the URL first.

import { wireThemeToggle } from '/theme.js';
import { readHistory } from '/history.js';
import { volume } from '/shelf.js';
import { wireVoice } from '/voice.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const field = $('q');
const form = $('pasteForm');
const hint = $('pasteHint');
const results = $('results');
const goBtn = $('go');

const HINT_IDLE = 'Any language. A GitHub repo becomes an atlas.';

let seq = 0;          // guards against a slow response overwriting a newer one
let active = -1;      // keyboard selection within the results list
let items = [];

// Anything the server can resolve directly rather than search for: a wiki URL,
// a GitHub URL, or an "owner/repo" pair.
const looksLikeUrl = (s) => /^(https?:\/\/|[a-z0-9-]+\.(m\.)?wikipedia\.org|github\.com\/)/i.test(s.trim())
  || /^[\w.-]+\/[\w.-]+$/.test(s.trim())
  || /^eips?$/i.test(s.trim());

// ---- state helpers -------------------------------------------------------

function setHint(text, kind = '') {
  hint.textContent = text;
  hint.className = `paste-hint${kind ? ' ' + kind : ''}`;
}

function clearResults() {
  results.hidden = true;
  results.replaceChildren();
  items = [];
  active = -1;
}

function open(href) {
  if (!href) return;
  setHint('Opening…', 'busy');
  location.href = href;
}

// ---- rendering -----------------------------------------------------------

function card(item, { preview = false } = {}) {
  const a = document.createElement('a');
  a.className = `result${preview ? ' preview' : ''}`;
  a.href = item.href;

  const art = document.createElement('div');
  art.className = 'result-art';
  if (item.thumb || item.thumbnail) {
    const img = new Image();
    img.src = item.thumb || item.thumbnail;
    img.alt = '';
    img.loading = 'lazy';
    art.appendChild(img);
  }
  a.appendChild(art);

  const body = document.createElement('div');
  body.className = 'result-body';
  body.innerHTML =
    `<div class="result-title">${esc(item.title)}</div>` +
    (item.description ? `<div class="result-desc">${esc(item.description)}</div>` : '');
  a.appendChild(body);

  if (item.lang && item.lang !== 'en') {
    const tag = document.createElement('span');
    tag.className = 'result-lang';
    tag.textContent = item.lang;
    a.appendChild(tag);
  }

  const go = document.createElement('span');
  go.className = 'result-go';
  go.textContent = preview ? 'Bind →' : 'Open →';
  a.appendChild(go);

  return a;
}

function show(nodes) {
  results.replaceChildren(...nodes);
  results.hidden = nodes.length === 0;
  items = [...results.querySelectorAll('.result')];
  active = -1;
}

// ---- the two ways in -----------------------------------------------------

async function resolve(raw) {
  const mine = ++seq;
  setHint('Looking it up…', 'busy');
  clearResults();

  let res, data;
  try {
    res = await fetch(`/api/resolve?q=${encodeURIComponent(raw)}`);
    data = await res.json();
  } catch {
    if (mine === seq) setHint('Could not reach the server.', 'err');
    return;
  }
  if (mine !== seq) return;

  if (!res.ok || data.error) {
    setHint(data.error || 'That did not resolve to an article.', 'err');
    return;
  }

  if (data.ok === false && data.reason === 'disambiguation') {
    setHint(`“${data.title}” is a disambiguation page — pick a specific article.`, 'err');
    return;
  }

  const node = card(data, { preview: true });
  const nodes = [node];

  // Say so plainly rather than quietly producing a thinner book.
  if (!data.languageSupported) {
    const warn = document.createElement('div');
    warn.className = 'result-warn';
    warn.textContent =
      `This book will build, but ${data.languageName} is not one of the languages whose `
      + `section names and date grammar are known here — so it will have no chronology, and `
      + `its reference sections will read as ordinary chapters.`;
    nodes.push(warn);
  }

  show(nodes);
  setHint(HINT_IDLE);
  active = 0;
  node.classList.add('on');
}

let searchTimer = null;

function search(raw) {
  clearTimeout(searchTimer);
  const q = raw.trim();
  if (q.length < 2) { clearResults(); setHint(HINT_IDLE); return; }

  searchTimer = setTimeout(async () => {
    const mine = ++seq;
    let data;
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
      data = await res.json();
    } catch { return; }
    if (mine !== seq) return;

    const found = data.results || [];
    if (!found.length) { clearResults(); setHint('Nothing on English Wikipedia by that name.'); return; }
    show(found.map((r) => card(r)));
    setHint(HINT_IDLE);
  }, 180);
}

// ---- wiring --------------------------------------------------------------

function handle(raw) {
  if (!raw.trim()) { clearResults(); setHint(HINT_IDLE); return; }
  if (looksLikeUrl(raw)) resolve(raw);
  else search(raw);
}

field.addEventListener('input', () => handle(field.value));

// A paste is unambiguous intent: resolve it at once rather than waiting out the
// search debounce that the same keystrokes would otherwise trigger.
field.addEventListener('paste', (ev) => {
  const text = (ev.clipboardData || window.clipboardData)?.getData('text');
  if (!text) return;
  ev.preventDefault();
  field.value = text.trim();
  handle(field.value);
});

field.addEventListener('keydown', (ev) => {
  if (!items.length) return;
  if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
    ev.preventDefault();
    items[active]?.classList.remove('on');
    active = ev.key === 'ArrowDown'
      ? (active + 1) % items.length
      : (active - 1 + items.length) % items.length;
    items[active].classList.add('on');
    items[active].scrollIntoView({ block: 'nearest' });
  } else if (ev.key === 'Escape') {
    clearResults();
  }
});

form.addEventListener('submit', (ev) => {
  ev.preventDefault();
  const chosen = items[active >= 0 ? active : 0];
  if (chosen) return open(chosen.getAttribute('href'));
  // Nothing resolved yet — resolve now, and the reader can press Bind again.
  handle(field.value);
});

// ---- the shelf -----------------------------------------------------------
//
// Two sources, one wall. Books you have opened come from localStorage and stand
// first; books the server has already bound stand after them, dimmed, because
// they open instantly but you have not read them yet.

(async function shelves() {
  const wall = $('shelves');
  const mine = readHistory();

  let bound = [];
  try {
    const res = await fetch('/api/shelf');
    bound = (await res.json()).books || [];
  } catch { /* the shelf still works with history alone */ }

  const seen = new Set(mine.map((b) => `${b.lang || 'en'}:${b.title}`));
  const unread = bound.filter((b) => !seen.has(`${b.lang || 'en'}:${b.title}`));

  wall.replaceChildren();
  for (const b of mine) wall.appendChild(volume(b));
  for (const b of unread) wall.appendChild(volume(b, { unread: true }));

  if (!mine.length && !unread.length) {
    const empty = document.createElement('p');
    empty.className = 'shelf-empty';
    empty.innerHTML =
      'The shelf is empty. <b>Paste a Wikipedia link above</b> and the article comes back '
      + 'as a book — chapters from its own sections, apparatus from its infobox, and a shelf '
      + 'of adjacent volumes from its links. Everything you open stands here afterwards.';
    wall.appendChild(empty);
  }
})();

// ---- what gets read aloud ------------------------------------------------
//
// There is no prose here to read, so reading the room means taking inventory:
// what this place is, then the shelf itself — each volume with the things the
// spine already tells you by its size and colour, said out loud.

function collectSpokenRoom() {
  const out = [{
    text: 'Reading Room. Any Wikipedia article, as a book. Paste a link and the '
        + "article's own sections become chapters, its infobox becomes apparatus, "
        + 'and its links become a shelf of adjacent volumes.',
    label: 'The room',
  }];

  const vols = [...document.querySelectorAll('.vol')];
  if (!vols.length) {
    out.push({ text: 'The shelf is empty. Paste a Wikipedia link to bind your first volume.', label: 'Shelf' });
    return out;
  }

  out.push({ text: `There are ${vols.length} volumes on the shelf.`, label: 'Shelf' });

  for (const v of vols) {
    const title = v.querySelector('.vol-front-title')?.textContent?.trim();
    if (!title) continue;
    const kind = v.dataset.kind;
    const sub = v.querySelector('.vol-front-sub')?.textContent?.trim();
    const meta = v.querySelector('.vol-front-meta')?.textContent?.trim();
    const unread = v.classList.contains('unread') ? ', not yet read' : '';
    // The title is the book's own; the description of it is ours. Speaking them
    // as one passage would force one language on both, so they are separate.
    const lang = v.querySelector('.vol-lang')?.textContent?.trim() || 'en';
    out.push({ text: title + '.', label: title, node: v, lang });
    const about = [sub, `a ${kind}${unread}`, meta].filter(Boolean).join('. ');
    if (about) out.push({ text: about + '.', label: title, node: v, lang: 'en' });
  }
  return out;
}

// ---- your library --------------------------------------------------------
//
// One control for both cases, because the server has one door: an unclaimed
// name is claimed by whoever opens it first, and a claimed one needs its code.
// The panel therefore never has to ask "do you already have one?" — a question
// nobody should have to answer about their own shelf.

async function wireLibraryButton() {
  const btn = $('libBtn');
  const panel = $('libPanel');
  if (!btn || !panel) return;

  let me = null;
  try {
    const out = await (await fetch('/api/library/me')).json();
    if (out.signedIn) me = out.library;
  } catch { /* offline: the button still opens the form */ }

  const paint = () => {
    btn.textContent = me ? me.username : 'Library';
    btn.classList.toggle('on', !!me);
    btn.title = me ? `Your library: ${me.username}` : 'Open or create a library';
  };
  paint();

  const close = () => { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); };

  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    if (!panel.hidden) return close();
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    draw();
  });
  document.addEventListener('click', (e) => { if (!panel.hidden && !panel.contains(e.target)) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

  function draw() {
    if (me) {
      panel.innerHTML =
        `<div class="lib-panel-head">Signed in as <b>${esc(me.username)}</b></div>` +
        `<a class="lib-panel-go" href="/${encodeURIComponent(me.username)}">Open your library →</a>` +
        `<div class="lib-panel-meta">${me.items.length} volume${me.items.length === 1 ? '' : 's'} · `
        + `press ＋ in any book to keep it</div>` +
        `<button class="lib-panel-out" id="libOut">Sign out</button>`;
      $('libOut').onclick = async () => {
        await fetch('/api/library/close', { method: 'POST' });
        me = null; paint(); draw();
      };
      return;
    }

    panel.innerHTML =
      `<div class="lib-panel-head">Your own shelf, on any browser</div>` +
      `<form class="lib-form" id="libForm">
         <input id="libName" name="username" autocomplete="username" spellcheck="false"
                placeholder="a name — yours to pick" aria-label="Library name">
         <input id="libCode" name="password" type="password" autocomplete="current-password"
                placeholder="secret code, 8+ characters" aria-label="Secret code">
         <button type="submit">Open</button>
       </form>
       <p class="lib-panel-err" id="libErr"></p>
       <p class="lib-panel-meta">If the name is free it becomes yours. If it is taken, the code has to
         match it. No email, and <b>no way to reset the code</b> — don't reuse a password.</p>`;

    $('libForm').addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const err = $('libErr');
      err.textContent = '';
      const username = $('libName').value.trim().toLowerCase();
      const code = $('libCode').value;
      try {
        const r = await fetch('/api/library/open', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username, code }),
        });
        const out = await r.json();
        if (!r.ok) { err.textContent = out.error || 'That did not work.'; return; }
        location.href = `/${encodeURIComponent(out.library.username)}`;
      } catch { err.textContent = 'Could not reach the server.'; }
    });
  }
}

wireLibraryButton();

wireVoice($('voiceBtn'), { collect: collectSpokenRoom, lang: 'en' });
wireThemeToggle($('themeBtn'));
field.focus();
