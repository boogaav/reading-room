// Ethereum Improvement Proposals -> Atlas.
//
// The `catalogue` shape: many items, each carrying typed metadata, where the
// interesting thing is not any one item but the distribution.
//
// eips.ethereum.org publishes no API, but it does publish the same corpus cut
// two ways: `/all` groups every proposal by status, and `/core`, `/erc`,
// `/networking`, `/interface`, `/meta` and `/informational` group them by
// category. Seven requests, joined on the proposal number, give status *and*
// category for all of them — against 1,194 requests if each proposal page had
// to be read. The join is exact: every row on `/all` finds a category.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';

import { fetchCached } from '../wiki.js';

export const CATALOGUE_VERSION = 1;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CACHE = join(ROOT, '.cache', 'atlases');
const SITE = 'https://eips.ethereum.org';

const CATEGORIES = [
  ['core', 'Core'],
  ['erc', 'ERC'],
  ['networking', 'Networking'],
  ['interface', 'Interface'],
  ['meta', 'Meta'],
  ['informational', 'Informational'],
];

// The lifecycle, in the order a proposal actually travels it. Sorting these by
// count would put Stagnant first and hide the shape of the process.
const STATUS_ORDER = ['Draft', 'Review', 'Last Call', 'Final', 'Living', 'Stagnant', 'Withdrawn'];

const titleCase = (id) => id.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

async function page(path) {
  const { body } = await fetchCached(`${SITE}/${path}`, { ttlMs: 864e5 });
  return body;
}

/** Every proposal number listed on a category page. */
function numbersOn(html) {
  const $ = load(html, null, false);
  const nums = new Set();
  $('table tbody tr').each((_, tr) => {
    const n = $(tr).find('td').first().text().trim();
    if (/^\d+$/.test(n)) nums.add(n);
  });
  return nums;
}

/** `/all`, which is the corpus grouped under a heading per status. */
function readAll(html) {
  const $ = load(html, null, false);
  const out = [];

  $('h2[id]').each((_, h) => {
    const status = titleCase($(h).attr('id'));
    if (!STATUS_ORDER.includes(status)) return;
    const table = $(h).nextAll('table').first();

    table.find('tbody tr').each((__, tr) => {
      const tds = $(tr).find('td');
      const num = tds.eq(0).text().trim();
      if (!/^\d+$/.test(num)) return;
      out.push({
        num: Number(num),
        title: tds.eq(1).text().replace(/\s+/g, ' ').trim(),
        authors: tds.eq(2).text().replace(/\s+/g, ' ').trim(),
        status,
        href: `${SITE}/EIPS/eip-${num}`,
      });
    });
  });
  return out;
}

/** GitHub handles are the only part of an author string that parses cleanly. */
function handlesOf(authors) {
  return [...String(authors).matchAll(/\(@([\w-]+)\)/g)].map((m) => m[1]);
}

export async function buildEipAtlas({ force = false } = {}) {
  const t0 = Date.now();
  const key = `eips.v${CATALOGUE_VERSION}`;

  if (!force) {
    const hit = await read(key);
    // The corpus moves slowly; a day-old catalogue is not a stale one.
    if (hit && Date.now() - (hit.builtAt || 0) < 864e5) {
      return { ...hit, stats: { ...hit.stats, servedFromCache: true, buildMs: Date.now() - t0 } };
    }
  }

  const [allHtml, ...catHtml] = await Promise.all([
    page('all'),
    ...CATEGORIES.map(([slug]) => page(slug)),
  ]);

  const byNumber = new Map();
  CATEGORIES.forEach(([, name], i) => {
    for (const n of numbersOn(catHtml[i])) byNumber.set(n, name);
  });

  const eips = readAll(allHtml)
    .map((e) => ({ ...e, category: byNumber.get(String(e.num)) || null }))
    .sort((a, b) => a.num - b.num);

  const uncategorised = eips.filter((e) => !e.category).length;

  return finish(await store(key, {
    kind: 'catalogue',
    title: 'Ethereum Improvement Proposals',
    description: 'Every EIP ever proposed, by where it stands and what it touches.',
    source: `${SITE}/all`,
    sourceLabel: 'eips.ethereum.org',
    eips,
    ...summarise(eips),
    builtAt: Date.now(),
    stats: {
      count: eips.length,
      uncategorised,
      statuses: new Set(eips.map((e) => e.status)).size,
      categories: new Set(eips.map((e) => e.category)).size,
      requests: 1 + CATEGORIES.length,
      catalogueVersion: CATALOGUE_VERSION,
      buildMs: Date.now() - t0,
      servedFromCache: false,
    },
  }), t0);
}

function finish(atlas, t0) {
  return { ...atlas, stats: { ...atlas.stats, buildMs: Date.now() - t0 } };
}

function summarise(eips) {
  const byStatus = new Map();
  const byCategory = new Map();
  const byHandle = new Map();

  for (const e of eips) {
    byStatus.set(e.status, (byStatus.get(e.status) || 0) + 1);
    const c = e.category || 'Uncategorised';
    byCategory.set(c, (byCategory.get(c) || 0) + 1);
    for (const h of handlesOf(e.authors)) byHandle.set(h, (byHandle.get(h) || 0) + 1);
  }

  const statuses = STATUS_ORDER.filter((s) => byStatus.has(s))
    .map((name) => ({ name, count: byStatus.get(name) }));
  const categories = [...byCategory.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  // The point of the pair: how far each kind of proposal actually gets.
  const matrix = statuses.map((s) => ({
    status: s.name,
    cells: categories.map((c) => ({
      category: c.name,
      count: eips.filter((e) => e.status === s.name && (e.category || 'Uncategorised') === c.name).length,
    })),
  }));

  return {
    statuses,
    categories,
    matrix,
    authors: [...byHandle.entries()].map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count).slice(0, 20),
    numberSpace: buckets(eips),
  };
}

/**
 * Proposal numbers are handed out roughly in order, so a histogram over the
 * number space reads as a rough timeline. Rough is the operative word — it is
 * labelled as number space, not as time, because that is what it is.
 */
function buckets(eips, size = 500) {
  if (!eips.length) return [];
  const top = eips[eips.length - 1].num;
  const out = [];
  for (let start = 0; start <= top; start += size) {
    out.push({
      from: start || 1,
      to: start + size - 1,
      count: eips.filter((e) => e.num >= start && e.num < start + size).length,
    });
  }
  return out;
}

async function store(key, atlas) {
  await mkdir(CACHE, { recursive: true });
  await writeFile(join(CACHE, key + '.json'), JSON.stringify(atlas));
  return atlas;
}

async function read(key) {
  try { return JSON.parse(await readFile(join(CACHE, key + '.json'), 'utf8')); }
  catch { return null; }
}
