// The shelf, drawn once.
//
// The home page and a library show the same wall of spines, so the drawing
// lives here rather than in both — the two cannot drift apart, and a change to
// how a book looks is one change.

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = new Intl.NumberFormat('en-US');

const KINDS = new Set(['battle', 'person', 'country', 'place', 'generic', 'catalogue', 'ledger', 'readme']);

/**
 * A book's proportions are its own. Thickness follows word count and height
 * follows chapter count, so the shelf is a physical read on the library: the
 * fat volume is Stalingrad at 15,900 words, the slim one is a stub.
 */
export function proportions(b) {
  const words = b.words || 0;
  const chapters = b.chapters || 0;
  // Entries with no measurements (an atlas, an unbuilt book) vary by name
  // instead of standing as a row of identical blanks.
  const jitter = [...String(b.title)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 97, 7) / 97;

  const w = words
    ? Math.round(Math.min(62, Math.max(25, 25 + words / 430)))
    : Math.round(30 + jitter * 16);
  const h = chapters
    ? Math.round(Math.min(288, Math.max(212, 212 + chapters * 2.1)))
    : Math.round(224 + jitter * 46);
  return { w, h, fw: Math.round(Math.min(196, Math.max(148, h * 0.66))) };
}

export function volume(b, { unread = false, removable = false, onRemove = null } = {}) {
  const { w, h, fw } = proportions(b);
  const kind = KINDS.has(b.archetype) ? b.archetype : 'generic';

  const vol = document.createElement('div');
  vol.className = `vol${unread ? ' unread' : ''}`;
  vol.dataset.kind = kind;
  vol.style.setProperty('--w', `${w}px`);
  vol.style.setProperty('--h', `${h}px`);
  vol.style.setProperty('--fw', `${fw}px`);

  const a = document.createElement('a');
  a.className = 'vol-inner';
  a.href = b.href;
  a.setAttribute('aria-label', `${b.title} — open`);

  const art = (b.cover || b.thumb)
    ? `<div class="vol-front-art"><img src="${esc(b.cover || b.thumb)}" alt="" loading="lazy"></div>`
    : '';
  const meta = b.words
    ? `${fmt.format(b.words)} words · ${b.chapters} chapters`
    : (b.kind === 'atlas' ? 'an atlas' : 'bound and waiting');

  a.innerHTML =
    `<div class="vol-pages"></div>` +
    `<div class="vol-front">${art}` +
      `<div class="vol-front-body">` +
        `<div class="vol-front-kind">${esc(kind)}${b.lang && b.lang !== 'en' ? ' · ' + esc(b.lang) : ''}</div>` +
        `<div class="vol-front-title">${esc(b.title)}</div>` +
        (b.subtitle || b.description
          ? `<div class="vol-front-sub">${esc(b.subtitle || b.description)}</div>` : '') +
        `<div class="vol-front-meta">${esc(meta)}</div>` +
      `</div>` +
    `</div>` +
    `<div class="vol-spine">` +
      `<span class="vol-mark"></span>` +
      `<span class="vol-title">${esc(b.title)}</span>` +
      `<span class="vol-lang">${esc(b.lang || 'en')}</span>` +
    `</div>`;

  vol.appendChild(a);

  if (removable && onRemove) {
    const x = document.createElement('button');
    x.className = 'vol-remove';
    x.textContent = '×';
    x.title = `Take ${b.title} off the shelf`;
    x.setAttribute('aria-label', x.title);
    x.onclick = (ev) => { ev.preventDefault(); ev.stopPropagation(); onRemove(b); };
    vol.appendChild(x);
  }
  return vol;
}

/** Fills `wrap` with one spine per item. */
export function renderShelf(wrap, items, opts = {}) {
  wrap.replaceChildren(...items.map((b) => volume(b, opts)));
  return wrap;
}
