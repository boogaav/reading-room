// Wikimedia clients. Everything goes through a disk cache and a concurrency gate,
// because the whole architecture assumes we hit the network once per (article, revision)
// and never again.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE_DIR = join(ROOT, '.cache');

// Wikimedia's UA policy requires something descriptive + contactable.
const UA = 'reading-room/0.1 (https://github.com/boogaav/reading-room; boogaav@gmail.com)';

const MAX_CONCURRENT = 4;
// Speculative warming must never make the page you are actually reading slower,
// so background work gets its own queue, is served only after the foreground
// queue is empty, and can never hold more than half the slots.
const MAX_BACKGROUND = 2;

let active = 0;
let activeBackground = 0;
const waiting = { fg: [], bg: [] };

// Priority travels with the async context rather than through every function
// signature — a build is dozens of nested fetches deep and threading a flag
// through all of them would touch every caller for no gain.
const priorityStore = new AsyncLocalStorage();

/** Run `fn` with all of its upstream fetches marked background. */
export function withPriority(priority, fn) {
  return priorityStore.run(priority, fn);
}

function currentPriority() {
  return priorityStore.getStore() === 'bg' ? 'bg' : 'fg';
}

function canRun(priority) {
  if (active >= MAX_CONCURRENT) return false;
  return priority === 'fg' || activeBackground < MAX_BACKGROUND;
}

function start(priority) {
  active++;
  if (priority === 'bg') activeBackground++;
}

function acquire() {
  const priority = currentPriority();
  if (!waiting[priority].length && canRun(priority)) { start(priority); return Promise.resolve(priority); }
  return new Promise((res) => waiting[priority].push(() => { start(priority); res(priority); }));
}

function release(priority) {
  active--;
  if (priority === 'bg') activeBackground--;
  // Foreground first, always. A background waiter only runs if it still fits
  // under its own cap, otherwise it stays queued for the next release.
  const next = waiting.fg.shift()
    || (activeBackground < MAX_BACKGROUND && active < MAX_CONCURRENT ? waiting.bg.shift() : null);
  if (next) next();
}

/** Live gate state, for the /api/engine dashboard. */
export function gateStats() {
  return { active, activeBackground, queuedForeground: waiting.fg.length, queuedBackground: waiting.bg.length };
}

const memo = new Map();

function keyFor(url) {
  return createHash('sha1').update(url).digest('hex').slice(0, 24);
}

async function readCache(key) {
  try {
    const raw = await readFile(join(CACHE_DIR, key + '.json'), 'utf8');
    return JSON.parse(raw);
  } catch { return null; }
}

async function writeCache(key, payload) {
  await mkdir(CACHE_DIR, { recursive: true });
  await writeFile(join(CACHE_DIR, key + '.json'), JSON.stringify(payload));
}

/**
 * Fetch a URL with disk + memory caching.
 * Returns { body, headers } where body is text (or a parsed object when json:true).
 */
export async function fetchCached(url, { json = false, ttlMs = 1000 * 60 * 60 * 24 * 30 } = {}) {
  const key = keyFor(url);
  if (memo.has(key)) return memo.get(key);

  const cached = await readCache(key);
  if (cached && Date.now() - cached.at < ttlMs) {
    const out = { body: json ? JSON.parse(cached.body) : cached.body, headers: cached.headers, cached: true };
    memo.set(key, out);
    return out;
  }

  const slot = await acquire();
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA, 'Accept-Encoding': 'gzip' } });
  } finally { release(slot); }

  if (!res.ok) {
    const err = new Error(`upstream ${res.status} for ${url}`);
    err.status = res.status;
    throw err;
  }
  const body = await res.text();
  const headers = {
    etag: res.headers.get('etag') || '',
    'last-modified': res.headers.get('last-modified') || '',
  };
  await writeCache(key, { at: Date.now(), body, headers });
  const out = { body: json ? JSON.parse(body) : body, headers, cached: false };
  memo.set(key, out);
  return out;
}

const WP = 'https://en.wikipedia.org';

/** Parsoid HTML — semantic sections, typed links, structured refs. */
export async function fetchArticleHtml(title) {
  const url = `${WP}/api/rest_v1/page/html/${encodeURIComponent(title)}`;
  const { body, headers, cached } = await fetchCached(url);
  // etag looks like: W/"1368051906/71d2bab4-.../view/html" — the leading number is the revid.
  const m = /"(\d+)\//.exec(headers.etag || '');
  return { html: body, revid: m ? Number(m[1]) : null, lastModified: headers['last-modified'], cached };
}

export async function fetchSummary(title) {
  const url = `${WP}/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  const { body } = await fetchCached(url, { json: true, ttlMs: 1000 * 60 * 60 * 24 * 7 });
  return body;
}

/** Monthly pageviews — the popularity signal that decides what gets precomputed. */
export async function fetchPageviews(title, days = 60) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 864e5);
  const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '') + '00';
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user/${encodeURIComponent(title)}/daily/${fmt(start)}/${fmt(end)}`;
  try {
    const { body } = await fetchCached(url, { json: true, ttlMs: 864e5 });
    const items = body.items || [];
    return { total: items.reduce((a, b) => a + b.views, 0), days: items.length };
  } catch { return null; }
}

/**
 * One batched enwiki query gives us title -> Q-id AND a thumbnail, which is
 * everything we need to turn a wikilink into a card. 50 titles per request.
 */
export async function fetchPageProps(titles) {
  const uniq = [...new Set(titles)].filter(Boolean);
  const out = {};
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
    const params = new URLSearchParams({
      action: 'query', format: 'json', formatversion: '2', redirects: '1',
      prop: 'pageprops|pageimages', ppprop: 'wikibase_item',
      piprop: 'thumbnail', pithumbsize: '330', pilimit: '50',
      titles: batch.join('|'),
    });
    try {
      const { body } = await fetchCached(`${WP}/w/api.php?${params}`, { json: true });
      const redirects = new Map((body.query?.redirects || []).map((r) => [r.to, r.from]));
      for (const page of body.query?.pages || []) {
        if (page.missing) continue;
        const rec = {
          title: page.title,
          qid: page.pageprops?.wikibase_item || null,
          thumb: page.thumbnail?.source || null,
        };
        out[page.title] = rec;
        const from = redirects.get(page.title);
        if (from) out[from] = rec;
      }
    } catch (e) {
      console.warn('[enwiki] pageprops batch failed:', e.message);
    }
  }
  return out;
}

/**
 * Batched Wikidata entity fetch. Accepts Q-ids or enwiki titles (max 50 per request,
 * which is the API's hard limit).
 */
export async function fetchEntities(idsOrTitles, { byTitle = false, props = 'claims|labels|descriptions', sitefilter = null } = {}) {
  const uniq = [...new Set(idsOrTitles)].filter(Boolean);
  const out = {};
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
    const params = new URLSearchParams({
      action: 'wbgetentities', format: 'json', props, languages: 'en',
    });
    // Asking for sitelinks without a filter returns ~300 languages per entity.
    if (sitefilter) params.set('sitefilter', sitefilter);
    if (byTitle) { params.set('sites', 'enwiki'); params.set('titles', batch.join('|')); }
    else { params.set('ids', batch.join('|')); }
    const url = `https://www.wikidata.org/w/api.php?${params}`;
    try {
      const { body } = await fetchCached(url, { json: true });
      Object.assign(out, body.entities || {});
    } catch (e) {
      console.warn('[wikidata] batch failed:', e.message);
    }
  }
  return out;
}

// ---- claim helpers -------------------------------------------------------

const RANK_ORDER = { preferred: 0, normal: 1, deprecated: 2 };

/** Statement rank decides which value Wikidata considers current. Respect it. */
export function claimValues(entity, prop) {
  const claims = entity?.claims?.[prop];
  if (!claims) return [];
  return claims
    .filter((c) => c.mainsnak?.snaktype === 'value' && c.rank !== 'deprecated')
    .slice()
    .sort((a, b) => (RANK_ORDER[a.rank] ?? 1) - (RANK_ORDER[b.rank] ?? 1))
    .map((c) => c.mainsnak.datavalue?.value)
    .filter(Boolean);
}

/**
 * Like claimValues(), but keeps the qualifiers and the rank.
 *
 * `claimValues` throws qualifiers away, which is the right shape for "what is
 * this thing's population" and the wrong shape for almost everything a country
 * needs: a population *series* lives entirely in the P585 point-in-time
 * qualifier, a list of heads of state is meaningless without P580/P582, and a
 * flag without P580 cannot be placed on a lineage node. Returned in document
 * order — rank is reported, not sorted on, because a dated series must stay in
 * its own order.
 *
 * @returns {{value:any, qualifiers:object, rank:string, index:number}[]}
 */
export function claimStatements(entity, prop) {
  const claims = entity?.claims?.[prop];
  if (!claims) return [];
  return claims
    .filter((c) => c.mainsnak?.snaktype === 'value' && c.rank !== 'deprecated')
    .map((c, index) => ({
      value: c.mainsnak.datavalue?.value,
      qualifiers: c.qualifiers || {},
      rank: c.rank || 'normal',
      index,
    }))
    .filter((s) => s.value != null);
}

/** Rank-first ordering, for "which of these is the current one". */
export function byRank(a, b) {
  return (RANK_ORDER[a.rank] ?? 1) - (RANK_ORDER[b.rank] ?? 1);
}

/** First value of a qualifier on a statement, or null. */
export function qualifierValue(statement, prop) {
  const q = statement?.qualifiers?.[prop];
  const snak = q?.find((s) => s.snaktype === 'value');
  return snak ? snak.datavalue?.value ?? null : null;
}

export function qualifierId(statement, prop) {
  return qualifierValue(statement, prop)?.id || null;
}

/** Qualifier value parsed as a date, sharing claimTime's Julian/Gregorian rule. */
export function qualifierTime(statement, prop) {
  return parseTime(qualifierValue(statement, prop));
}

export function claimIds(entity, prop) {
  return claimValues(entity, prop).map((v) => v.id).filter(Boolean);
}

const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';

function parseTime(v) {
  if (!v?.time) return null;
  const m = /^([+-])(\d+)-(\d{2})-(\d{2})/.exec(v.time);
  if (!m) return null;
  const year = (m[1] === '-' ? -1 : 1) * Number(m[2]);
  return { year, month: Number(m[3]) || null, day: Number(m[4]) || null, precision: v.precision };
}

export function claimTime(entity, prop) {
  const values = claimValues(entity, prop).filter((x) => x?.time);
  // Pre-1918 Russian subjects carry both Julian and Gregorian statements; the
  // Gregorian one is what the article prose uses.
  const v = values.find((x) => x.calendarmodel === GREGORIAN) || values[0];
  return parseTime(v);
}

/**
 * Every dated statement for a property, not just the top-ranked one.
 * A country's P571 is routinely plural — Japan records a legendary founding, a
 * constitution and a post-war constitution, and the *preferred* one is the
 * newest. Taking only that would clip 2,600 years off the chronology.
 */
export function claimTimes(entity, prop) {
  return claimStatements(entity, prop)
    .map((s) => ({ ...parseTime(s.value) || {}, statement: s }))
    .filter((t) => typeof t.year === 'number');
}

export function claimCoord(entity, prop = 'P625') {
  const v = claimValues(entity, prop)[0];
  if (!v || typeof v.latitude !== 'number') return null;
  return { lat: v.latitude, lon: v.longitude };
}

export function claimQuantity(entity, prop) {
  const v = claimValues(entity, prop)[0];
  if (!v?.amount) return null;
  return Number(String(v.amount).replace('+', ''));
}

/** Commons file title -> served thumbnail URL. */
export function commonsThumb(fileName, width = 400) {
  if (!fileName) return null;
  const name = String(fileName).replace(/ /g, '_');
  return `https://commons.wikimedia.org/w/thumb.php?f=${encodeURIComponent(name)}&w=${width}`;
}
