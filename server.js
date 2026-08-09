import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBook, inflightTitles } from './src/book.js';
import { fetchSummary, withPriority, gateStats } from './src/wiki.js';

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

function warm(rawTitle) {
  const title = String(rawTitle || '').replace(/_/g, ' ').trim();
  if (!title || title.length > 200) return 'rejected';
  warmStats.requested++;
  if (warmed.has(title)) return 'known';
  if (warmQueue.includes(title)) return 'queued';
  // A reader who hovers faster than we can build is telling us the earlier
  // guesses were wrong, so the newest intent wins and the stalest is dropped.
  if (warmQueue.length >= WARM_MAX_QUEUED) { warmQueue.shift(); warmStats.dropped++; }
  warmQueue.push(title);
  pumpWarm();
  return 'queued';
}

function pumpWarm() {
  while (warmActive < WARM_MAX_INFLIGHT && warmQueue.length) {
    const title = warmQueue.shift();
    if (warmed.size > WARM_MEMORY) warmed.clear();
    warmed.add(title);
    warmActive++;
    withPriority('bg', () => buildBook(title))
      .then((b) => {
        warmStats.built++;
        console.log(`[warm] ${b.title} · ${b.stats.servedFromCache ? 'cache' : `${b.stats.buildMs}ms`}`);
      })
      .catch((e) => { warmStats.failed++; console.warn(`[warm] ${title}: ${e.message}`); })
      .finally(() => { warmActive--; pumpWarm(); });
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);

  try {
    if (path === '/') return redirect(res, `/read/${DEFAULT_TITLE}`);

    // Intent, not prediction: the client calls this when the reader reaches for
    // something. Returns immediately — the build happens behind the request.
    if (path === '/api/warm') {
      const title = url.searchParams.get('title');
      if (!title) return json(res, 400, { error: 'title required' });
      return json(res, 202, { title, state: warm(title) });
    }

    if (path === '/api/engine') {
      return json(res, 200, {
        gate: gateStats(),
        warm: { ...warmStats, active: warmActive, queued: warmQueue.slice(), remembered: warmed.size },
        building: inflightTitles(),
      });
    }

    if (path.startsWith('/api/book/')) {
      const title = path.slice('/api/book/'.length);
      if (!title) return json(res, 400, { error: 'title required' });
      const force = url.searchParams.has('force');

      if (url.searchParams.has('stream')) return streamBook(res, title, force);

      const t = Date.now();
      const book = await buildBook(title, { force });
      console.log(`[book] ${book.title} · ${book.archetype} · ${book.stats.servedFromCache ? 'cache' : 'built'} ${Date.now() - t}ms`);
      return json(res, 200, book);
    }

    if (path.startsWith('/api/summary/')) {
      const title = path.slice('/api/summary/'.length);
      const s = await fetchSummary(title);
      return json(res, 200, {
        title: s.titles?.normalized || title,
        extract: s.extract || '',
        description: s.description || '',
        thumbnail: s.thumbnail?.source || null,
        url: s.content_urls?.desktop?.page || null,
      });
    }

    if (path.startsWith('/read/')) return sendFile(res, join(PUBLIC, 'index.html'));

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
async function streamBook(res, title, force) {
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
