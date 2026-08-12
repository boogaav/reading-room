import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBook, inflightTitles, catalogueEntries } from './src/book.js';
import { fetchSummary, searchTitles, fetchLangLinks, withPriority, gateStats } from './src/wiki.js';
import { parseWikiInput, looksLikeLangCode, isSupported, languageName } from './src/lang.js';
import { buildAtlas } from './src/github/atlas.js';
import { parseRepoInput } from './src/github/fetch.js';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC = join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 5208;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
};

const DEFAULT_TITLE = 'Battle_of_Stalingrad';

/**
 * English keeps the short path so every link ever shared stays valid; other
 * languages get a prefix. `looksLikeLangCode` is what lets the client take the
 * path apart again without a table of 300 Wikipedias.
 */
function readPath(lang, title) {
  const slug = encodeURIComponent(String(title).replace(/ /g, '_'));
  return lang === 'en' ? `/read/${slug}` : `/read/${lang}/${slug}`;
}

// ---- the warming engine --------------------------------------------------
//
// Reading is a walk, and the next step is usually visible before it is taken:
// you hover a lineage node for a moment before you click it. That moment is
// enough to bind the book, so the click lands on a finished volume.
//
// The whole design is deliberately timid. One build at a time, behind the
// foreground on the network gate, from an explicit signal of intent only.
// Warming every link a page mentions would be four times faster and would also
// be a crawler — which is the thing `robots.txt` in this repo exists to stop.
const WARM_MAX_INFLIGHT = 1;
const WARM_MAX_QUEUED = 8;
const WARM_MEMORY = 400;

const warmQueue = [];
const warmed = new Set();
let warmActive = 0;
const warmStats = { requested: 0, built: 0, dropped: 0, failed: 0 };

function warm(rawTitle, lang = 'en') {
  const title = String(rawTitle || '').replace(/_/g, ' ').trim();
  if (!title || title.length > 200) return 'rejected';
  const key = `${lang}:${title}`;
  warmStats.requested++;
  if (warmed.has(key)) return 'known';
  if (warmQueue.some((q) => q.key === key)) return 'queued';
  // A reader who hovers faster than we can build is telling us the earlier
  // guesses were wrong, so the newest intent wins and the stalest is dropped.
  if (warmQueue.length >= WARM_MAX_QUEUED) { warmQueue.shift(); warmStats.dropped++; }
  warmQueue.push({ key, title, lang });
  pumpWarm();
  return 'queued';
}

function pumpWarm() {
  while (warmActive < WARM_MAX_INFLIGHT && warmQueue.length) {
    const { key, title, lang } = warmQueue.shift();
    if (warmed.size > WARM_MEMORY) warmed.clear();
    warmed.add(key);
    warmActive++;
    withPriority('bg', () => buildBook(title, { lang }))
      .then((b) => {
        warmStats.built++;
        console.log(`[warm] ${b.title} · ${b.stats.servedFromCache ? 'cache' : `${b.stats.buildMs}ms`}`);
      })
      .catch((e) => { warmStats.failed++; console.warn(`[warm] ${lang}:${title}: ${e.message}`); })
      .finally(() => { warmActive--; pumpWarm(); });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);

  try {
    if (path === '/') return sendFile(res, join(PUBLIC, 'home.html'));

    // Paste anything: a URL from any Wikipedia, or a bare title. Returns where
    // to go, so the client never has to know how a wiki URL is shaped.
    if (path === '/api/resolve') {
      const q = url.searchParams.get('q');

      // GitHub first: a repo URL is unambiguous, and a bare "owner/repo" would
      // otherwise be searched for as an article title.
      const gh = parseRepoInput(q);
      if (gh) {
        try {
          const atlas = await buildAtlas(gh.owner, gh.repo);
          return json(res, 200, {
            ok: true, source: 'github', kind: atlas.kind,
            lang: 'en',
            title: atlas.title,
            description: atlas.description,
            thumbnail: atlas.avatar,
            href: `/atlas/${gh.owner}/${gh.repo}`,
            entries: atlas.stats.entries,
            languageSupported: true,
          });
        } catch (e) {
          const missing = e.status === 404;
          // A typed "AC/DC" is a band, not a repository. When the bare form does
          // not exist on GitHub, fall through and let Wikipedia have it.
          if (!(missing && gh.form === 'bare')) {
            return json(res, missing ? 404 : 502, {
              error: missing ? `No repository ${gh.owner}/${gh.repo}.` : 'GitHub did not answer. Try again in a moment.',
            });
          }
        }
      }

      const parsed = parseWikiInput(q);
      if (!parsed) return json(res, 400, { error: 'Not a Wikipedia link, a GitHub repository, or an article title.' });
      try {
        const s = await fetchSummary(parsed.title, parsed.lang);
        if (s.type === 'disambiguation') {
          return json(res, 200, { ok: false, reason: 'disambiguation', ...parsed, title: s.titles?.normalized || parsed.title });
        }
        const title = s.titles?.normalized || parsed.title;
        return json(res, 200, {
          ok: true,
          lang: parsed.lang,
          title,
          description: s.description || '',
          extract: s.extract || '',
          thumbnail: s.thumbnail?.source || null,
          href: readPath(parsed.lang, title),
          languageSupported: isSupported(parsed.lang),
          languageName: languageName(parsed.lang),
        });
      } catch (e) {
        const missing = e.status === 404;
        return json(res, missing ? 404 : 502, {
          error: missing
            ? `No article "${parsed.title}" on ${languageName(parsed.lang)} Wikipedia.`
            : 'Wikipedia did not answer. Try again in a moment.',
          ...parsed,
        });
      }
    }

    // A repository whose README is a dataset becomes an atlas. Same contract as
    // /api/book: give it a name, get back the built thing.
    if (path.startsWith('/api/atlas/')) {
      const [owner, repo] = path.slice('/api/atlas/'.length).split('/');
      if (!owner || !repo) return json(res, 400, { error: 'owner and repo required' });
      const t = Date.now();
      const atlas = await buildAtlas(owner, repo, { force: url.searchParams.has('force') });
      console.log(`[atlas] ${atlas.fullName} · ${atlas.kind} · ${atlas.stats.servedFromCache ? 'cache' : 'built'} ${Date.now() - t}ms`);
      return json(res, 200, atlas);
    }

    if (path.startsWith('/atlas/')) return sendFile(res, join(PUBLIC, 'atlas.html'));

    if (path === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      const lang = url.searchParams.get('lang') || 'en';
      if (q.length < 2) return json(res, 200, { results: [] });
      const results = await searchTitles(q, lang, 8);
      return json(res, 200, {
        results: results.map((r) => ({ ...r, href: readPath(lang, r.title) })),
      });
    }

    // Intent, not prediction: the client calls this when the reader reaches for
    // something. Returns immediately — the build happens behind the request.
    if (path === '/api/warm') {
      const title = url.searchParams.get('title');
      const lang = url.searchParams.get('lang') || 'en';
      if (!title) return json(res, 400, { error: 'title required' });
      return json(res, 202, { title, lang, state: warm(title, lang) });
    }

    // What is already bound, and therefore opens instantly. Read off the cache
    // directory rather than a hand-kept list, so the shelf cannot drift.
    if (path === '/api/shelf') return json(res, 200, { books: await shelf() });

    // Which other Wikipedias carry this article. Ordered so the editions whose
    // section names and date grammar we know come first: those produce a whole
    // book, the rest produce one without a chronology.
    if (path === '/api/languages') {
      const title = url.searchParams.get('title');
      const lang = url.searchParams.get('lang') || 'en';
      if (!title) return json(res, 400, { error: 'title required' });
      const links = await fetchLangLinks(title, lang);
      const entries = links.map((l) => ({
        lang: l.lang,
        autonym: l.autonym || l.lang,
        name: l.langname || l.lang,
        title: l.title,
        supported: isSupported(l.lang),
        href: readPath(l.lang, l.title),
      }));
      entries.sort((a, b) =>
        (b.supported - a.supported) || a.autonym.localeCompare(b.autonym));
      return json(res, 200, {
        current: { lang, title, autonym: languageName(lang), supported: isSupported(lang) },
        languages: entries,
      });
    }

    if (path === '/api/engine') {
      return json(res, 200, {
        gate: gateStats(),
        warm: { ...warmStats, active: warmActive, queued: warmQueue.map((q) => q.key), remembered: warmed.size },
        building: inflightTitles(),
      });
    }

    if (path.startsWith('/api/book/')) {
      const title = path.slice('/api/book/'.length);
      if (!title) return json(res, 400, { error: 'title required' });
      const force = url.searchParams.has('force');
      const lang = url.searchParams.get('lang') || 'en';

      if (url.searchParams.has('stream')) return streamBook(res, title, force, lang);

      const t = Date.now();
      const book = await buildBook(title, { force, lang });
      console.log(`[book] ${book.title} · ${book.archetype} · ${book.stats.servedFromCache ? 'cache' : 'built'} ${Date.now() - t}ms`);
      return json(res, 200, book);
    }

    if (path.startsWith('/api/summary/')) {
      const title = path.slice('/api/summary/'.length);
      const s = await fetchSummary(title, url.searchParams.get('lang') || 'en');
      return json(res, 200, {
        title: s.titles?.normalized || title,
        extract: s.extract || '',
        description: s.description || '',
        thumbnail: s.thumbnail?.source || null,
        url: s.content_urls?.desktop?.page || null,
      });
    }

    if (path.startsWith('/read/')) return sendFile(res, join(PUBLIC, 'index.html'));
    if (path === '/read' || path === '/read/') return redirect(res, '/');

    return sendFile(res, join(PUBLIC, path === '/' ? 'index.html' : path));
  } catch (err) {
    const status = err.status === 404 ? 404 : 500;
    console.error(`[error] ${path}:`, err.message);
    return json(res, status, { error: err.message, path });
  }
});

/**
 * Newline-delimited JSON, one frame per build milestone. The reader paints the
 * `partial` frame — cover, spine, notes, chronology — and splices the apparatus
 * in when the second frame lands, so reading starts before the build finishes.
 */
async function streamBook(res, title, force, lang = 'en') {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no', // in case anything downstream would buffer us
  });

  const frame = (obj) => { if (!res.writableEnded) res.write(`${JSON.stringify(obj)}\n`); };
  let sentText = false;
  const t = Date.now();

  try {
    const book = await buildBook(title, {
      force,
      lang,
      onEvent: (ev) => {
        if (ev.type === 'stage') return frame(ev);
        if (ev.type === 'partial') { sentText = true; frame({ type: 'text', book: ev.book }); }
      },
    });
    // A cache hit never emits a partial, so the complete book *is* the first
    // paint and there is no apparatus frame to follow it.
    if (sentText) frame({ type: 'apparatus', blocks: book.blocks, stats: book.stats });
    else frame({ type: 'text', book });
    frame({ type: 'done' });
    console.log(`[stream] ${book.title} · ${book.archetype} · ${book.stats.servedFromCache ? 'cache' : 'built'} ${Date.now() - t}ms`);
  } catch (err) {
    console.error(`[stream] ${title}:`, err.message);
    frame({ type: 'error', error: err.message });
  }
  return res.end();
}

// ---- the shelf -----------------------------------------------------------

async function shelf() {
  const entries = await catalogueEntries(24);
  return entries.map((b) => ({ ...b, href: readPath(b.lang, b.title) }));
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-cache' });
  res.end(payload);
}

function redirect(res, to) {
  res.writeHead(302, { location: to });
  res.end();
}

async function sendFile(res, file) {
  const safe = normalize(file);
  if (!safe.startsWith(PUBLIC)) { res.writeHead(403); return res.end('forbidden'); }
  try {
    const body = await readFile(safe);
    res.writeHead(200, { 'content-type': MIME[extname(safe)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  }
}

server.listen(PORT, () => {
  console.log(`wikibook reading room  →  http://localhost:${PORT}/read/${DEFAULT_TITLE}`);
});
