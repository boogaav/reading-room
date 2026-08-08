// Wikimedia clients. Everything goes through a disk cache and a concurrency gate,
// because the whole architecture assumes we hit the network once per (article, revision)
// and never again.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CACHE_DIR = join(ROOT, '.cache');

// Wikimedia's UA policy requires something descriptive + contactable.
const UA = 'reading-room/0.1 (https://github.com/boogaav/reading-room; boogaav@gmail.com)';

const MAX_CONCURRENT = 4;
let active = 0;
const waiting = [];

function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((res) => waiting.push(res));
}
function release() {
  active--;
  const next = waiting.shift();
  if (next) { active++; next(); }
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

  await acquire();
  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, 'Api-User-Agent': UA, 'Accept-Encoding': 'gzip' } });
  } finally { release(); }

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
export async function fetchEntities(idsOrTitles, { byTitle = false, props = 'claims|labels|descriptions' } = {}) {
  const uniq = [...new Set(idsOrTitles)].filter(Boolean);
  const out = {};
  for (let i = 0; i < uniq.length; i += 50) {
    const batch = uniq.slice(i, i + 50);
    const params = new URLSearchParams({
      action: 'wbgetentities', format: 'json', props, languages: 'en',
    });
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

export function claimIds(entity, prop) {
  return claimValues(entity, prop).map((v) => v.id).filter(Boolean);
}

const GREGORIAN = 'http://www.wikidata.org/entity/Q1985727';

export function claimTime(entity, prop) {
  const values = claimValues(entity, prop).filter((x) => x?.time);
  // Pre-1918 Russian subjects carry both Julian and Gregorian statements; the
  // Gregorian one is what the article prose uses.
  const v = values.find((x) => x.calendarmodel === GREGORIAN) || values[0];
  if (!v?.time) return null;
  const m = /^([+-])(\d+)-(\d{2})-(\d{2})/.exec(v.time);
  if (!m) return null;
  const year = (m[1] === '-' ? -1 : 1) * Number(m[2]);
  return { year, month: Number(m[3]) || null, day: Number(m[4]) || null, precision: v.precision };
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
