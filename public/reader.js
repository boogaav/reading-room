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

const state = { book: null, notes: new Map(), summaries: new Map(), chrono: 0 };

// ---- boot ----------------------------------------------------------------

boot();

async function boot() {
  const m = /^\/read\/(.+)$/.exec(location.pathname);
  const title = m ? decodeURIComponent(m[1]) : 'Battle_of_Stalingrad';
  document.getElementById('loadingText').textContent = `Binding “${title.replace(/_/g, ' ')}”…`;

  try {
    const res = await fetch(`/api/book/${encodeURIComponent(title)}`);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    const book = await res.json();
    state.book = book;
    for (const n of book.notes) state.notes.set(n.id, n);
    document.title = `${book.title} — Reading Room`;
    render(book);
  } catch (err) {
    document.getElementById('book').innerHTML =
      `<div class="loading"><div class="loading-mark">✕</div><p>Could not bind this volume.</p>
       <p class="loading-sub">${esc(err.message)}</p></div>`;
  }
}

// ---- render --------------------------------------------------------------

function render(book) {
  const root = document.getElementById('book');
  root.innerHTML = '';

  for (const block of book.blocks) {
    const node = RENDER[block.type]?.(block, book);
    if (node) root.appendChild(node);
  }
  root.appendChild(colophon(book));

  buildToc(book);
  wireSpine();
  wireHovercards();
  wireNotes();
  document.getElementById('railToggle').onclick =
    () => document.getElementById('rail').classList.toggle('open');
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
  card.onclick = () => { location.href = `/read/${encodeURIComponent(p.title.replace(/ /g, '_'))}`; };
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

// ---- map -----------------------------------------------------------------

function renderMap(b) {
  const { s, w } = section(b);
  const shell = el('div', 'map-shell');
  const mount = el('div'); mount.id = 'map';
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
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
      subdomains: 'abcd', maxZoom: 18,
      attribution: '&copy; OpenStreetMap contributors &copy; CARTO',
    }).addTo(map);

    const near = [];
    const focus = b.focus || b.points[0];
    for (const p of b.points) {
      const marker = L.marker([p.lat, p.lon], {
        icon: L.divIcon({ className: '', html: `<div class="pin${p.primary ? ' primary' : ''}"></div>`, iconSize: [12, 12] }),
      }).addTo(map);
      marker.bindPopup(
        `<strong>${esc(p.label)}</strong>${p.description ? `<br>${esc(p.description)}` : ''}` +
        `<br><a href="/read/${encodeURIComponent(p.title.replace(/ /g, '_'))}">Open as a book →</a>`);
      // Tight enough to frame the actual theatre, not the whole continent.
      if (haversine(focus, p) < 1000) near.push([p.lat, p.lon]);
    }

    const all = b.points.map((p) => [p.lat, p.lon]);
    const fit = (pts) => {
      map.invalidateSize();
      map.fitBounds(L.latLngBounds(pts).pad(0.18), { maxZoom: b.zoom || 8 });
    };
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

  const io = new IntersectionObserver((entries, obs) => {
    if (!entries.some((e) => e.isIntersecting)) return;
    obs.disconnect();
    requestAnimationFrame(init);
  }, { rootMargin: '400px' });
  io.observe(shell);

  return s;
}

function haversine(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---- chronology ----------------------------------------------------------

function renderChronology(b) {
  const { s, w } = section(b);
  const events = b.events;
  // The axis spans the events we actually have, not the padded search window —
  // otherwise half the rail is empty on a six-month battle.
  const at = (e) => e.year + ((e.month || 1) - 1) / 12 + ((e.day || 1) - 1) / 365;
  const span = events.map(at);
  const from = Math.min(...span);
  const to = Math.max(...span);
  const pos = (e) => Math.max(0, Math.min(100, ((at(e) - from) / Math.max(0.001, to - from)) * 100));

  const rail = el('div', 'chrono-rail');
  rail.appendChild(el('div', 'chrono-axis'));
  // Year gridlines when the span is long, month gridlines when it is short.
  const marks = [];
  if (to - from > 2.5) {
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
    return e.day ? `${e.day} ${MONTHS[(e.month || 1) - 1]} ${e.year}`
      : e.month ? `${MONTHS[e.month - 1]} ${e.year}` : String(e.year);
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
    a.href = `/read/${encodeURIComponent(it.title.replace(/ /g, '_'))}`;
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

  const foot = document.getElementById('railFoot');
  foot.innerHTML = `<div class="badge">${esc(book.archetype)} template</div>
    <div>${fmt.format(book.stats.words)} words · ${book.stats.chapters} chapters · ${book.stats.notes} notes</div>
    <div style="margin-top:6px">Text CC BY-SA 4.0 · <a href="${esc(book.attribution.article)}" target="_blank" rel="noopener">Wikipedia</a></div>`;
}

function wireSpine() {
  const bar = document.getElementById('progress');
  const chapters = [...document.querySelectorAll('.chapter')];
  const links = new Map([...document.querySelectorAll('.toc a[href^="#"]')].map((a) => [a.getAttribute('href').slice(1), a]));

  const onScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.width = `${Math.min(100, (scrollY / Math.max(1, max)) * 100)}%`;
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      links.forEach((a) => a.classList.remove('active'));
      const a = links.get(e.target.id);
      if (a) { a.classList.add('active'); a.scrollIntoView({ block: 'nearest' }); }
    }
  }, { rootMargin: '-12% 0px -78% 0px' });
  chapters.forEach((c) => io.observe(c));
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
          const r = await fetch(`/api/summary/${encodeURIComponent(title)}`);
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
             <a href="/read/${encodeURIComponent(title.replace(/ /g, '_'))}">Open as a book →</a>
           </div>
         </div>`;
      place(card, link);
    }, 200);
  });

  document.addEventListener('click', (ev) => {
    const link = ev.target.closest('.wb-link');
    if (link) { ev.preventDefault(); location.href = `/read/${encodeURIComponent(link.dataset.title.replace(/ /g, '_'))}`; }
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
