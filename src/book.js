// Orchestrator: article title -> Book JSON.
//
// Cache key is (title, revid, TEMPLATE_VERSION). Bump TEMPLATE_VERSION and every
// book rebuilds; a Wikipedia edit rebuilds only that one. That is the whole
// invalidation story.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  fetchArticleHtml, fetchSummary, fetchEntities, fetchPageviews,
  claimTime, claimTimes, claimCoord, claimQuantity, claimIds,
} from './wiki.js';
import { extractSource } from './extract/source.js';
import { resolveEntities } from './extract/entities.js';
import { extractChronology, deriveWindow } from './extract/timeline.js';
import { extractCountry } from './extract/country.js';
import { detectArchetype } from './archetype.js';
import { buildBlocks } from './templates/index.js';

export const TEMPLATE_VERSION = 17;

// A country article is Wikipedia's longest form — Japan carries 783 wikilinks
// against a 140 cap, and the cast, the map and the shelf are all chosen from
// whatever made the cut.
const ENTITY_LIMIT = { country: 260 };

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BOOKS = join(ROOT, '.cache', 'books');

const EMPTY_ENTITIES = new Map();

// One build per (title, force) at a time. Hovering a link starts a background
// build; clicking it 300ms later must join that build rather than race a second
// copy of it through the same upstream APIs.
const inflight = new Map();

/**
 * @param {string} title
 * @param {{force?:boolean, onEvent?:(ev:object)=>void}} opts
 *   `onEvent` receives the build's real milestones as they happen:
 *   `{type:'stage'}` for each named step, and `{type:'partial', book}` once the
 *   article itself is parsed — cover, chapters, notes, chronology — which lands
 *   seconds before the Wikidata apparatus does. A subscriber that joins an
 *   already-running build is replayed everything it missed, so a click that
 *   lands on an in-flight warm sees the same sequence as one that started it.
 */
export function buildBook(title, { force = false, onEvent = null } = {}) {
  const key = `${String(title).replace(/_/g, ' ')}|${force ? 1 : 0}`;
  let entry = inflight.get(key);

  if (!entry) {
    entry = { events: [], listeners: new Set(), startedAt: Date.now() };
    const emit = (ev) => {
      entry.events.push(ev);
      // A subscriber that has navigated away must not be able to fail a build
      // that other subscribers are still waiting on.
      for (const fn of entry.listeners) { try { fn(ev); } catch { /* ignore */ } }
    };
    entry.promise = runBuild(title, { force, emit })
      .finally(() => {
        entry.listeners.clear();
        if (inflight.get(key) === entry) inflight.delete(key);
      });
    inflight.set(key, entry);
  }

  if (onEvent) {
    for (const ev of entry.events) { try { onEvent(ev); } catch { /* ignore */ } }
    entry.listeners.add(onEvent);
  }
  return entry.promise;
}

/** Titles currently being built, for the /api/engine dashboard. */
export function inflightTitles() {
  return [...inflight.keys()].map((k) => k.split('|')[0]);
}

async function runBuild(title, { force, emit }) {
  const t0 = Date.now();
  const stage = (name, detail = {}) => emit({ type: 'stage', name, at: Date.now() - t0, ...detail });

  stage('fetching', { of: String(title).replace(/_/g, ' ') });
  // Independent endpoints; the summary need not wait on a 5-second Parsoid render.
  const [article, summary] = await Promise.all([
    fetchArticleHtml(title),
    fetchSummary(title).catch(() => null),
  ]);
  const canonical = summary?.titles?.normalized || title.replace(/_/g, ' ');
  stage('revision', { title: canonical, revid: article.revid, cached: article.cached });

  const cacheKey = `${canonical.replace(/[^\w-]+/g, '_')}.r${article.revid}.v${TEMPLATE_VERSION}`;
  if (!force) {
    const hit = await readBook(cacheKey);
    if (hit) {
      stage('bound', { fromCache: true });
      return { ...hit, stats: { ...hit.stats, servedFromCache: true, buildMs: Date.now() - t0 } };
    }
  }

  const source = extractSource(article.html, { title: canonical });
  stage('parsed', { chapters: source.chapters.length, notes: source.notes.length, links: source.links.length });

  // Subject entity drives archetype selection and the date window.
  const qid = summary?.wikibase_item || null;
  const subjectEntity = qid ? (await fetchEntities([qid], { props: 'claims|labels|descriptions' }))[qid] : null;
  const { archetype, path: classPath } = subjectEntity
    ? await detectArchetype(subjectEntity)
    : { archetype: 'generic', path: [] };
  stage('classified', { archetype });

  const subject = subjectEntity ? {
    qid,
    title: canonical,
    label: subjectEntity.labels?.en?.value || canonical,
    description: subjectEntity.descriptions?.en?.value || summary?.description || '',
    coord: claimCoord(subjectEntity),
    birth: claimTime(subjectEntity, 'P569'),
    death: claimTime(subjectEntity, 'P570'),
    start: claimTime(subjectEntity, 'P580'),
    end: claimTime(subjectEntity, 'P582'),
    inception: claimTime(subjectEntity, 'P571'),
    pointInTime: claimTime(subjectEntity, 'P585'),
    population: claimQuantity(subjectEntity, 'P1082'),
    area: claimQuantity(subjectEntity, 'P2046'),
    elevation: claimQuantity(subjectEntity, 'P2044'),
    types: claimIds(subjectEntity, 'P31'),
  } : { qid: null, title: canonical, description: summary?.description || '', coord: null };

  const dateRow = source.infobox.rows.find((r) => /^date$/i.test(r.label));
  const window = deriveWindow({
    // A country's P571 is plural and its preferred value is usually its newest
    // constitution. Starting the window there would clip Japan's chronology at
    // 1947 and drop fifteen centuries of the article it belongs to.
    start: archetype === 'country'
      ? earliestInception(subjectEntity) || subject.start || subject.inception
      : subject.start || subject.inception || subject.pointInTime,
    end: subject.end || (archetype === 'country' ? claimTime(subjectEntity, 'P576') : null),
    birth: subject.birth,
    death: subject.death,
    dateText: dateRow?.values[0]?.text || '',
    openEndedTo: new Date().getUTCFullYear(),
  });

  // A country narrates in bare years and so yields far more dated sentences
  // than a battle does; a tighter cap would thin away most of a national history.
  const chronology = extractChronology(source, window, {
    bareYears: archetype === 'country',
    max: archetype === 'country' ? 110 : 80,
  });
  if (archetype === 'country') promoteHistory(source.chapters);

  const words = source.lead.text.split(/\s+/).filter(Boolean).length
    + source.chapters.reduce((a, c) => a + c.words, 0);

  const shell = (blocks, extraStats) => ({
    title: canonical,
    slug: canonical.replace(/ /g, '_'),
    archetype,
    classPath,
    revid: article.revid,
    lastModified: article.lastModified,
    subject: { qid: subject.qid, description: subject.description, coord: subject.coord },
    blocks,
    lead: source.lead,
    chapters: source.chapters,
    notes: source.notes,
    figures: source.figures,
    attribution: {
      article: `https://en.wikipedia.org/wiki/${encodeURIComponent(canonical.replace(/ /g, '_'))}`,
      revision: article.revid ? `https://en.wikipedia.org/w/index.php?oldid=${article.revid}` : null,
      history: `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(canonical.replace(/ /g, '_'))}&action=history`,
      textLicense: 'CC BY-SA 4.0',
      textLicenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      wikidata: qid ? `https://www.wikidata.org/wiki/${qid}` : null,
      note: 'Text is Wikipedia\'s, reorganised but never rewritten. Media files carry their own licences on Commons.',
    },
    stats: {
      words,
      chapters: source.chapters.length,
      notes: source.notes.length,
      figures: source.figures.length,
      linksFound: source.links.length,
      chronologyEvents: chronology.length,
      templateVersion: TEMPLATE_VERSION,
      servedFromCache: false,
      ...extraStats,
    },
  });

  const ctx = { source, chronology, subject, summary, window };

  // Phase one: everything the article itself carries. Entity resolution has not
  // run, so the packs fall through to exactly the shape they already use when a
  // subject has no resolvable links — cover, facts, chronology, spine, notes.
  // That is a readable book, and it lands seconds before the apparatus does.
  emit({
    type: 'partial',
    book: shell(
      buildBlocks(archetype, { ...ctx, entities: EMPTY_ENTITIES, country: null }),
      { phase: 'text', entitiesResolved: 0, placesMapped: 0, pageviews60d: null, buildMs: Date.now() - t0 },
    ),
  });

  // Phase two: the expensive half. 260 wikilinks resolved against Wikidata, plus
  // the country pack's own lineage walk — a dozen round trips either way.
  const limit = ENTITY_LIMIT[archetype] || 140;
  stage('resolving', { links: Math.min(source.links.length, limit) });
  const entities = await resolveEntities(source.links.map((l) => l.title), { limit });

  if (archetype === 'country') stage('lineage');
  const country = archetype === 'country'
    ? await extractCountry(subjectEntity, { title: canonical }).catch((e) => {
      console.warn('[country] extraction failed:', e.message);
      return null;
    })
    : null;

  const blocks = buildBlocks(archetype, { ...ctx, entities, country });
  stage('bound', { fromCache: false });
  const views = await fetchPageviews(canonical).catch(() => null);

  const book = shell(blocks, {
    phase: 'complete',
    entitiesResolved: entities.size,
    placesMapped: [...entities.values()].filter((e) => e.coord && e.isPlace).length,
    pageviews60d: views?.total ?? null,
    buildMs: Date.now() - t0,
  });

  await writeBook(cacheKey, book);
  return book;
}

/** Earliest of the subject's inception statements, not the top-ranked one. */
function earliestInception(entity) {
  const years = claimTimes(entity, 'P571');
  if (!years.length) return null;
  return years.reduce((a, b) => (b.year < a.year ? b : a));
}

/**
 * In a country article "History" is one section holding the whole national
 * narrative in subsections, so the reading spine shows a single chapter where
 * there are really eight. Promote its subsections a level: History becomes a
 * part heading and each era becomes a numbered chapter.
 */
function promoteHistory(chapters) {
  const history = chapters.find((c) => c.level === 1 && /^history$/i.test(c.title));
  if (!history) return;
  const descendants = new Set([history.id]);
  for (const c of chapters) {
    if (c.parentId && descendants.has(c.parentId)) {
      descendants.add(c.id);
      c.level = Math.max(1, c.level - 1);
    }
  }
}

async function readBook(key) {
  try { return JSON.parse(await readFile(join(BOOKS, key + '.json'), 'utf8')); }
  catch { return null; }
}

async function writeBook(key, book) {
  await mkdir(BOOKS, { recursive: true });
  await writeFile(join(BOOKS, key + '.json'), JSON.stringify(book));
}
