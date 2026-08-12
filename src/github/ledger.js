// The `ledger` shape: a repository whose README *is* a dataset.
//
// pcaversaccio/reentrancy-attacks is the canonical example — eighty-odd list
// items, every one of them the same sentence:
//
//   [<name>](<post-mortem>) – <D Month YYYY> | [Victim contract](<explorer>),
//   [Exploit contract](<explorer>), [Exploit transaction](<explorer>)
//
// That is structure. It is not marked up as structure, but it is as regular as
// an infobox, and the same rule applies as everywhere else in this project: if
// the shape is really there, parse it; if it is not, say so and fall back.
//
// The chain each incident happened on is never stated. It does not have to be —
// the block explorer linked is the chain. etherscan.io means Ethereum the same
// way P625 means a coordinate.

import { load } from 'cheerio';

// Longest host first: optimistic.etherscan.io must not match as etherscan.io.
const EXPLORERS = [
  ['optimistic.etherscan.io', 'Optimism'],
  ['era.zksync.network', 'zkSync Era'],
  ['explorer.zksync.io', 'zkSync Era'],
  ['explorer.fuse.io', 'Fuse'],
  ['etherscan.io', 'Ethereum'],
  ['bscscan.com', 'BNB Chain'],
  ['arbiscan.io', 'Arbitrum'],
  ['polygonscan.com', 'Polygon'],
  ['gnosisscan.io', 'Gnosis'],
  ['snowtrace.io', 'Avalanche'],
  ['snowscan.xyz', 'Avalanche'],
  ['basescan.org', 'Base'],
  ['ftmscan.com', 'Fantom'],
  ['nearblocks.io', 'NEAR'],
  ['mantlescan.xyz', 'Mantle'],
  ['celoscan.io', 'Celo'],
  ['cronoscan.com', 'Cronos'],
  ['moonscan.io', 'Moonbeam'],
  ['lineascan.build', 'Linea'],
  ['scrollscan.com', 'Scroll'],
  ['blastscan.io', 'Blast'],
  ['blockscout.com', 'Blockscout chain'],
  ['tronscan.org', 'Tron'],
  ['solscan.io', 'Solana'],
];

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const MONTH_IX = new Map(MONTHS.map((m, i) => [m, i + 1]));

// "17 June 2016" and "June 17, 2016" both occur in the wild.
const DMY = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS.join('|')})\\s+(\\d{4})\\b`, 'i');
const MDY = new RegExp(`\\b(${MONTHS.join('|')})\\s+(\\d{1,2}),\\s*(\\d{4})\\b`, 'i');

function chainOf(href) {
  let host;
  try { host = new URL(href).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
  for (const [suffix, name] of EXPLORERS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return name;
  }
  return null;
}

function sourceOf(href) {
  try {
    const host = new URL(href).hostname.toLowerCase().replace(/^www\./, '');
    // A Medium-hosted company blog is that company, not "medium".
    const m = /^([\w-]+)\.medium\.com$/.exec(host);
    if (m) return m[1];
    if (host === 'x.com' || host === 'twitter.com') return 'X / Twitter';
    return host;
  } catch { return null; }
}

function parseDate(text) {
  let m = DMY.exec(text);
  if (m) return { day: +m[1], month: MONTH_IX.get(m[2].toLowerCase()), year: +m[3] };
  m = MDY.exec(text);
  if (m) return { day: +m[2], month: MONTH_IX.get(m[1].toLowerCase()), year: +m[3] };
  return null;
}

/**
 * Reads one list item into an incident, or returns null if it is not one.
 * Works on the *rendered* HTML, so footnote markers are `<sup>` elements to be
 * removed rather than `[^3]` noise a regex has to anticipate.
 */
function readEntry($, li) {
  const $li = $(li).clone();
  $li.find('sup, .footnote-ref').remove();

  const links = $li.find('a[href^="http"]').toArray().map((a) => ({
    text: $(a).text().replace(/\s+/g, ' ').trim(),
    href: $(a).attr('href'),
  }));
  if (!links.length) return null;

  const text = $li.text().replace(/\s+/g, ' ').trim();
  const date = parseDate(text);
  if (!date) return null;

  // The first link is the write-up; the rest point at chain artefacts.
  const [primary, ...rest] = links;
  const name = primary.text || text.split(/[–—-]/)[0].trim();
  if (!name) return null;

  const chains = [...new Set(rest.map((l) => chainOf(l.href)).filter(Boolean))];
  const artefacts = rest
    .map((l) => ({ label: l.text, href: l.href, chain: chainOf(l.href) }))
    .filter((a) => a.href);

  return {
    name,
    url: primary.href,
    source: sourceOf(primary.href),
    date,
    sort: date.year * 10000 + date.month * 100 + date.day,
    chains,
    chain: chains[0] || null,
    artefacts,
  };
}

/**
 * Detects and reads the ledger shape.
 *
 * The threshold is deliberate: a handful of dated links in a README is a
 * changelog or a reading list, not a dataset. Requiring most of a long list to
 * parse is what keeps every other repository out of this template.
 */
export function extractLedger(html, { minEntries = 12, minRatio = 0.6 } = {}) {
  const $ = load(html, null, false);

  // Only consider lists long enough to be a dataset, and read each in isolation
  // so a repo's short "Types of…" list cannot dilute the real one.
  const candidates = [];
  $('ul').each((_, ul) => {
    const items = $(ul).children('li').toArray();
    if (items.length < minEntries) return;
    const entries = items.map((li) => readEntry($, li)).filter(Boolean);
    if (entries.length >= minEntries && entries.length / items.length >= minRatio) {
      candidates.push({ entries, items: items.length });
    }
  });
  if (!candidates.length) return null;

  // The dataset is the biggest such list.
  const best = candidates.sort((a, b) => b.entries.length - a.entries.length)[0];
  const entries = best.entries.sort((a, b) => a.sort - b.sort);

  return {
    entries,
    parsed: entries.length,
    considered: best.items,
    ...summarise(entries),
  };
}

function summarise(entries) {
  const byChain = new Map();
  const byYear = new Map();
  const bySource = new Map();

  for (const e of entries) {
    for (const c of e.chains.length ? e.chains : ['unattributed']) {
      byChain.set(c, (byChain.get(c) || 0) + 1);
    }
    byYear.set(e.date.year, (byYear.get(e.date.year) || 0) + 1);
    if (e.source) bySource.set(e.source, (bySource.get(e.source) || 0) + 1);
  }

  const years = [...byYear.keys()].sort((a, b) => a - b);
  const span = years.length ? { from: years[0], to: years[years.length - 1] } : null;
  // Every year in range, so a quiet year reads as a gap rather than vanishing.
  const cadence = span
    ? Array.from({ length: span.to - span.from + 1 }, (_, i) => ({
      year: span.from + i, count: byYear.get(span.from + i) || 0,
    }))
    : [];

  return {
    span,
    cadence,
    chains: [...byChain.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    sources: [...bySource.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
  };
}
