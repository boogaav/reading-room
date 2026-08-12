// Repository -> Atlas.
//
// The same shape as the book pipeline: fetch, detect what kind of thing this
// is, and hand a template pack the structure it needs. A repository whose
// README is a dataset becomes an atlas; anything else becomes a plain reading
// of the README, which is the honest floor rather than a failure.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { load } from 'cheerio';

import { fetchRepo, fetchReadmeHtml } from './fetch.js';
import { extractLedger } from './ledger.js';

export const ATLAS_VERSION = 1;

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ATLASES = join(ROOT, '.cache', 'atlases');

export async function buildAtlas(owner, repo, { force = false } = {}) {
  const t0 = Date.now();
  const meta = await fetchRepo(owner, repo);

  // `pushed_at` changes whenever the repo does, which is exactly the
  // invalidation the book cache gets from a revision id.
  const stamp = String(meta.pushed_at || '').replace(/[^\dTZ]/g, '');
  const key = `${owner}__${repo}.${stamp}.v${ATLAS_VERSION}`;
  if (!force) {
    const hit = await readAtlas(key);
    if (hit) return { ...hit, stats: { ...hit.stats, servedFromCache: true, buildMs: Date.now() - t0 } };
  }

  const html = await fetchReadmeHtml(owner, repo, meta.default_branch);
  const ledger = extractLedger(html);
  const prose = readProse(html, { skipLongLists: !!ledger });

  const atlas = {
    kind: ledger ? 'ledger' : 'readme',
    owner, repo,
    fullName: meta.full_name,
    title: titleOf(html) || meta.full_name,
    description: meta.description || '',
    homepage: meta.homepage || '',
    stars: meta.stargazers_count || 0,
    forks: meta.forks_count || 0,
    topics: meta.topics || [],
    license: meta.license?.spdx_id || null,
    pushedAt: meta.pushed_at || null,
    avatar: meta.owner?.avatar_url || null,
    url: meta.html_url,
    chapters: prose,
    ledger: ledger || null,
    stats: {
      entries: ledger?.parsed || 0,
      considered: ledger?.considered || 0,
      chains: ledger?.chains.length || 0,
      sources: ledger?.sources.length || 0,
      chapters: prose.length,
      atlasVersion: ATLAS_VERSION,
      buildMs: Date.now() - t0,
      servedFromCache: false,
    },
  };

  await writeAtlas(key, atlas);
  return atlas;
}

function titleOf(html) {
  const $ = load(html, null, false);
  return $('h1').first().text().replace(/\s+/g, ' ').trim() || null;
}

/**
 * The README's prose, split at its own headings.
 *
 * When the repo is a ledger, the dataset list is removed from the prose: it is
 * rendered as the atlas itself, and leaving it here would print eighty entries
 * twice.
 */
function readProse(html, { skipLongLists }) {
  const $ = load(html, null, false);
  const root = $('article').first().length ? $('article').first() : $.root();

  $(root).find('script, style, .markdown-heading > a.anchor, .octicon').remove();
  // GitHub's own badge row is chrome, not content.
  $(root).find('p').each((_, p) => {
    const $p = $(p);
    const imgs = $p.find('img[src*="badge"], img[src*="shields.io"], img[src*="actions/workflows"]');
    if (imgs.length && $p.text().trim().length < 4) $p.remove();
  });

  const chapters = [];
  let current = { title: 'Opening', level: 1, nodes: [] };

  const flush = () => {
    const html2 = current.nodes.map((n) => $.html(n)).join('\n').trim();
    const text = current.nodes.map((n) => $(n).text()).join(' ').replace(/\s+/g, ' ').trim();
    // A section can be a picture. This repo's Disclaimer is a screenshot with no
    // text at all, and requiring text silently dropped the whole chapter.
    const hasArt = current.nodes.some((n) => $(n).find('img').length || $(n).is('img'));
    if (html2 && (text || hasArt)) {
      chapters.push({
        id: `at-${chapters.length}-${slug(current.title)}`,
        title: current.title, level: current.level, html: html2, text,
        words: text.split(/\s+/).filter(Boolean).length,
      });
    }
  };

  const top = $(root).find('> *').toArray();
  for (const node of top) {
    const $n = $(node);
    // GitHub wraps each heading in a div; unwrap to see the real level.
    const heading = $n.is('h1,h2,h3,h4,h5,h6') ? $n : $n.find('> h1,> h2,> h3,> h4,> h5,> h6').first();

    if (heading.length) {
      flush();
      const name = heading.text().replace(/\s+/g, ' ').trim();
      current = { title: name || 'Untitled', level: Number(heading[0].tagName[1]) || 2, nodes: [] };
      continue;
    }
    // The dataset itself is rendered as the atlas, not reprinted as prose.
    if (skipLongLists && $n.is('ul') && $n.children('li').length >= 12) continue;
    current.nodes.push(node);
  }
  flush();

  // Footnotes are apparatus, the same as on the Wikipedia side.
  return chapters
    .filter((c) => !/^footnotes?$/i.test(c.title))
    .map((c) => ({ ...c, html: harden(c.html) }));
}

/** Make GitHub's HTML safe and consistent with the reader's own markup. */
function harden(html) {
  const $ = load(html, null, false);
  $('a[href^="http"]').attr('target', '_blank').attr('rel', 'noopener noreferrer').addClass('wb-ext');
  $('img').each((_, i) => {
    const $i = $(i);
    const src = $i.attr('src') || '';
    if (!/^https?:/.test(src)) $i.remove();
  });
  $('*').each((_, el) => {
    for (const attr of ['id', 'class', 'itemprop', 'dir', 'aria-hidden']) {
      if (el.attribs && attr in el.attribs && attr !== 'class') delete el.attribs[attr];
    }
  });
  $('table').each((_, t) => $(t).wrap('<div class="wb-scroll"></div>'));
  return ($.html() || '').trim();
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'section';
}

async function readAtlas(key) {
  try { return JSON.parse(await readFile(join(ATLASES, key + '.json'), 'utf8')); }
  catch { return null; }
}

async function writeAtlas(key, atlas) {
  await mkdir(ATLASES, { recursive: true });
  await writeFile(join(ATLASES, key + '.json'), JSON.stringify(atlas));
}
