// Atlas — client renderer.
//
// Same contract as the book reader: the server decides which blocks exist, this
// file only knows how to draw each kind. The chrome (rail, theme, voice) is
// shared, so an atlas is a different kind of volume in the same room.

import { wireThemeToggle } from '/theme.js';
import { wireVoice } from '/voice.js';

const el = (tag, cls, html) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (html != null) n.innerHTML = html;
  return n;
};
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const fmt = new Intl.NumberFormat('en-US');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

const state = { atlas: null, filter: { chain: null, year: null, status: null, category: null } };

boot();

async function boot() {
  // Two forms: /atlas/<owner>/<repo> for a repository, /atlas/<name> for a
  // named corpus whose source is not GitHub.
  const parts = location.pathname.replace(/^\/atlas\//, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) { location.href = '/'; return; }
  const label = parts.join('/');
  document.getElementById('binderTitle').textContent = label;

  try {
    const res = await fetch(`/api/atlas/${parts.map(encodeURIComponent).join('/')}`);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    state.atlas = await res.json();
    document.title = `${state.atlas.title} — Atlas`;
    render();
  } catch (err) {
    document.getElementById('atlas').innerHTML =
      `<div class="binder"><div class="binder-inner">
         <div class="binder-eyebrow">Could not survey</div>
         <h1 class="binder-title">${esc(label)}</h1>
         <p class="binder-foot">${esc(err.message)}</p>
       </div></div>`;
  }
}

function render() {
  const a = state.atlas;
  const root = document.getElementById('atlas');
  const nodes = [cover(a)];

  if (a.ledger) {
    nodes.push(tally(a), cadence(a), chains(a), sources(a), entries(a));
  }
  if (a.kind === 'catalogue') {
    nodes.push(catTally(a), lifecycle(a), matrix(a), numberSpace(a), proposers(a), proposals(a));
  }
  if (a.chapters?.length) nodes.push(chapters(a));
  nodes.push(colophon(a));

  root.replaceChildren(...nodes.filter(Boolean));
  buildToc(a);
  wireSpine();
  wireThemeToggle(document.getElementById('themeBtn'));
  wireVoice(document.getElementById('voiceBtn'), { collect: collectSpoken, lang: 'en' });
  document.getElementById('railToggle').onclick =
    () => document.getElementById('rail').classList.toggle('open');
}

function section(title, caption, cls = '') {
  const s = el('section', `block ${cls}`);
  const w = el('div', 'wrap');
  if (title) w.appendChild(el('h2', `block-title${caption ? '' : ' solo'}`, esc(title)));
  if (caption) w.appendChild(el('p', 'block-caption', caption));
  s.appendChild(w);
  s.dataset.title = title || '';
  return { s, w };
}

// ---- cover ---------------------------------------------------------------

function cover(a) {
  const s = el('section', 'cover atlas-cover');
  const inner = el('div', 'cover-inner');
  inner.appendChild(el('div', 'cover-eyebrow',
    a.kind === 'catalogue' ? `catalogue · ${esc(a.sourceLabel)}` : `${a.kind} · a GitHub atlas`));
  inner.appendChild(el('h1', null, esc(a.title)));
  if (a.description) inner.appendChild(el('p', 'cover-sub', esc(a.description)));

  const facts = a.kind === 'catalogue' ? [
    { label: 'Proposals', value: fmt.format(a.stats.count) },
    { label: 'Final', value: String(a.statuses.find((s2) => s2.name === 'Final')?.count ?? 0) },
    { label: 'Stagnant', value: String(a.statuses.find((s2) => s2.name === 'Stagnant')?.count ?? 0) },
    { label: 'Requests', value: String(a.stats.requests) },
  ] : [
    a.ledger && { label: 'Entries', value: fmt.format(a.ledger.parsed) },
    a.ledger?.span && { label: 'Span', value: `${a.ledger.span.from}–${a.ledger.span.to}` },
    { label: 'Stars', value: fmt.format(a.stars) },
    a.license && { label: 'Licence', value: a.license },
  ].filter(Boolean);

  const dl = el('dl', 'cover-facts');
  for (const f of facts) {
    const d = el('div', 'cover-fact');
    d.appendChild(el('dt', null, esc(f.label)));
    d.appendChild(el('dd', null, esc(f.value)));
    dl.appendChild(d);
  }
  inner.appendChild(dl);

  if (a.topics?.length) {
    const chips = el('div', 'side-parties');
    a.topics.forEach((t) => chips.appendChild(el('span', 'chip', esc(t))));
    inner.appendChild(chips);
  }
  s.appendChild(inner);
  return s;
}

// ---- tally ---------------------------------------------------------------

function tally(a) {
  const { s, w } = section('By the Numbers',
    `Every figure here is counted from the repository's own list — `
    + `${fmt.format(a.ledger.parsed)} of ${fmt.format(a.ledger.considered)} entries parsed.`);
  const stats = [
    { label: 'Entries', value: fmt.format(a.ledger.parsed) },
    { label: 'Chains', value: String(a.ledger.chains.length) },
    { label: 'Years', value: `${a.ledger.span.to - a.ledger.span.from + 1}` },
    { label: 'Sources', value: String(a.ledger.sources.length) },
  ];
  const dl = el('dl', 'cover-facts');
  for (const st of stats) {
    const d = el('div', 'cover-fact');
    d.appendChild(el('dt', null, esc(st.label)));
    d.appendChild(el('dd', null, esc(st.value)));
    dl.appendChild(d);
  }
  w.appendChild(dl);
  return s;
}

// ---- cadence -------------------------------------------------------------

function cadence(a) {
  const { s, w } = section('Cadence',
    'One bar per year, including the silent ones — a gap is a finding, not a missing column.');
  const peak = Math.max(...a.ledger.cadence.map((c) => c.count), 1);

  const chart = el('div', 'cadence');
  for (const c of a.ledger.cadence) {
    const col = el('button', `cadence-col${state.filter.year === c.year ? ' on' : ''}`);
    col.title = `${c.year}: ${c.count}`;
    const bar = el('div', 'cadence-bar');
    bar.style.height = `${Math.round((c.count / peak) * 100)}%`;
    if (!c.count) bar.classList.add('empty');
    col.appendChild(el('span', 'cadence-num', c.count ? String(c.count) : ''));
    col.appendChild(bar);
    col.appendChild(el('span', 'cadence-year', String(c.year)));
    col.onclick = () => {
      state.filter.year = state.filter.year === c.year ? null : c.year;
      redrawEntries();
    };
    chart.appendChild(col);
  }
  w.appendChild(chart);
  return s;
}

// ---- chains --------------------------------------------------------------

function chains(a) {
  const { s, w } = section('Where',
    'The chain is never stated in the list. It is read from the block explorer each entry links to '
    + '— <code>etherscan.io</code> means Ethereum as surely as a coordinate means a place.');
  const peak = Math.max(...a.ledger.chains.map((c) => c.count), 1);

  const rows = el('div', 'bars');
  for (const c of a.ledger.chains) {
    const row = el('button', `bar-row${state.filter.chain === c.name ? ' on' : ''}`);
    row.appendChild(el('span', 'bar-name', esc(c.name)));
    const track = el('span', 'bar-track');
    const fill = el('span', 'bar-fill');
    fill.style.width = `${(c.count / peak) * 100}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('span', 'bar-num', String(c.count)));
    row.onclick = () => {
      state.filter.chain = state.filter.chain === c.name ? null : c.name;
      redrawEntries();
    };
    rows.appendChild(row);
  }
  w.appendChild(rows);
  return s;
}

// ---- sources -------------------------------------------------------------

function sources(a) {
  const top = a.ledger.sources.slice(0, 14);
  if (!top.length) return null;
  const { s, w } = section('Who Wrote It Down',
    'The host of each write-up, which is a rough map of who does incident analysis in this field.');
  const chips = el('div', 'side-parties');
  for (const src of top) {
    chips.appendChild(el('span', 'chip', `${esc(src.name)} <b>${src.count}</b>`));
  }
  w.appendChild(chips);
  return s;
}

// ---- entries -------------------------------------------------------------

function entries(a) {
  const { s, w } = section('The Ledger', '');
  const note = el('p', 'block-caption');
  note.id = 'entryNote';
  w.appendChild(note);

  const list = el('div', 'entries');
  list.id = 'entryList';
  w.appendChild(list);
  queueMicrotask(redrawEntries);
  return s;
}

function matching() {
  const { chain, year } = state.filter;
  return state.atlas.ledger.entries.filter((e) =>
    (!chain || e.chains.includes(chain) || (chain === 'unattributed' && !e.chains.length))
    && (!year || e.date.year === year));
}

function redrawEntries() {
  const list = document.getElementById('entryList');
  const note = document.getElementById('entryNote');
  if (!list) return;

  const rows = matching();
  const { chain, year } = state.filter;
  const filters = [chain, year].filter(Boolean);

  note.innerHTML = filters.length
    ? `Showing ${fmt.format(rows.length)} of ${fmt.format(state.atlas.ledger.parsed)} — `
      + `${filters.map((f) => `<b>${esc(String(f))}</b>`).join(' · ')} `
      + `<button class="raw-toggle" id="clearFilter">clear</button>`
    : `${fmt.format(rows.length)} entries, oldest first. Every link goes to the source, not to us.`;

  const clear = document.getElementById('clearFilter');
  if (clear) clear.onclick = () => { state.filter = { chain: null, year: null }; refreshFacets(); };

  list.replaceChildren(...rows.map(entryRow));
}

function refreshFacets() {
  // Facet buttons carry their own selected state, so redraw the whole atlas
  // body rather than reaching into each one.
  render();
}

function entryRow(e) {
  const row = el('div', 'entry');
  const d = `${e.date.day} ${MONTHS[e.date.month - 1]} ${e.date.year}`;

  row.appendChild(el('div', 'entry-date', esc(d)));

  const body = el('div', 'entry-body');
  const head = el('div', 'entry-head');
  const link = el('a', 'entry-name', esc(e.name));
  link.href = e.url;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  head.appendChild(link);
  if (e.chain) head.appendChild(el('span', 'entry-chain', esc(e.chain)));
  body.appendChild(head);

  if (e.artefacts.length) {
    const arts = el('div', 'entry-arts');
    for (const art of e.artefacts) {
      const a = el('a', 'entry-art', esc(art.label || 'link'));
      a.href = art.href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      arts.appendChild(a);
    }
    body.appendChild(arts);
  }
  if (e.source) body.appendChild(el('div', 'entry-source', esc(e.source)));

  row.appendChild(body);
  return row;
}

// ---- catalogue: the EIP shape --------------------------------------------

function catTally(a) {
  const { s, w } = section('By the Numbers',
    `${fmt.format(a.stats.count)} proposals, read from ${esc(a.sourceLabel)} in `
    + `${a.stats.requests} requests — the corpus is published twice, grouped by status and `
    + `grouped by category, so joining the two on the proposal number costs seven pages `
    + `instead of ${fmt.format(a.stats.count)}.`);
  const stats = [
    { label: 'Proposals', value: fmt.format(a.stats.count) },
    { label: 'Statuses', value: String(a.stats.statuses) },
    { label: 'Categories', value: String(a.stats.categories) },
    { label: 'Uncategorised', value: String(a.stats.uncategorised) },
  ];
  const dl = el('dl', 'cover-facts');
  for (const st of stats) {
    const d = el('div', 'cover-fact');
    d.appendChild(el('dt', null, esc(st.label)));
    d.appendChild(el('dd', null, esc(st.value)));
    dl.appendChild(d);
  }
  w.appendChild(dl);
  return s;
}

function lifecycle(a) {
  const { s, w } = section('The Lifecycle',
    'In the order a proposal travels it, not by size — sorting these by count would put '
    + 'Stagnant first and hide the shape of the process.');
  const peak = Math.max(...a.statuses.map((x) => x.count), 1);
  const rows = el('div', 'bars');
  for (const st of a.statuses) {
    const row = el('button', `bar-row${state.filter.status === st.name ? ' on' : ''}`);
    row.appendChild(el('span', 'bar-name', esc(st.name)));
    const track = el('span', 'bar-track');
    const fill = el('span', 'bar-fill');
    fill.style.width = `${(st.count / peak) * 100}%`;
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('span', 'bar-num', String(st.count)));
    row.onclick = () => {
      state.filter.status = state.filter.status === st.name ? null : st.name;
      render();
    };
    rows.appendChild(row);
  }
  w.appendChild(rows);
  return s;
}

/** The pair is the point: how far each kind of proposal actually gets. */
function matrix(a) {
  const { s, w } = section('Status by Category',
    'Every proposal counted once. The column is what it touches, the row is how far it got.');

  const peak = Math.max(...a.matrix.flatMap((r) => r.cells.map((c) => c.count)), 1);
  const grid = el('div', 'matrix');
  grid.style.gridTemplateColumns = `110px repeat(${a.categories.length}, 1fr)`;

  grid.appendChild(el('div', 'matrix-corner'));
  for (const c of a.categories) grid.appendChild(el('div', 'matrix-head', esc(c.name)));

  for (const row of a.matrix) {
    grid.appendChild(el('div', 'matrix-row-head', esc(row.status)));
    for (const cell of row.cells) {
      const on = state.filter.status === row.status && state.filter.category === cell.category;
      const box = el('button', `matrix-cell${on ? ' on' : ''}${cell.count ? '' : ' zero'}`);
      box.style.setProperty('--w', String(cell.count / peak));
      box.textContent = cell.count || '';
      box.title = `${row.status} · ${cell.category}: ${cell.count}`;
      box.onclick = () => {
        state.filter.status = on ? null : row.status;
        state.filter.category = on ? null : cell.category;
        render();
      };
      grid.appendChild(box);
    }
  }
  w.appendChild(grid);
  return s;
}

function numberSpace(a) {
  const { s, w } = section('Number Space',
    'Proposal numbers are handed out roughly in order, so this reads as a rough timeline — '
    + 'rough being the operative word. It is number space, not time, and is labelled as such.');
  const peak = Math.max(...a.numberSpace.map((b) => b.count), 1);
  const chart = el('div', 'cadence');
  for (const b of a.numberSpace) {
    const col = el('div', 'cadence-col');
    col.title = `${b.from}–${b.to}: ${b.count}`;
    const bar = el('div', 'cadence-bar');
    bar.style.height = `${Math.round((b.count / peak) * 100)}%`;
    if (!b.count) bar.classList.add('empty');
    col.appendChild(el('span', 'cadence-num', b.count ? String(b.count) : ''));
    col.appendChild(bar);
    col.appendChild(el('span', 'cadence-year', String(b.from)));
    chart.appendChild(col);
  }
  w.appendChild(chart);
  return s;
}

function proposers(a) {
  if (!a.authors.length) return null;
  const { s, w } = section('Who Proposes',
    'Counted from the GitHub handles in each author line — the only part of an author '
    + 'string that parses cleanly, so names without a handle are not counted here.');
  const chips = el('div', 'side-parties');
  for (const p of a.authors) chips.appendChild(el('span', 'chip', `@${esc(p.name)} <b>${p.count}</b>`));
  w.appendChild(chips);
  return s;
}

function proposals(a) {
  const { s, w } = section('The Catalogue', '');
  const note = el('p', 'block-caption');
  note.id = 'entryNote';
  w.appendChild(note);

  const { status, category } = state.filter;
  const rows = a.eips.filter((e) =>
    (!status || e.status === status) && (!category || (e.category || 'Uncategorised') === category));

  const filters = [status, category].filter(Boolean);
  note.innerHTML = filters.length
    ? `Showing ${fmt.format(rows.length)} of ${fmt.format(a.eips.length)} — `
      + `${filters.map((f) => `<b>${esc(f)}</b>`).join(' · ')} `
      + `<button class="raw-toggle" id="clearFilter">clear</button>`
    : `${fmt.format(rows.length)} proposals. Pick a bar or a cell above to narrow it.`;

  const list = el('div', 'entries');
  // A thousand rows is a scroll, not a page; the filters above are the way in.
  for (const e of rows.slice(0, 300)) list.appendChild(proposalRow(e));
  w.appendChild(list);

  if (rows.length > 300) {
    w.appendChild(el('p', 'block-caption',
      `Showing the first 300 of ${fmt.format(rows.length)} — narrow by status or category to see the rest.`));
  }

  queueMicrotask(() => {
    const clear = document.getElementById('clearFilter');
    if (clear) clear.onclick = () => { state.filter = {}; render(); };
  });
  return s;
}

function proposalRow(e) {
  const row = el('div', 'entry');
  row.appendChild(el('div', 'entry-date', `EIP-${e.num}`));

  const body = el('div', 'entry-body');
  const head = el('div', 'entry-head');
  const link = el('a', 'entry-name', esc(e.title));
  link.href = e.href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  head.appendChild(link);
  if (e.category) head.appendChild(el('span', 'entry-chain', esc(e.category)));
  head.appendChild(el('span', 'entry-status', esc(e.status)));
  body.appendChild(head);
  if (e.authors) body.appendChild(el('div', 'entry-source', esc(e.authors.slice(0, 120))));
  row.appendChild(body);
  return row;
}

// ---- prose ---------------------------------------------------------------

function chapters(a) {
  const s = el('section', 'block');
  const w = el('div', 'wrap');
  for (const c of a.chapters || []) {
    const node = el('div', `chapter lvl-${c.level}`);
    node.id = c.id;
    node.dataset.title = c.title;
    node.appendChild(el('h2', null, esc(c.title)));
    node.appendChild(el('div', 'prose measure', c.html));
    w.appendChild(node);
  }
  s.appendChild(w);
  s.dataset.title = 'The README';
  return s;
}

// ---- colophon ------------------------------------------------------------

function colophon(a) {
  const s = el('section', 'block');
  const w = el('div', 'wrap');
  const c = el('div', 'colophon');
  const grid = el('div', 'colophon-grid');

  const prov = el('div');
  prov.appendChild(el('h4', null, 'Provenance'));
  prov.innerHTML += a.kind === 'catalogue'
    ? `<p>Read from <a href="${esc(a.source)}" target="_blank" rel="noopener">${esc(a.sourceLabel)}</a>,
       which publishes the corpus grouped by status and again by category. Joining those on the
       proposal number is where every figure here comes from — nothing is inferred and no language
       model is involved.</p>
       <p>Each proposal links to its own page. Titles and author lines are the corpus authors'.</p>`
    : `<p>Everything here is read from <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.fullName)}</a>'s
       own README, rendered by GitHub and parsed — never rewritten. No language model is involved.</p>
       <p>The repository's content is its authors'${a.license ? `, under <b>${esc(a.license)}</b>` : ''}.
       Last pushed ${esc((a.pushedAt || '').slice(0, 10))}.</p>`;

  const build = el('div');
  build.appendChild(el('h4', null, 'How this was built'));
  const dl = el('dl');
  const rows = a.kind === 'catalogue' ? [
    ['shape', a.kind],
    ['proposals', fmt.format(a.stats.count)],
    ['uncategorised', String(a.stats.uncategorised)],
    ['statuses × categories', `${a.stats.statuses} × ${a.stats.categories}`],
    ['upstream requests', String(a.stats.requests)],
    ['build', `${a.stats.servedFromCache ? 'cache hit' : `${fmt.format(a.stats.buildMs)} ms`} · catalogue v${a.stats.catalogueVersion}`],
  ] : [
    ['shape', a.kind],
    ['entries parsed', a.ledger ? `${a.ledger.parsed} of ${a.ledger.considered}` : '—'],
    ['chains', String(a.stats.chains)],
    ['sources', String(a.stats.sources)],
    ['README sections', String(a.stats.chapters)],
    ['build', `${a.stats.servedFromCache ? 'cache hit' : `${fmt.format(a.stats.buildMs)} ms`} · atlas v${a.stats.atlasVersion}`],
  ];
  for (const [k, v] of rows) { dl.appendChild(el('dt', null, esc(k))); dl.appendChild(el('dd', null, esc(v))); }
  build.appendChild(dl);

  grid.appendChild(prov);
  grid.appendChild(build);
  c.appendChild(grid);
  w.appendChild(c);
  s.appendChild(w);
  return s;
}

// ---- rail ----------------------------------------------------------------

function buildToc(a) {
  const toc = document.getElementById('toc');
  toc.innerHTML = '';
  const blocks = [...document.querySelectorAll('#atlas > section')].filter((s) => s.dataset.title);

  toc.appendChild(el('div', 'toc-group', 'Atlas'));
  blocks.forEach((b) => {
    const link = el('a', null, esc(b.dataset.title));
    link.href = '#';
    link.onclick = (ev) => { ev.preventDefault(); b.scrollIntoView({ behavior: 'smooth' }); };
    toc.appendChild(link);
  });

  const foot = document.getElementById('railFoot');
  const where = a.kind === 'catalogue'
    ? `<a href="${esc(a.source)}" target="_blank" rel="noopener">${esc(a.sourceLabel)}</a>`
    : `<a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.fullName)}</a>`;
  const size = a.kind === 'catalogue'
    ? `${fmt.format(a.stats.count)} proposals · ${a.stats.categories} categories`
    : (a.ledger ? `${fmt.format(a.ledger.parsed)} entries · ${a.stats.chains} chains` : `${a.stats.chapters} sections`);
  foot.innerHTML = `<div class="badge">${esc(a.kind)} atlas</div>
    <div>${size}</div>
    <div style="margin-top:6px">${where}</div>`;
}

function wireSpine() {
  const bar = document.getElementById('progress');
  const onScroll = () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    bar.style.width = `${Math.min(100, (scrollY / Math.max(1, max)) * 100)}%`;
  };
  addEventListener('scroll', onScroll, { passive: true });
  onScroll();
}

// ---- read aloud ----------------------------------------------------------

function collectSpoken() {
  const a = state.atlas;
  const out = [{ text: a.title, label: 'Title' }];
  if (a.description) out.push({ text: a.description, label: 'Title' });

  if (a.ledger) {
    out.push({
      text: `${a.ledger.parsed} entries, from ${a.ledger.span.from} to ${a.ledger.span.to}, `
        + `across ${a.ledger.chains.length} chains.`,
      label: 'By the Numbers',
    });
    for (const c of a.ledger.chains.slice(0, 8)) {
      out.push({ text: `${c.name}: ${c.count}.`, label: 'Where' });
    }
  }

  if (a.kind === 'catalogue') {
    out.push({ text: `${a.stats.count} proposals, in ${a.stats.categories} categories.`, label: 'By the Numbers' });
    for (const st of a.statuses) out.push({ text: `${st.name}: ${st.count}.`, label: 'The Lifecycle' });
  }

  for (const c of a.chapters || []) {
    out.push({ text: c.title, label: c.title, node: document.getElementById(c.id)?.querySelector('h2') });
    const node = document.getElementById(c.id);
    for (const p of node?.querySelectorAll('.prose > p, .prose > blockquote, .prose > ul > li') || []) {
      const t = p.textContent.replace(/\s+/g, ' ').trim();
      if (t.length > 1) out.push({ text: t, label: c.title, node: p });
    }
  }
  return out;
}
