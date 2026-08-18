import { wireThemeToggle, currentTheme } from '/theme.js';
import { remember } from '/history.js';
import { wireVoice, setVoiceLang, stop as stopVoice } from '/voice.js';
import { wireKeep } from '/keep.js';

// Reading Room — client renderer.
//
// One render function per block type. The server decides *which* blocks exist
// (archetype template); this file only knows how to draw each kind.

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = new Intl.NumberFormat('en-US');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

const state = {
  book: null, notes: new Map(), summaries: new Map(), chrono: 0,
  wired: false, spineIO: null, scrollWired: false,
  warmed: new Set(),
  // Which Wikipedia this book came from. Every link inside a German book stays
  // on the German Wikipedia, so a reading walk never silently changes language.
  lang: 'en',
};

// A reading session is allowed this many speculative builds. Past it we stop
// asking: a reader who has hovered two dozen links is browsing, not walking.
const WARM_BUDGET = 24;
// Dwell before a hover counts as intent. Short enough to be useful, long enough
// that dragging the pointer across a paragraph of links warms none of them.
const WARM_DWELL_MS = 120;

// ---- boot ----------------------------------------------------------------

// Wikipedia language codes are 2–3 letters, optionally with a variant suffix.
// A first path segment that looks like one is a language; anything else is the
// start of the title, so /read/Uruguay and /read/de/Uruguay both parse right.
const LANG_CODE = /^[a-z]{2,3}(-[a-z]{2,8})?$/;

function parseReadPath(pathname = location.pathname) {
  const m = /^\/read\/(.+)$/.exec(pathname);
  if (!m) return { lang: 'en', title: 'Battle_of_Stalingrad' };
  const rest = m[1];
  const slash = rest.indexOf('/');
  if (slash > 0) {
    const head = rest.slice(0, slash);
    if (LANG_CODE.test(head)) return { lang: head, title: decodeURIComponent(rest.slice(slash + 1)) };
  }
  return { lang: 'en', title: decodeURIComponent(rest) };
}

// Started only once the module's consts above are initialised — `boot` reads
// LANG_CODE, and a call placed before that declaration dies in the temporal
// dead zone with no book on screen.
boot();

async function boot() {
  const { lang, title } = parseReadPath();
  state.lang = lang;
  const binder = openBinder(title);

  try {
    await streamBook(title, {
      onStage: binder.stage,
      onText: (book) => {
        adopt(book);
        binder.close();
        paint();
        // Only now, with the spine on screen, does the reader have anything to
        // reach for — so this is the earliest the warming engine can be useful.
        if (book.stats?.phase === 'text') showApparatusNote();
        else remember(book); // complete in one frame: nothing more is coming
      },
      onApparatus: (blocks, stats) => {
        state.book.blocks = blocks;
        state.book.stats = stats;
        hideApparatusNote();
        paint();
        // Recorded here rather than on the text frame: the cover image lives in
        // the apparatus, and a shelf of spines with no covers is a poor shelf.
        remember(state.book);
      },
    });
  } catch (err) {
    binder.fail(err.message);
  }
}

/**
 * Reads the NDJSON build stream. Each frame is a real milestone in the build,
 * not a progress estimate — see `streamBook` in server.js.
 */
async function streamBook(title, { onStage, onText, onApparatus }) {
  const res = await fetch(`/api/book/${encodeURIComponent(title)}?stream=1&lang=${encodeURIComponent(state.lang || 'en')}`);
  if (!res.ok || !res.body) throw new Error(res.statusText || 'no response');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let cut;
    while ((cut = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      if (!line) continue;

      let frame;
      try { frame = JSON.parse(line); } catch { continue; }
      if (frame.type === 'stage') onStage(frame);
      else if (frame.type === 'text') onText(frame.book);
      else if (frame.type === 'apparatus') onApparatus(frame.blocks, frame.stats);
      else if (frame.type === 'error') throw new Error(frame.error);
    }
  }
}

function adopt(book) {
  state.book = book;
  setVoiceLang(book.lang || 'en');
  state.notes.clear();
  for (const n of book.notes) state.notes.set(n.id, n);
  document.title = `${book.title} — Reading Room`;
}

// ---- render --------------------------------------------------------------

/**
 * Paints the current blocks. Called twice on a cold open — once with the text,
 * once when the apparatus lands — so it has to be idempotent and, more
 * importantly, must not move the page under someone who is already reading.
 */
function paint() {
  const book = state.book;
  const root = document.getElementById('book');

  // The spine is the expensive node (Japan: 35 chapters of parsed HTML) and the
  // one the reader may be inside of. Reuse it rather than rebuilding it, both to
  // skip the work and to keep scroll position, loaded images and text selection.
  const spine = root.querySelector('[data-block="chapters"]');
  const anchor = spine ? spine.getBoundingClientRect().top : null;

  const before = state.paintedTypes;
  const nodes = [];
  for (const block of book.blocks) {
    if (block.type === 'chapters' && spine) { nodes.push(spine); continue; }
    const node = RENDER[block.type]?.(block, book);
    if (!node) continue;
    node.dataset.block = block.type;
    // Only genuinely new blocks animate in. Re-rendering the cover in place is
    // not an arrival and should not look like one.
    if (before && !before.has(block.type)) node.classList.add('arriving');
    nodes.push(node);
  }
  nodes.push(colophon(book));
  root.replaceChildren(...nodes);
  state.paintedTypes = new Set(book.blocks.map((b) => b.type));

  // Apparatus blocks insert *above* the spine, so without this the reader's
  // paragraph jumps down the screen the moment the second frame lands.
  if (anchor != null) {
    const shift = spine.getBoundingClientRect().top - anchor;
    if (Math.abs(shift) > 1) window.scrollBy({ top: shift, behavior: 'instant' });
  }

  buildToc(book);
  wireSpine();

  if (!state.wired) {
    wireHovercards();
    wireNotes();
    wireWarming();
    wireThemeToggle(document.getElementById('themeBtn'));
    wireVoice(document.getElementById('voiceBtn'), { collect: collectSpokenBook, lang: state.lang });
    wireKeep(document.getElementById('keepBtn'), () => {
      const b = state.book;
      const cover = b.blocks?.find((x) => x.type === 'cover');
      return {
        kind: 'book', lang: b.lang || 'en', title: b.title, href: location.pathname,
        archetype: b.archetype, words: b.stats?.words, chapters: b.stats?.chapters,
        subtitle: cover?.subtitle || b.subject?.description || '', cover: cover?.image || null,
      };
    });
    document.getElementById('railToggle').onclick =
      () => document.getElementById('rail').classList.toggle('open');
    state.wired = true;
  }
}

// ---- the binding screen --------------------------------------------------

// Each stage is a real event from the build, phrased for a reader. Anything the
// server does not report simply never appears — there is no invented progress.
const STAGE_TEXT = {
  fetching: (s) => `Fetching “${s.of}” from Wikipedia`,
  revision: (s) => (s.cached ? `Revision ${s.revid}, already on disk` : `Revision ${s.revid}`),
  parsed: (s) => `${fmt.format(s.chapters)} sections · ${fmt.format(s.notes)} references · ${fmt.format(s.links)} links`,
  classified: (s) => `Archetype: ${s.archetype}`,
  resolving: (s) => `Resolving ${fmt.format(s.links)} entities against Wikidata`,
  lineage: () => 'Walking the succession graph',
  bound: (s) => (s.fromCache ? 'Bound from cache' : 'Bound'),
};

function openBinder(title) {
  const box = document.getElementById('binder');
  const list = document.getElementById('binderStages');
  document.getElementById('binderTitle').textContent = title.replace(/_/g, ' ');
  const seen = new Set();

  return {
    stage(ev) {
      const line = STAGE_TEXT[ev.name]?.(ev);
      if (!line || seen.has(ev.name)) return;
      seen.add(ev.name);
      list.querySelectorAll('li').forEach((li) => li.classList.remove('on'));
      const li = el('li', 'on', esc(line));
      li.appendChild(el('span', 'binder-ms', `${(ev.at / 1000).toFixed(1)}s`));
      list.appendChild(li);
      // The apparatus stages land after the reader is already reading; from
      // there on they belong in the quiet strip, not on a full-screen splash.
      if (state.book) noteApparatus(line);
    },
    close() { box?.remove(); },
    fail(message) {
      if (!box) return;
      box.classList.add('failed');
      document.getElementById('binderTitle').textContent = 'Could not bind this volume';
      list.replaceChildren(el('li', 'on', esc(message)));
    },
  };
}

// ---- the apparatus strip -------------------------------------------------
//
// The book is readable while its apparatus is still being built. This says so,
// quietly, instead of letting blocks appear out of nowhere.

function apparatusStrip() {
  let strip = document.getElementById('apparatusNote');
  if (!strip) {
    strip = el('div', 'apparatus-note');
    strip.id = 'apparatusNote';
    document.body.appendChild(strip);
  }
  return strip;
}

function showApparatusNote() {
  const strip = apparatusStrip();
  strip.replaceChildren(el('span', 'apparatus-pulse'), el('span', null, 'Building the apparatus…'));
}

function noteApparatus(line) {
  const strip = document.getElementById('apparatusNote');
  if (!strip) return;
  strip.replaceChildren(el('span', 'apparatus-pulse'), el('span', null, esc(line)));
}

function hideApparatusNote() {
  const strip = document.getElementById('apparatusNote');
  if (!strip) return;
  strip.classList.add('done');
  setTimeout(() => strip.remove(), 900);
}

// ---- the warming engine (client half) ------------------------------------
//
// Every book links to others: prose wikilinks, shelf cards, lineage nodes,
// ruler portraits, map pins. Reaching for one of them is a signal that we have
// a second or two to bind it before it is asked for.

/** The book a node would open, from either a hover-card handle or a real href. */
function titleOf(node) {
  const hit = node?.closest?.('[data-title], a[href^="/read/"]');
  if (!hit) return null;
  if (hit.dataset?.title) return hit.dataset.title.replace(/_/g, ' ');
  const m = /^\/read\/(.+)$/.exec(hit.getAttribute('href') || '');
  return m ? decodeURIComponent(m[1]).replace(/_/g, ' ') : null;
}

function wireWarming() {
  // Someone on a metered connection did not ask us to speculate on their behalf.
  if (navigator.connection?.saveData) return;

  const ask = (title) => {
    if (!title || title === state.book?.title) return;
    if (state.warmed.has(title) || state.warmed.size >= WARM_BUDGET) return;
    state.warmed.add(title);
    fetch(`/api/warm?title=${encodeURIComponent(title)}&lang=${encodeURIComponent(state.lang || 'en')}`, { keepalive: true }).catch(() => {});
  };

  let dwell = null;
  document.addEventListener('pointerover', (ev) => {
    clearTimeout(dwell);
    const title = titleOf(ev.target);
    if (title) dwell = setTimeout(() => ask(title), WARM_DWELL_MS);
  }, { passive: true });

  // Keyboard and touch never hover, and a click is the last moment that asking
  // still helps — the build outlives the navigation and the next page finds it.
  document.addEventListener('focusin', (ev) => ask(titleOf(ev.target)));
  document.addEventListener('pointerdown', (ev) => ask(titleOf(ev.target)), { capture: true, passive: true });
}

const RENDER = {
  cover: renderCover,
  sides: renderSides,
  forces: renderForces,
  toll: renderToll,
  cast: renderCast,
  stats: renderStats,
  facts: renderFacts,
  contemporaries: renderContemporaries,
  identity: renderIdentity,
  lineage: renderLineage,
  series: renderSeries,
  rulers: renderRulers,
  map: renderMap,
  chronology: renderChronology,
  chapters: renderChapters,
  shelf: renderShelf,
  notes: renderNotes,
};

function section(block, extraCls = '') {
  const s = el('section', `block ${extraCls}`);
  const w = el('div', 'wrap');
  if (block.title) w.appendChild(el('h2', `block-title${block.caption ? '' : ' solo'}`, esc(block.title)));
  if (block.caption) w.appendChild(el('p', 'block-caption', esc(block.caption)));
  s.appendChild(w);
  return { s, w };
}

// ---- cover ---------------------------------------------------------------

function renderCover(b, book) {
  const s = el('section', 'cover');
  if (b.image) {
    const art = el('div', 'cover-art');
    art.appendChild(Object.assign(new Image(), { src: b.image, alt: '' }));
    s.appendChild(art);
  }
  const inner = el('div', 'cover-inner');
  inner.appendChild(el('div', 'cover-eyebrow', `${esc(book.archetype)} · a Wikipedia volume`));
  inner.appendChild(el('h1', null, esc(b.title)));
  if (b.subtitle) inner.appendChild(el('p', 'cover-sub', esc(b.subtitle)));

  if (b.facts.length) {
    const dl = el('dl', 'cover-facts');
    for (const f of b.facts) {
      const d = el('div', 'cover-fact');
      d.appendChild(el('dt', null, esc(f.label)));
      d.appendChild(el('dd', null, esc(f.value)));
      dl.appendChild(d);
    }
    inner.appendChild(dl);
  }

  if (b.plates?.length > 1) {
    const strip = el('div', 'plates');
    b.plates.forEach((p, i) => {
      const img = Object.assign(new Image(), { src: p.thumb || p.src, alt: p.alt || '' });
      if (i === 0) img.className = 'on';
      img.onclick = () => {
        s.querySelector('.cover-art img').src = p.src;
        strip.querySelectorAll('img').forEach((x) => x.classList.remove('on'));
        img.classList.add('on');
      };
      strip.appendChild(img);
    });
    inner.appendChild(strip);
  }
  s.appendChild(inner);
  return s;
}

// ---- sides ---------------------------------------------------------------

function renderSides(b) {
  const { s, w } = section(b);
  const grid = el('div', 'sides');
  b.sides.forEach((side, i) => {
    if (i === 1) grid.appendChild(el('div', 'versus', 'VERSUS'));
    const col = el('div', `side-col ${i === 1 ? 'right' : ''}`);
    col.appendChild(el('h3', 'side-name', esc(side.name)));
    if (side.parties.length > 1) {
      const chips = el('div', 'side-parties');
      side.parties.forEach((p) => chips.appendChild(el('span', 'chip', esc(p))));
      col.appendChild(chips);
    }
    for (const f of side.formations || []) {
      const box = el('div', 'formation');
      if (f.name) box.appendChild(el('div', 'formation-name', esc(f.name)));
      const ul = el('ul');
      f.items.slice(0, 12).forEach((it) => ul.appendChild(el('li', null, esc(it))));
      box.appendChild(ul);
      col.appendChild(box);
    }
    grid.appendChild(col);
  });
  w.appendChild(grid);
  return s;
}

// ---- forces --------------------------------------------------------------

function renderForces(b) {
  const { s, w } = section(b);
  const phaseNames = [...new Set(b.sides.flatMap((sd) => sd.phases.map((p) => p.name || 'Total')))];
  const tabs = el('div', 'phase-tabs');
  const body = el('div');

  let drewAny = false;
  const draw = (phaseName) => {
    body.innerHTML = '';
    const head = el('div', 'force-head');
    head.appendChild(el('div', 'fh a', esc(b.sides[0]?.name || '')));
    head.appendChild(el('div'));
    head.appendChild(el('div', 'fh b', esc(b.sides[1]?.name || '')));
    body.appendChild(head);

    const pick = (side) => side.phases.find((p) => (p.name || 'Total') === phaseName)?.items || [];
    const A = pick(b.sides[0] || { phases: [] });
    const B = pick(b.sides[1] || { phases: [] });
    const valFor = (items, unit) => items.filter((i) => i.unit === unit).sort((x, y) => y.value - x.value)[0]?.value || 0;

    let drew = 0;
    for (const unit of b.units) {
      const a = valFor(A, unit); const bb = valFor(B, unit);
      if (!a && !bb) continue;
      drew++;
      const max = Math.max(a, bb) || 1;
      const row = el('div', 'force-row');
      const ca = el('div', 'bar-cell a');
      ca.appendChild(el('span', 'bar-num', a ? fmt.format(a) : '—'));
      const barA = el('div', 'bar a'); barA.style.width = '0px';
      ca.appendChild(barA);
      const cb = el('div', 'bar-cell b');
      const barB = el('div', 'bar b'); barB.style.width = '0px';
      cb.appendChild(barB);
      cb.appendChild(el('span', 'bar-num', bb ? fmt.format(bb) : '—'));
      row.appendChild(ca);
      row.appendChild(el('div', 'force-label', unit));
      row.appendChild(cb);
      body.appendChild(row);
      requestAnimationFrame(() => {
        barA.style.width = `calc(${(a / max) * 100}% - ${a ? 0 : 100}%)`;
        barB.style.width = `${(bb / max) * 100}%`;
      });
    }
    if (drew) drewAny = true;
    body.hidden = !drew;
  };

  phaseNames.forEach((name, i) => {
    const t = el('button', `phase-tab${i === 0 ? ' on' : ''}`, esc(name));
    t.onclick = () => {
      tabs.querySelectorAll('.phase-tab').forEach((x) => x.classList.remove('on'));
      t.classList.add('on'); draw(name);
    };
    tabs.appendChild(t);
  });
  if (phaseNames.length > 1) w.appendChild(tabs);
  w.appendChild(body);
  draw(phaseNames[0]);

  // The source rows, always one click away — a parse miss must be visible.
  const toggle = el('button', 'raw-toggle', 'Show the infobox source rows');
  const raw = el('div', 'raw-src');
  b.sides.forEach((side) => {
    const box = el('div');
    box.appendChild(el('div', 'formation-name', esc(side.name)));
    const ul = el('ul');
    side.raw.forEach((r) => ul.appendChild(el('li', null, esc(r))));
    box.appendChild(ul);
    raw.appendChild(box);
  });
  toggle.onclick = () => {
    raw.classList.toggle('on');
    toggle.textContent = raw.classList.contains('on') ? 'Hide the infobox source rows' : 'Show the infobox source rows';
  };

  // Some infoboxes state strength in prose ("Unknown, estimates range from
  // 7,000 to 12,000"). Nothing types, so show the source instead of a toggle
  // over an empty chart — the figure is still the reader's to have.
  if (!drewAny) {
    w.querySelector('.block-caption')?.replaceChildren(
      document.createTextNode('The source states strength in prose rather than figures, so there is nothing to chart. Its own wording:'));
    raw.classList.add('on');
  } else {
    w.appendChild(toggle);
  }
  w.appendChild(raw);
  return s;
}

// ---- toll ----------------------------------------------------------------

function renderToll(b) {
  const { s, w } = section(b);
  if (b.total) w.appendChild(el('div', 'toll-total', esc(b.total)));

  const grid = el('div', 'toll');
  const peak = Math.max(...b.sides.map((x) => x.headline?.value || 0), 1);

  b.sides.forEach((side, i) => {
    const col = el('div', 'toll-side');
    col.appendChild(el('div', 'formation-name', esc(side.name)));
    const h = side.headline;
    col.appendChild(el('div', 'toll-num', h
      ? (h.high ? `${fmt.format(h.low)}–${fmt.format(h.high)}` : fmt.format(h.low))
      : '—'));
    col.appendChild(el('div', 'toll-caption', esc(h?.raw || 'not stated numerically')));

    // One dot per 25,000, scaled against the larger side.
    if (h?.value) {
      const dots = el('div', 'dots');
      const total = Math.round(peak / 25000);
      const filled = Math.round(h.value / 25000);
      for (let k = 0; k < Math.min(total, 200); k++) {
        dots.appendChild(el('i', `dot ${k < filled ? (i === 0 ? 'a' : 'b') : 'ghost'}`));
      }
      col.appendChild(dots);
      col.appendChild(el('div', 'chrono-src', `each dot ≈ 25,000 casualties`));
    }
    const ul = el('ul', 'toll-break');
    side.breakdown.slice(1, 10).forEach((line) => ul.appendChild(el('li', null, esc(line))));
    col.appendChild(ul);
    grid.appendChild(col);
  });
  w.appendChild(grid);
  return s;
}

// ---- cast / people -------------------------------------------------------

function personCard(p) {
  const card = el('div', 'person');
  const face = el('div', `person-face${p.thumb ? '' : ' empty'}`);
  if (p.thumb) face.appendChild(Object.assign(new Image(), { src: p.thumb, alt: p.label, loading: 'lazy' }));
  else face.textContent = '◈';
  card.appendChild(face);
  card.appendChild(el('div', 'person-name', esc(p.label)));
  if (p.description) card.appendChild(el('div', 'person-desc', esc(p.description)));
  // Exposed so the warming engine can see what this card would open — the
  // click handler alone is invisible to it.
  card.dataset.title = p.title;
  card.onclick = () => { location.href = bookHref(p.title); };
  return card;
}

function renderCast(b) {
  const { s, w } = section(b);
  for (const g of b.groups) {
    if (!g.people.length) continue;
    const box = el('div', 'cast-group');
    box.appendChild(el('h3', null, esc(g.name)));
    const row = el('div', 'cast-row');
    g.people.forEach((p) => row.appendChild(personCard(p)));
    box.appendChild(row);
    w.appendChild(box);
  }
  return s;
}

function renderContemporaries(b) {
  const { s, w } = section(b);
  const all = [b.subject, ...b.people].filter((p) => p && p.birth);
  if (all.length < 3) return null;
  const min = Math.min(...all.map((p) => p.birth));
  const max = Math.max(...all.map((p) => p.death || new Date().getFullYear()));
  const span = Math.max(1, max - min);

  const list = el('div');
  for (const p of all) {
    const row = el('div', 'force-row');
    row.style.gridTemplateColumns = '190px 1fr';
    row.appendChild(el('div', 'person-name', esc(p.label)));
    const track = el('div', 'chrono-rail');
    track.style.height = '20px'; track.style.margin = '0'; track.style.border = '0';
    const bar = el('div', p === b.subject ? 'bar b' : 'bar a');
    bar.style.position = 'absolute';
    bar.style.left = `${((p.birth - min) / span) * 100}%`;
    bar.style.width = `${(((p.death || max) - p.birth) / span) * 100}%`;
    bar.style.top = '6px';
    bar.title = `${p.birth}–${p.death || '…'}`;
    track.appendChild(bar);
    row.appendChild(track);
    list.appendChild(row);
  }
  w.appendChild(list);
  w.appendChild(el('div', 'chrono-src', `axis: ${min} — ${max}`));
  return s;
}

function renderStats(b) {
  const { s, w } = section(b);
  const dl = el('dl', 'cover-facts');
  for (const st of b.stats) {
    const d = el('div', 'cover-fact');
    d.appendChild(el('dt', null, esc(st.label)));
    d.appendChild(el('dd', null, esc(st.value)));
    dl.appendChild(d);
  }
  w.appendChild(dl);
  return s;
}

function renderFacts(b) {
  if (!b.rows?.length) return null;
  const { s, w } = section(b);
  const dl = el('dl');
  dl.className = 'colophon';
  dl.style.borderTop = '0'; dl.style.marginTop = '0'; dl.style.padding = '0';
  const grid = el('dl');
  grid.style.display = 'grid';
  grid.style.gridTemplateColumns = 'minmax(120px, 200px) 1fr';
  grid.style.gap = '0';
  for (const r of b.rows) {
    const dt = el('dt', null, esc(r.label));
    dt.style.cssText = 'font-family:var(--sans);font-size:10px;letter-spacing:.14em;text-transform:uppercase;color:var(--paper-faint);padding:12px 0;border-top:1px solid var(--rule-soft)';
    const dd = el('dd', null, esc(r.value));
    dd.style.cssText = 'margin:0;padding:12px 0;border-top:1px solid var(--rule-soft);font-size:.92rem';
    grid.appendChild(dt); grid.appendChild(dd);
  }
  w.appendChild(grid);
  return s;
}

// ---- country: identity ---------------------------------------------------

const bookHref = (title, lang = state.lang || 'en') => {
  const slug = encodeURIComponent(String(title).replace(/ /g, '_'));
  return lang === 'en' ? `/read/${slug}` : `/read/${lang}/${slug}`;
};
const fmtYear = (y) => (typeof y !== 'number' ? '—' : y < 0 ? `${Math.abs(y)} BC` : String(y));
const span = (from, to) => (from == null && to == null ? '' : `${fmtYear(from)}–${to == null ? '' : fmtYear(to)}`);

function renderIdentity(b) {
  const { s, w } = section(b);
  const grid = el('div', 'identity');

  if (b.emblems.length) {
    const strip = el('div', 'emblems');
    for (const e of b.emblems) {
      const fig = el('figure', `emblem ${e.kind === 'Flag' ? 'flag' : 'arms'}`);
      fig.appendChild(Object.assign(new Image(), { src: e.src, alt: e.kind, loading: 'lazy' }));
      fig.appendChild(el('figcaption', null, esc(e.kind)));
      strip.appendChild(fig);
    }
    grid.appendChild(strip);
  }

  const dl = el('dl', 'identity-rows');
  for (const r of b.rows) {
    dl.appendChild(el('dt', null, esc(r.label)));
    dl.appendChild(el('dd', null, esc(r.value)));
  }
  grid.appendChild(dl);
  w.appendChild(grid);

  // Two findings that only exist because the qualifiers were kept: a country
  // usually records more than one founding, and its capital has moved.
  const notes = el('div', 'identity-notes');
  if (b.foundings?.length) {
    const box = el('div');
    box.appendChild(el('div', 'formation-name', 'Dated foundings on record'));
    const ul = el('ul', 'dated-list');
    for (const f of b.foundings) {
      const li = el('li');
      li.appendChild(el('span', 'dated-when', esc(fmtYear(f.year))));
      // A date the source records without naming what it founded stays a date.
      const what = f.ofTitle ? el('a', 'dated-what') : el('span', 'dated-what');
      what.textContent = f.of || '—';
      if (f.ofTitle) what.href = bookHref(f.ofTitle);
      li.appendChild(what);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    notes.appendChild(box);
  }
  if (b.formerCapitals?.length) {
    const box = el('div');
    box.appendChild(el('div', 'formation-name', 'Earlier seats of government'));
    const ul = el('ul', 'dated-list');
    for (const c of b.formerCapitals) {
      const li = el('li');
      li.appendChild(el('span', 'dated-when', esc(span(c.from, c.to))));
      const a = el('a', 'dated-what', esc(c.label));
      if (c.title) a.href = bookHref(c.title);
      li.appendChild(a);
      ul.appendChild(li);
    }
    box.appendChild(ul);
    notes.appendChild(box);
  }
  if (notes.childNodes.length) w.appendChild(notes);
  return s;
}

// ---- country: lineage ----------------------------------------------------

function levelLabel(level) {
  if (level === 0) return 'This state';
  if (level === -1) return 'Preceded by';
  if (level === 1) return 'Succeeded by';
  return level < 0 ? `${-level} steps earlier` : `${level} steps later`;
}

function renderLineage(b) {
  const { s, w } = section(b);
  const strip = el('div', 'lineage');

  b.levels.forEach((level, i) => {
    if (i) strip.appendChild(el('div', 'lin-arrow', '→'));
    const col = el('div', `lin-col${level === 0 ? ' subject' : ''}`);
    col.appendChild(el('div', 'lin-era', esc(levelLabel(level))));

    for (const n of b.nodes.filter((x) => x.level === level)) {
      const card = n.title ? el('a', 'lin-node') : el('div', 'lin-node');
      if (n.qid === b.subjectQid) card.classList.add('on');
      if (n.title) card.href = bookHref(n.title);

      const art = el('div', 'lin-flag');
      if (n.flag) art.appendChild(Object.assign(new Image(), { src: n.flag, alt: '', loading: 'lazy' }));
      else art.classList.add('empty');
      card.appendChild(art);

      card.appendChild(el('div', 'lin-name', esc(n.label)));
      card.appendChild(el('div', 'lin-span', esc(span(n.from, n.to) || 'undated')));
      if (n.via) card.appendChild(el('div', 'lin-via', esc(n.via)));
      col.appendChild(card);
    }

    const cut = b.truncated.find((t) => t.level === level);
    if (cut) col.appendChild(el('div', 'lin-more', `+${cut.n} more not shown`));
    strip.appendChild(col);
  });

  w.appendChild(strip);
  return s;
}

// ---- country: dated series ----------------------------------------------

const SERIES_FMT = {
  int: (v) => fmt.format(Math.round(v)),
  decimal: (v) => v.toFixed(3),
  usd: (v) => (v >= 1e12 ? `$${(v / 1e12).toFixed(2)}tn` : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}bn` : `$${fmt.format(Math.round(v))}`),
};

function renderSeries(b) {
  const { s, w } = section(b);
  const tabs = el('div', 'phase-tabs');
  const body = el('div');

  const draw = (spec) => {
    body.innerHTML = '';
    const f = SERIES_FMT[spec.format] || SERIES_FMT.int;
    const pts = spec.points;
    const W = 720, H = 260, PAD_L = 14, PAD_R = 14, PAD_T = 26, PAD_B = 30;

    const xs = pts.map((p) => p.year);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const lo = spec.low.value, hi = spec.peak.value;
    const pad = (hi - lo) * 0.12 || Math.abs(hi) * 0.1 || 1;
    const y0 = lo - pad, y1 = hi + pad;

    const X = (year) => PAD_L + ((year - x0) / Math.max(1e-9, x1 - x0)) * (W - PAD_L - PAD_R);
    const Y = (v) => PAD_T + (1 - (v - y0) / Math.max(1e-9, y1 - y0)) * (H - PAD_T - PAD_B);

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'series-svg');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label',
      `${spec.label}, ${pts.length} points from ${pts[0].year} to ${pts[pts.length - 1].year}`);

    const add = (tag, attrs, text) => {
      const n = document.createElementNS('http://www.w3.org/2000/svg', tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      if (text != null) n.textContent = text;
      svg.appendChild(n);
      return n;
    };

    // Three gridlines, but only the middle one is labelled: the outer two sit
    // exactly on the low and peak values, whose labels the marks already draw.
    for (const v of [lo, (lo + hi) / 2, hi]) {
      add('line', { x1: PAD_L, x2: W - PAD_R, y1: Y(v), y2: Y(v), class: 'series-grid' });
    }
    add('text', { x: PAD_L, y: Y((lo + hi) / 2) - 5, class: 'series-gridlabel' }, f((lo + hi) / 2));

    add('path', {
      class: 'series-line',
      d: pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.year).toFixed(1)} ${Y(p.value).toFixed(1)}`).join(' '),
    });

    for (const p of pts) {
      add('circle', { cx: X(p.year), cy: Y(p.value), r: 2.6, class: 'series-dot' })
        .appendChild(Object.assign(document.createElementNS('http://www.w3.org/2000/svg', 'title'),
          { textContent: `${fmtYear(p.year)} · ${f(p.value)}` }));
    }

    // Only the three points that carry meaning get a label; labelling all of
    // them would be a table, and a table is what the axis is trying not to be.
    const marks = [[pts[0], 'start'], [pts[pts.length - 1], 'end'], [spec.peak, 'peak'], [spec.low, 'low']];
    const done = new Set();
    for (const [p, kind] of marks) {
      if (!p || done.has(p.year)) continue;
      done.add(p.year);
      add('circle', { cx: X(p.year), cy: Y(p.value), r: 4.2, class: 'series-dot mark' });
      const anchor = kind === 'end' ? 'end' : kind === 'start' ? 'start' : 'middle';
      // A trough is labelled below its point, a crest above, so the label never
      // sits on the line it belongs to.
      const below = kind === 'low' || (kind !== 'peak' && p.value < (lo + hi) / 2);
      add('text', {
        x: X(p.year), y: Y(p.value) + (below ? 20 : -12), class: 'series-mark', 'text-anchor': anchor,
      }, `${f(p.value)}`);
      add('text', {
        x: X(p.year), y: H - 10, class: 'series-xlabel', 'text-anchor': anchor,
      }, fmtYear(p.year));
    }

    body.appendChild(svg);

    const note = el('div', 'chrono-src');
    const bits = [`${pts.length} dated points · ${fmtYear(pts[0].year)}–${fmtYear(pts[pts.length - 1].year)}`];
    if (spec.criterionLabel) bits.push(`basis: ${spec.criterionLabel}`);
    // The dropped count is the honest part: it says the chart is a subset and
    // how large a subset, rather than implying the source held only these.
    if (spec.dropped) bits.push(`${spec.dropped} statement${spec.dropped === 1 ? '' : 's'} on another basis are not plotted`);
    note.textContent = bits.join(' · ');
    body.appendChild(note);
  };

  b.series.forEach((spec, i) => {
    const t = el('button', `phase-tab${i === 0 ? ' on' : ''}`, esc(spec.label));
    t.onclick = () => {
      tabs.querySelectorAll('.phase-tab').forEach((x) => x.classList.remove('on'));
      t.classList.add('on');
      draw(spec);
    };
    tabs.appendChild(t);
  });
  if (b.series.length > 1) w.appendChild(tabs);
  w.appendChild(body);
  draw(b.series[0]);
  return s;
}

// ---- country: rulers -----------------------------------------------------

function renderRulers(b) {
  const { s, w } = section(b);
  const from = b.from, to = b.to;
  const total = Math.max(1, to - from);
  const at = (y) => ((y - from) / total) * 100;

  const axis = () => {
    const rail = el('div', 'ruler-axis');
    const step = niceStep(total);
    for (let y = Math.ceil(from / step) * step; y <= to; y += step) {
      const t = el('div', 'ruler-year', esc(fmtYear(y)));
      t.style.left = `${at(y)}%`;
      rail.appendChild(t);
    }
    return rail;
  };

  w.appendChild(axis());

  for (const track of b.tracks) {
    const box = el('div', 'ruler-track');
    box.appendChild(el('h3', null, esc(track.role)));

    for (const p of track.dated) {
      const row = p.title ? el('a', 'ruler-row') : el('div', 'ruler-row');
      if (p.title) row.href = bookHref(p.title);

      const face = el('div', `ruler-face${p.thumb ? '' : ' empty'}`);
      if (p.thumb) face.appendChild(Object.assign(new Image(), { src: p.thumb, alt: '', loading: 'lazy' }));
      else face.textContent = '◈';
      row.appendChild(face);

      const name = el('div', 'ruler-name');
      name.appendChild(el('span', null, esc(p.label)));
      if (p.note) name.appendChild(el('span', 'ruler-note', esc(p.note)));
      row.appendChild(name);

      const rail = el('div', 'ruler-rail');
      const end = p.to == null ? to : p.to;
      const bar = el('div', `bar ${p.current ? 'b' : 'a'}`);
      bar.style.left = `${at(p.from)}%`;
      // A one-year term is a real event; give it something to be seen by.
      bar.style.width = `${Math.max(0.6, at(end) - at(p.from))}%`;
      bar.title = `${fmtYear(p.from)}–${p.to == null ? 'present' : fmtYear(p.to)}`;
      rail.appendChild(bar);
      row.appendChild(rail);

      row.appendChild(el('div', 'ruler-span', esc(`${fmtYear(p.from)}–${p.to == null ? '' : fmtYear(p.to)}`)));
      box.appendChild(row);
    }

    if (track.omitted) {
      box.appendChild(el('div', 'chrono-src', `${track.omitted} earlier ${track.role.toLowerCase()} terms are recorded but not drawn.`));
    }
    // Never silently dropped: a term with no start date cannot be placed on an
    // axis, so it is named instead.
    if (track.undated.length) {
      const list = track.undated.map((p) => p.label).join(', ');
      box.appendChild(el('div', 'chrono-src', `No dated term in the source: ${list}`));
    }
    w.appendChild(box);
  }

  w.appendChild(axis());
  return s;
}

function niceStep(span) {
  for (const s of [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000]) if (span / s <= 9) return s;
  return 2000;
}

// ---- map -----------------------------------------------------------------

let mapSeq = 0;

function renderMap(b) {
  const { s, w } = section(b);
  const shell = el('div', 'map-shell');
  // Unique id: a country book can carry more than one map, and two elements
  // with id="map" would hand Leaflet the same container twice. The height comes
  // from the class, not the id — Leaflet in a zero-height box loads its tiles
  // and shows nothing.
  const mount = el('div', 'map-mount'); mount.id = `map-${++mapSeq}`;
  shell.appendChild(mount);
  w.appendChild(shell);

  if (window.__noLeaflet || typeof L === 'undefined') {
    shell.style.height = 'auto';
    shell.innerHTML = '';
    const fb = el('div', 'map-fallback');
    fb.appendChild(el('div', 'block-caption', 'Map tiles unavailable offline — places resolved from Wikidata P625:'));
    b.points.forEach((p) => fb.appendChild(el('div', null,
      `<strong>${esc(p.label)}</strong><br><span style="font-family:var(--mono);font-size:11px">${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}</span>`)));
    shell.appendChild(fb);
    return s;
  }

  // Build the map only once the block is actually approaching the viewport:
  // a Leaflet map created in a zero-size or hidden container never loads its
  // tiles, and this also spares tile requests for readers who never scroll here.
  const init = () => {
    const map = L.map(mount, { scrollWheelZoom: false, attributionControl: true });
    // CARTO ships a matched pair, so the map changes with the room rather than
    // staying a dark rectangle on a paper page.
    const tileUrl = (t) =>
      `https://{s}.basemaps.cartocdn.com/${t === 'light' ? 'light_all' : 'dark_all'}/{z}/{x}/{y}{r}.png`;
    const tiles = L.tileLayer(tileUrl(currentTheme()), {
      subdomains: 'abcd', maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    }).addTo(map);
    window.addEventListener('themechange', (ev) => tiles.setUrl(tileUrl(ev.detail.theme)));

    const near = [];
    const focus = b.focus || b.points[0];
    const groups = new Map();
    for (const p of b.points) {
      const marker = L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: '', html: `<div class="pin${p.primary ? ' primary' : ''}${p.layer === 'subdivisions' ? ' faint' : ''}"></div>`, iconSize: [12, 12] }),
      });
      marker.bindPopup(
        `<strong>${esc(p.label)}</strong>${p.description ? `<br>${esc(p.description)}` : ''}` +
        `<br><a href="${bookHref(p.title)}">Open as a book →</a>`);
      const key = b.layers ? (p.layer || 'subject') : '_';
      if (!groups.has(key)) groups.set(key, L.layerGroup());
      groups.get(key).addLayer(marker);
      // Tight enough to frame the actual theatre, not the whole continent.
      if (haversine(focus, p) < 1000) near.push([p.lat, p.lon]);
    }

    // Layered maps start with only the layers the template marked `on`, so the
    // 47 prefectures do not bury the seven borders.
    const shown = new Set(b.layers ? b.layers.filter((l) => l.on).map((l) => l.key) : ['_']);
    for (const [key, g] of groups) if (shown.has(key)) g.addTo(map);

    const ptsOf = (keys) => b.points.filter((p) => keys.has(b.layers ? (p.layer || 'subject') : '_')).map((p) => [p.lat, p.lon]);
    const all = b.points.map((p) => [p.lat, p.lon]);
    const fit = (pts) => {
      map.invalidateSize();
      if (pts.length) map.fitBounds(L.latLngBounds(pts).pad(0.18), { maxZoom: b.zoom || 8 });
    };

    if (b.layers) {
      const bar = el('div', 'map-layers');
      for (const layer of b.layers) {
        const btn = el('button', `layer-tab${shown.has(layer.key) ? ' on' : ''}`,
          `${esc(layer.label)} <span>${layer.n}</span>`);
        btn.onclick = () => {
          const on = shown.has(layer.key);
          if (on) { shown.delete(layer.key); map.removeLayer(groups.get(layer.key)); }
          else { shown.add(layer.key); groups.get(layer.key)?.addTo(map); }
          btn.classList.toggle('on', !on);
          fit(ptsOf(shown));
        };
        bar.appendChild(btn);
      }
      shell.parentNode.insertBefore(bar, shell);
      fit(ptsOf(shown).length >= 2 ? ptsOf(shown) : all);
      return;
    }

    fit(near.length >= 2 ? near : all);

    if (near.length >= 2 && near.length < all.length) {
      const btn = el('button', 'raw-toggle', `Show all ${all.length} places`);
      btn.style.cssText += 'margin-top:14px';
      let wide = false;
      btn.onclick = () => {
        wide = !wide; fit(wide ? all : near);
        btn.textContent = wide ? `Focus on ${esc(focus.label)}` : `Show all ${all.length} places`;
      };
      w.appendChild(btn);
    }
  };

  // Build once, from whichever signal arrives first.
  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    io.disconnect();
    document.removeEventListener('visibilitychange', onVisible);
    requestAnimationFrame(init);
  };

  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) build();
  }, { rootMargin: '400px' });
  io.observe(shell);

  // A book opened into a background tab lays out in a hidden document, where
  // browsers suspend IntersectionObserver callbacks — so the map would still be
  // empty when the reader finally switched to it. Re-check on the way back.
  function onVisible() {
    if (document.visibilityState !== 'visible') return;
    const r = shell.getBoundingClientRect();
    if (r.top < innerHeight + 400 && r.bottom > -400) build();
  }
  document.addEventListener('visibilitychange', onVisible);

  return s;
}

function haversine(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---- chronology ----------------------------------------------------------

// A battle runs for months and a life for decades, so a linear axis fits both.
// A country runs for millennia with almost every event in the last two
// centuries, and the same axis puts 90% of the rail under an empty Middle Ages.
const LONG_SPAN_YEARS = 150;
// How much real time survives the compression. At 0 the axis is pure event
// rank and time is meaningless; at 1 it is linear and unreadable. At 0.35 the
// dense modern end opens up while the era bands stay visibly unequal, which is
// the point: the distortion is drawn, not hidden.
const COMPRESS_ALPHA = 0.35;

function chronoScale(times) {
  const from = Math.min(...times);
  const to = Math.max(...times);
  const range = to - from;
  if (range <= LONG_SPAN_YEARS) {
    return { from, to, range, compressed: false, pos: (t) => ((t - from) / Math.max(0.001, range)) * 100 };
  }

  // Blend calendar position with the event's rank among all events. Both terms
  // are monotonic in t, so the blend is monotonic too — the axis can compress
  // but it can never reorder.
  const sorted = times.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const rank = (t) => {
    let i = 0;
    while (i < n && sorted[i] < t) i++;
    if (i === 0) return 0;
    if (i >= n) return 1;
    const prev = sorted[i - 1], next = sorted[i];
    return (i - 1 + (next === prev ? 0 : (t - prev) / (next - prev))) / Math.max(1, n - 1);
  };
  const raw = (t) => COMPRESS_ALPHA * ((t - from) / range) + (1 - COMPRESS_ALPHA) * rank(t);
  const r0 = raw(from), r1 = raw(to);
  return { from, to, range, compressed: true, pos: (t) => ((raw(t) - r0) / Math.max(1e-9, r1 - r0)) * 100 };
}

/** Band width in years, aiming for under ten bands across the rail. */
function bandUnit(range) {
  for (const u of [10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000]) if (range / u <= 10) return u;
  return 5000;
}

function renderChronology(b) {
  const { s, w } = section(b);
  const events = b.events;
  // The axis spans the events we actually have, not the padded search window —
  // otherwise half the rail is empty on a six-month battle.
  const at = (e) => e.year + ((e.month || 1) - 1) / 12 + ((e.day || 1) - 1) / 365;
  const times = events.map(at);
  const scale = chronoScale(times);
  const { from, to } = scale;
  const pos = (e) => Math.max(0, Math.min(100, scale.pos(at(e))));

  const rail = el('div', `chrono-rail${scale.compressed ? ' banded' : ''}`);

  if (scale.compressed) {
    // Equal spans of time, drawn unequal. The bands *are* the disclosure: a
    // reader can see the last two centuries taking half the rail.
    const unit = bandUnit(scale.range);
    let i = 0;
    for (let y = Math.floor(from / unit) * unit; y < to; y += unit, i++) {
      const a = Math.max(0, scale.pos(Math.max(y, from)));
      const z = Math.min(100, scale.pos(Math.min(y + unit, to)));
      if (z - a < 0.05) continue;
      const band = el('div', `chrono-band${i % 2 ? ' alt' : ''}${z - a < 7 ? ' tight' : ''}`);
      band.style.left = `${a}%`;
      band.style.width = `${z - a}%`;
      band.appendChild(el('span', 'chrono-bandlabel', esc(fmtYear(y))));
      rail.appendChild(band);
    }
  }

  rail.appendChild(el('div', 'chrono-axis'));

  // Year gridlines when the span is long, month gridlines when it is short.
  const marks = [];
  if (scale.compressed) {
    // none: the bands carry the labels, and 2,000 year ticks is not an axis
  } else if (to - from > 2.5) {
    for (let y = Math.ceil(from); y <= to; y++) marks.push([y, String(y)]);
  } else {
    for (let y = Math.floor(from); y <= Math.ceil(to); y++) {
      for (let mo = 0; mo < 12; mo++) {
        const v = y + mo / 12;
        if (v < from || v > to) continue;
        marks.push([v, mo === 0 ? String(y) : MONTHS[mo].slice(0, 3)]);
      }
    }
  }
  for (const [v, label] of marks) {
    const t = el('div', 'chrono-year', `${label}<span></span>`);
    t.style.left = `${((v - from) / Math.max(0.001, to - from)) * 100}%`;
    rail.appendChild(t);
  }
  const ticks = events.map((e, i) => {
    const t = el('div', `chrono-tick${e.precise ? '' : ' imprecise'}`, '<i></i>');
    t.style.left = `${pos(e)}%`;
    t.title = label(e);
    t.onclick = () => select(i);
    rail.appendChild(t);
    return t;
  });

  const detail = el('div', 'chrono-detail');
  const nav = el('div', 'chrono-nav');
  const prev = el('button', null, '← Earlier');
  const next = el('button', null, 'Later →');
  prev.onclick = () => select(Math.max(0, state.chrono - 1));
  next.onclick = () => select(Math.min(events.length - 1, state.chrono + 1));
  nav.appendChild(prev); nav.appendChild(next);

  function label(e) {
    return e.day ? `${e.day} ${MONTHS[(e.month || 1) - 1]} ${fmtYear(e.year)}`
      : e.month ? `${MONTHS[e.month - 1]} ${fmtYear(e.year)}` : fmtYear(e.year);
  }
  function select(i) {
    state.chrono = i;
    const e = events[i];
    ticks.forEach((t, k) => t.classList.toggle('on', k === i));
    detail.innerHTML = '';
    detail.appendChild(el('div', 'chrono-date', esc(label(e))));
    detail.appendChild(el('p', 'chrono-sentence', esc(e.sentence)));
    const src = el('div', 'chrono-src');
    src.innerHTML = `from <a href="#${esc(e.chapterId)}">${esc(e.chapterTitle)}</a> · ${i + 1} of ${events.length}`;
    detail.appendChild(src);
  }

  w.appendChild(rail);
  if (scale.compressed) {
    w.appendChild(el('div', 'chrono-src',
      `Axis compressed toward the denser periods — the shaded bands are equal ${bandUnit(scale.range)}-year spans, `
      + `drawn unequal. ${events.length} dated events across ${Math.round(scale.range).toLocaleString()} years.`));
  }
  w.appendChild(detail);
  w.appendChild(nav);
  select(0);
  return s;
}

// ---- chapters (the reading spine) ---------------------------------------

function renderChapters(_b, book) {
  const s = el('section', 'block');
  const w = el('div', 'wrap');

  if (book.lead?.html) {
    const lead = el('div', 'chapter');
    lead.id = 'lead';
    lead.dataset.title = 'Opening';
    lead.appendChild(el('div', 'chapter-num', 'Opening'));
    const prose = el('div', 'prose measure', book.lead.html);
    lead.appendChild(prose);
    w.appendChild(lead);
  }

  let n = 0;
  for (const c of book.chapters) {
    const isPart = c.words === 0;
    if (!isPart) n++;
    const node = el('div', `chapter lvl-${c.level}${isPart ? ' part' : ''}`);
    node.id = c.id;
    node.dataset.title = c.title;
    node.dataset.level = c.level;
    if (!isPart) node.appendChild(el('div', 'chapter-num', `Chapter ${n}`));
    node.appendChild(el('h2', null, esc(c.title)));

    const figs = c.figures || [];
    if (figs[0]) node.appendChild(plate(figs[0]));
    if (c.html) node.appendChild(el('div', 'prose measure', c.html));
    figs.slice(1).forEach((f) => node.appendChild(plate(f)));

    w.appendChild(node);
  }
  s.appendChild(w);
  return s;
}

function plate(f) {
  const fig = el('figure', `plate${(f.width || 0) > 600 ? ' wide' : ''}`);
  fig.appendChild(Object.assign(new Image(), { src: f.src, alt: f.alt || '', loading: 'lazy' }));
  if (f.caption) fig.appendChild(el('figcaption', null, esc(f.caption)));
  return fig;
}

// ---- shelf ---------------------------------------------------------------

function renderShelf(b) {
  const { s, w } = section(b);
  const row = el('div', 'shelf-row');
  for (const it of b.items) {
    const a = el('a', 'volume');
    a.href = bookHref(it.title);
    const art = el('div', 'volume-art');
    if (it.thumb) art.appendChild(Object.assign(new Image(), { src: it.thumb, alt: '', loading: 'lazy' }));
    a.appendChild(art);
    const body = el('div', 'volume-body');
    body.appendChild(el('div', 'volume-title', esc(it.label)));
    if (it.description) body.appendChild(el('div', 'volume-desc', esc(it.description)));
    a.appendChild(body);
    row.appendChild(a);
  }
  w.appendChild(row);
  return s;
}

// ---- notes ---------------------------------------------------------------

function renderNotes(b, book) {
  const { s, w } = section({ ...b, caption: `${b.count} references, carried over from the article and kept addressable.` });
  const ol = el('ol', 'notes-list');
  const show = (limit) => {
    ol.innerHTML = '';
    book.notes.slice(0, limit).forEach((n) => {
      const li = el('li', null, n.html);
      li.id = n.id;
      ol.appendChild(li);
    });
  };
  show(40);
  w.appendChild(ol);
  if (book.notes.length > 40) {
    const more = el('button', 'notes-more', `Show all ${book.notes.length} notes`);
    more.onclick = () => { show(book.notes.length); more.remove(); };
    w.appendChild(more);
  }
  return s;
}

// ---- colophon ------------------------------------------------------------

function colophon(book) {
  const s = el('section', 'block');
  const w = el('div', 'wrap');
  const c = el('div', 'colophon');
  const grid = el('div', 'colophon-grid');

  const provenance = el('div');
  provenance.appendChild(el('h4', null, 'Provenance'));
  provenance.innerHTML += `
    <p>Every word of prose here is Wikipedia's, reorganised but never rewritten.
    No language model was used to build this volume.</p>
    <p>Text: <a href="${esc(book.attribution.textLicenseUrl)}" target="_blank" rel="noopener">${esc(book.attribution.textLicense)}</a>.
    Media files carry their own licences on Wikimedia Commons.</p>
    <p><a href="${esc(book.attribution.article)}" target="_blank" rel="noopener">Source article</a> ·
    <a href="${esc(book.attribution.revision || book.attribution.article)}" target="_blank" rel="noopener">this revision</a> ·
    <a href="${esc(book.attribution.history)}" target="_blank" rel="noopener">authors</a>
    ${book.attribution.wikidata ? `· <a href="${esc(book.attribution.wikidata)}" target="_blank" rel="noopener">Wikidata</a>` : ''}</p>`;

  const build = el('div');
  build.appendChild(el('h4', null, 'How this was built'));
  const dl = el('dl');
  const st = book.stats;
  const rows = [
    ['archetype', `${book.archetype}${book.classPath?.length ? ` (via ${book.classPath.join(' → ')})` : ''}`],
    ['revision', String(book.revid)],
    ['words', fmt.format(st.words)],
    ['chapters', String(st.chapters)],
    ['links found', String(st.linksFound)],
    ['entities resolved', String(st.entitiesResolved)],
    ['places mapped', String(st.placesMapped)],
    ['chronology', `${st.chronologyEvents} dated events`],
    ['notes', String(st.notes)],
    ['plates', String(st.figures)],
    ['pageviews (60d)', st.pageviews60d != null ? fmt.format(st.pageviews60d) : '—'],
    ['build', `${st.servedFromCache ? 'cache hit' : `${fmt.format(st.buildMs)} ms cold`} · template v${st.templateVersion}`],
  ];
  for (const [k, v] of rows) { dl.appendChild(el('dt', null, esc(k))); dl.appendChild(el('dd', null, esc(v))); }
  build.appendChild(dl);

  grid.appendChild(provenance);
  grid.appendChild(build);
  c.appendChild(grid);
  w.appendChild(c);
  s.appendChild(w);
  return s;
}

// ---- table of contents + progress ---------------------------------------

function buildToc(book) {
  const toc = document.getElementById('toc');
  toc.innerHTML = '';
  const apparatus = book.blocks.filter((b) => b.type !== 'chapters' && b.title);

  if (apparatus.length) {
    toc.appendChild(el('div', 'toc-group', 'Apparatus'));
    apparatus.forEach((b, i) => {
      const a = el('a', null, esc(b.title));
      a.href = `#block-${i}`;
      a.onclick = (ev) => {
        ev.preventDefault();
        document.querySelectorAll('section.block')[book.blocks.indexOf(b)]?.scrollIntoView({ behavior: 'smooth' });
      };
      toc.appendChild(a);
    });
  }

  toc.appendChild(el('div', 'toc-group', 'Chapters'));
  const openingLink = el('a', 'lvl-1', 'Opening');
  openingLink.href = '#lead';
  toc.appendChild(openingLink);
  for (const c of book.chapters) {
    const a = el('a', `lvl-${c.level}`, esc(c.title));
    a.href = `#${c.id}`;
    a.dataset.for = c.id;
    toc.appendChild(a);
  }

  wireLanguages(book);

  const foot = document.getElementById('railFoot');
  foot.innerHTML = `<div class="badge">${esc(book.archetype)} template</div>
    <div>${fmt.format(book.stats.words)} words · ${book.stats.chapters} chapters · ${book.stats.notes} notes</div>
    <div style="margin-top:6px">Text CC BY-SA 4.0 · <a href="${esc(book.attribution.article)}" target="_blank" rel="noopener">Wikipedia</a></div>`;
}

// ---- what gets read aloud ------------------------------------------------
//
// The book, not the page: the spine's own prose in reading order, skipping the
// apparatus. Blocks are charts, maps and tables of numbers — a casualty scale
// read aloud as a list of figures is noise, and the chronology would repeat
// sentences the chapters already carry.
//
// Collected fresh at play time. The reader repaints when the apparatus lands,
// so a node list captured earlier would point at replaced elements.

function collectSpokenBook() {
  const out = [];
  const book = state.book;
  if (!book) return out;

  out.push({ text: book.title, label: 'Title', node: document.querySelector('.cover h1') });
  const sub = book.blocks?.find((b) => b.type === 'cover')?.subtitle;
  if (sub) out.push({ text: sub, label: 'Title', node: document.querySelector('.cover-sub') });

  for (const chapter of document.querySelectorAll('.chapter')) {
    const heading = chapter.querySelector('h2');
    // The lead has no heading of its own — it is labelled by its chapter-num
    // ("Opening"), and without this fallback its passages show a blank label.
    const name = heading?.textContent?.trim()
      || chapter.querySelector('.chapter-num')?.textContent?.trim()
      || '';
    if (name) out.push({ text: name, label: name, node: heading });

    for (const el of chapter.querySelectorAll('.prose > p, .prose > ul > li, .prose > ol > li, .prose > blockquote')) {
      const text = el.textContent.replace(/\s+/g, ' ').trim();
      // Reference markers read as bare numbers mid-sentence; the note text is
      // not part of the prose and should not interrupt it.
      if (text.length > 1) out.push({ text: stripMarkers(el), label: name, node: el });
    }
  }
  return out;
}

/** The element's text without its superscript reference markers. */
function stripMarkers(el) {
  const clone = el.cloneNode(true);
  clone.querySelectorAll('.wb-note').forEach((n) => n.remove());
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

// ---- language switcher ---------------------------------------------------
//
// The same subject, read from a different Wikipedia. Not a translation: each
// edition is its own article, written by different people at different lengths,
// so switching rebuilds the book from that edition's own text and its own title
// for the subject — "Japan" is "Japon" in French and "日本" in Japanese.

function wireLanguages(book) {
  const btn = document.getElementById('langBtn');
  const panel = document.getElementById('langPanel');
  if (!btn || state.langWired) return;
  state.langWired = true;

  btn.textContent = (book.lang || 'en').toUpperCase();
  btn.hidden = false;

  const close = () => {
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
  };

  btn.addEventListener('click', async (ev) => {
    ev.stopPropagation();
    if (!panel.hidden) return close();

    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');

    if (!state.languages) {
      panel.innerHTML = '<div class="lang-empty">Looking for other editions…</div>';
      try {
        const res = await fetch(
          `/api/languages?title=${encodeURIComponent(book.title)}&lang=${encodeURIComponent(book.lang || 'en')}`);
        state.languages = await res.json();
      } catch {
        panel.innerHTML = '<div class="lang-empty">Could not reach Wikipedia.</div>';
        return;
      }
    }
    renderLanguages(panel, state.languages, book);
  });

  document.addEventListener('click', (ev) => {
    if (!panel.hidden && !panel.contains(ev.target)) close();
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close();
  });
}

function renderLanguages(panel, data, book) {
  const list = data.languages || [];
  if (!list.length) {
    panel.innerHTML = '<div class="lang-empty">This article exists only on this Wikipedia.</div>';
    return;
  }

  const current = el('div', 'lang-current',
    `<b>${esc(data.current.autonym)}</b><span>reading now</span>`);

  const search = el('input', 'lang-search');
  search.type = 'search';
  search.placeholder = `Search ${list.length} editions`;
  search.setAttribute('aria-label', 'Search languages');

  const rows = el('div', 'lang-rows');
  const supported = list.filter((l) => l.supported);

  const draw = (items) => {
    rows.replaceChildren();
    let markedTail = false;
    for (const l of items) {
      // One divider, once, where the fully-supported editions end.
      if (!l.supported && !markedTail && supported.length && items === list) {
        rows.appendChild(el('div', 'lang-divider', 'Builds, but without a chronology'));
        markedTail = true;
      }
      const a = el('a', `lang-row${l.supported ? '' : ' partial'}`);
      a.href = l.href;
      // The edition's own title for the subject sits under its name — it is
      // what tells you that Japanese "Japan" is 日本, and that switching is not
      // a translation of this page but a move to a different article.
      a.innerHTML =
        `<span class="lang-code">${esc(l.lang)}</span>` +
        `<span class="lang-text">` +
        `<span class="lang-name">${esc(l.autonym)}</span>` +
        `<span class="lang-title">${esc(l.title)}</span>` +
        `</span>`;
      rows.appendChild(a);
    }
    if (!items.length) rows.appendChild(el('div', 'lang-empty', 'No edition by that name.'));
  };

  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    if (!q) return draw(list);
    draw(list.filter((l) =>
      l.autonym.toLowerCase().includes(q)
      || l.name.toLowerCase().includes(q)
      || l.lang.startsWith(q)
      || l.title.toLowerCase().includes(q)));
  });

  panel.replaceChildren(current, search, rows);
  draw(list);
  search.focus();
}

// Re-run on every paint: the table of contents and the section nodes both
// change when the apparatus arrives. The scroll handler is global and is only
// ever attached once; the observer is rebuilt and the old one disconnected.
function wireSpine() {
  const bar = document.getElementById('progress');
  const chapters = [...document.querySelectorAll('.chapter')];
  const links = new Map([...document.querySelectorAll('.toc a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));

  const onScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.width = `${Math.min(100, (scrollY / Math.max(1, max)) * 100)}%`;
  };
  if (!state.scrollWired) {
    addEventListener('scroll', onScroll, { passive: true });
    state.scrollWired = true;
  }
  onScroll();

  state.spineIO?.disconnect();
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.classList.remove('active'));
      const a = links.get(e.target.id);
      if (a) { a.classList.add('active'); a.scrollIntoView({ block: 'nearest' }); }
    }
  }, { rootMargin: '-12% 0px -78% 0px' });
  chapters.forEach((c) => io.observe(c));
  state.spineIO = io;
}

// ---- hovercards + note popovers -----------------------------------------

function place(card, target) {
  const r = target.getBoundingClientRect();
  card.hidden = false;
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let left = r.left + scrollX + r.width / 2 - cw / 2;
  left = Math.max(12, Math.min(left, scrollX + innerWidth - cw - 12));
  const above = r.top > ch + 16;
  card.style.left = `${left}px`;
  card.style.top = `${above ? r.top + scrollY - ch - 10 : r.bottom + scrollY + 10}px`;
}

function wireHovercards() {
  const card = document.getElementById('hovercard');
  let timer = null, current = null;

  const hide = () => { clearTimeout(timer); card.hidden = true; current = null; };

  document.addEventListener('mouseover', (ev) => {
    const link = ev.target.closest('.wb-link');
    if (!link) {
      if (!ev.target.closest('#hovercard')) hide();
      return;
    }
    if (link === current) return;
    clearTimeout(timer);
    current = link;
    timer = setTimeout(async () => {
      const title = link.dataset.title;
      let data = state.summaries.get(title);
      if (!data) {
        try {
          const r = await fetch(`/api/summary/${encodeURIComponent(title)}?lang=${encodeURIComponent(state.lang || 'en')}`);
          data = r.ok ? await r.json() : { title: title.replace(/_/g, ' '), extract: 'No summary available.' };
        } catch { data = { title: title.replace(/_/g, ' '), extract: 'Offline.' }; }
        state.summaries.set(title, data);
      }
      if (current !== link) return;
      card.innerHTML =
        (data.thumbnail ? `<img src="${esc(data.thumbnail)}" alt="">` : '') +
        `<div class="hc-body">
           <div class="hc-title">${esc(data.title)}</div>
           ${data.description ? `<div class="hc-desc">${esc(data.description)}</div>` : ''}
           <div>${esc((data.extract || '').slice(0, 260))}${(data.extract || '').length > 260 ? '…' : ''}</div>
           <div class="hc-actions">
             <a href="${bookHref(title)}">Open as a book →</a>
           </div>
         </div>`;
      place(card, link);
    }, 200);
  });

  document.addEventListener('click', (ev) => {
    const link = ev.target.closest('.wb-link');
    if (link) { ev.preventDefault(); stopVoice(); location.href = bookHref(link.dataset.title); }
  });
  addEventListener('scroll', hide, { passive: true });
}

function wireNotes() {
  const card = document.getElementById('notecard');
  document.addEventListener('click', (ev) => {
    const mark = ev.target.closest('.wb-note');
    if (!mark) { if (!ev.target.closest('#notecard')) card.hidden = true; return; }
    ev.preventDefault();
    const note = state.notes.get(mark.dataset.note);
    card.innerHTML = note ? note.html : 'Note not found.';
    card.querySelectorAll('a').forEach((a) => { a.target = '_blank'; a.rel = 'noopener noreferrer'; });
    place(card, mark);
  });
  addEventListener('scroll', () => { card.hidden = true; }, { passive: true });
}
