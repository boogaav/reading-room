// The hall: paste a link, get a book.
//
// Two ways in, and the field decides which without being told. Something that
// parses as a Wikipedia URL is resolved directly — one request, then go.
// Anything else is treated as a title and searched, because a reader who knows
// what they want should not have to go and find the URL first.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const field = $('q');
const form = $('pasteForm');
const hint = $('pasteHint');
const results = $('results');
const goBtn = $('go');

const HINT_IDLE = 'Any language. Or just type a title.';

let seq = 0;          // guards against a slow response overwriting a newer one
let active = -1;      // keyboard selection within the results list
let items = [];

const looksLikeUrl = (s) => /^(https?:\/\/|[a-z0-9-]+\.(m\.)?wikipedia\.org)/i.test(s.trim());

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

(async function shelf() {
  let books = [];
  try {
    const res = await fetch('/api/shelf');
    books = (await res.json()).books || [];
  } catch { return; }
  if (!books.length) return;

  const wrap = $('shelf');
  for (const b of books) {
    const a = document.createElement('a');
    a.className = 'hall-volume';
    a.href = b.href;
    a.innerHTML =
      `<div class="hall-volume-art">${b.thumb ? `<img src="${esc(b.thumb)}" alt="" loading="lazy">` : ''}</div>` +
      `<div class="hall-volume-body">` +
      `<div class="hall-volume-title">${esc(b.title)}</div>` +
      (b.description ? `<div class="hall-volume-desc">${esc(b.description)}</div>` : '') +
      (b.lang !== 'en' ? `<div class="hall-volume-lang">${esc(b.lang)}</div>` : '') +
      `</div>`;
    wrap.appendChild(a);
  }
  $('shelfSection').hidden = false;
})();

field.focus();
