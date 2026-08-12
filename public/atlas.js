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

const state = { atlas: null, filter: { chain: null, year: null } };

boot();

async function boot() {
  const m = /^\/atlas\/([^/]+)\/([^/]+)/.exec(location.pathname);
  if (!m) { location.href = '/'; return; }
  const [, owner, repo] = m.map(decodeURIComponent);
  document.getElementById('binderTitle').textContent = `${owner}/${repo}`;

  try {
    const res = await fetch(`/api/atlas/${owner}/${repo}`);
    if (!res.ok) throw new Error((await res.json()).error || res.statusText);
    state.atlas = await res.json();
    document.title = `${state.atlas.title} — Atlas`;
    render();
  } catch (err) {
    document.getElementById('atlas').innerHTML =
      `<div class="binder"><div class="binder-inner">
         <div class="binder-eyebrow">Could not survey</div>
         <h1 class="binder-title">${esc(owner)}/${esc(repo)}</h1>
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
  if (a.chapters.length) nodes.push(chapters(a));
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
    `${a.kind === 'ledger' ? 'ledger' : 'repository'} · a GitHub atlas`));
  inner.appendChild(el('h1', null, esc(a.title)));
  if (a.description) inner.appendChild(el('p', 'cover-sub', esc(a.description)));

  const facts = [
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

  if (a.topics.length) {
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

// ---- prose ---------------------------------------------------------------

function chapters(a) {
  const s = el('section', 'block');
  const w = el('div', 'wrap');
  for (const c of a.chapters) {
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
  prov.innerHTML += `
    <p>Everything here is read from <a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.fullName)}</a>'s
    own README, rendered by GitHub and parsed — never rewritten. No language model is involved.</p>
    <p>The repository's content is its authors'${a.license ? `, under <b>${esc(a.license)}</b>` : ''}.
    Last pushed ${esc((a.pushedAt || '').slice(0, 10))}.</p>`;

  const build = el('div');
  build.appendChild(el('h4', null, 'How this was built'));
  const dl = el('dl');
  const rows = [
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
  foot.innerHTML = `<div class="badge">${esc(a.kind)} atlas</div>
    <div>${a.ledger ? `${fmt.format(a.ledger.parsed)} entries · ${a.stats.chains} chains` : `${a.stats.chapters} sections`}</div>
    <div style="margin-top:6px"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.fullName)}</a></div>`;
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

  for (const c of a.chapters) {
    out.push({ text: c.title, label: c.title, node: document.getElementById(c.id)?.querySelector('h2') });
    const node = document.getElementById(c.id);
    for (const p of node?.querySelectorAll('.prose > p, .prose > blockquote, .prose > ul > li') || []) {
      const t = p.textContent.replace(/\s+/g, ' ').trim();
      if (t.length > 1) out.push({ text: t, label: c.title, node: p });
    }
  }
  return out;
}
