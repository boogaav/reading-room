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
  claimTime, claimCoord, claimQuantity, claimIds,
} from './wiki.js';
import { extractSource } from './extract/source.js';
import { resolveEntities } from './extract/entities.js';
import { extractChronology, deriveWindow } from './extract/timeline.js';
import { detectArchetype } from './archetype.js';
import { buildBlocks } from './templates/index.js';

export const TEMPLATE_VERSION = 16;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BOOKS = join(ROOT, '.cache', 'books');

export async function buildBook(title, { force = false } = {}) {
  const t0 = Date.now();

  const article = await fetchArticleHtml(title);
  const summary = await fetchSummary(title).catch(() => null);
  const canonical = summary?.titles?.normalized || title.replace(/_/g, ' ');

  const cacheKey = `${canonical.replace(/[^\w-]+/g, '_')}.r${article.revid}.v${TEMPLATE_VERSION}`;
  if (!force) {
    const hit = await readBook(cacheKey);
    if (hit) return { ...hit, stats: { ...hit.stats, servedFromCache: true, buildMs: Date.now() - t0 } };
  }

  const source = extractSource(article.html, { title: canonical });

  // Subject entity drives archetype selection and the date window.
  const qid = summary?.wikibase_item || null;
  const subjectEntity = qid ? (await fetchEntities([qid], { props: 'claims|labels|descriptions' }))[qid] : null;
  const { archetype, path: classPath } = subjectEntity
    ? await detectArchetype(subjectEntity)
    : { archetype: 'generic', path: [] };

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

  const entities = await resolveEntities(source.links.map((l) => l.title), { limit: 140 });

  const dateRow = source.infobox.rows.find((r) => /^date$/i.test(r.label));
  const window = deriveWindow({
    start: subject.start || subject.inception || subject.pointInTime,
    end: subject.end,
    birth: subject.birth,
    death: subject.death,
    dateText: dateRow?.values[0]?.text || '',
    openEndedTo: new Date().getUTCFullYear(),
  });

  const chronology = extractChronology(source, window);
  const blocks = buildBlocks(archetype, { source, entities, chronology, subject, summary, window });
  const views = await fetchPageviews(canonical).catch(() => null);

  const words = source.lead.text.split(/\s+/).filter(Boolean).length
    + source.chapters.reduce((a, c) => a + c.words, 0);

  const book = {
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
      entitiesResolved: entities.size,
      placesMapped: [...entities.values()].filter((e) => e.coord && e.isPlace).length,
      chronologyEvents: chronology.length,
      pageviews60d: views?.total ?? null,
      templateVersion: TEMPLATE_VERSION,
      buildMs: Date.now() - t0,
      servedFromCache: false,
    },
  };

  await writeBook(cacheKey, book);
  return book;
}

async function readBook(key) {
  try { return JSON.parse(await readFile(join(BOOKS, key + '.json'), 'utf8')); }
  catch { return null; }
}

async function writeBook(key, book) {
  await mkdir(BOOKS, { recursive: true });
  await writeFile(join(BOOKS, key + '.json'), JSON.stringify(book));
}
