import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildBook } from './src/book.js';
import { fetchSummary } from './src/wiki.js';

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

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = decodeURIComponent(url.pathname);

  try {
    if (path === '/') return redirect(res, `/read/${DEFAULT_TITLE}`);

    if (path.startsWith('/api/book/')) {
      const title = path.slice('/api/book/'.length);
      if (!title) return json(res, 400, { error: 'title required' });
      const t = Date.now();
      const book = await buildBook(title, { force: url.searchParams.has('force') });
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
