#!/usr/bin/env node
// Rebuilds every seeded book at its article's current revision.
//
// A seed is keyed (lang, title, revid, TEMPLATE_VERSION). Wikipedia articles of
// the size we seed are edited weekly, so a seed a month old is a cache miss on
// every cold machine and the "instant" showcase costs the visitor 10–30s.
// Run this before a deploy:  node scripts/refresh-seeds.mjs
import { readdir, copyFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Must be set before src/wiki.js loads, hence the dynamic import below.
process.env.ARTICLE_TTL_MS = '0';
const { buildBook } = await import('../src/book.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SEED = join(ROOT, 'seed/books');
const CACHE = join(ROOT, '.cache/books');

const files = (await readdir(SEED)).filter((f) => f.endsWith('.json'));
let changed = 0;
for (const f of files) {
  const m = /^([a-z-]+)\.(.+)\.r(\d+)\.v(\d+)\.json$/.exec(f);
  if (!m) { console.warn(`skip ${f}: not a seed name`); continue; }
  const [, lang, title] = m;
  const t = Date.now();
  // force: the local .cache may hold this exact key from an older template
  // run; a seed must be what this checkout's code produces.
  const book = await buildBook(title.replace(/_/g, ' '), { lang, force: true });
  const built = (await readdir(CACHE)).find((x) =>
    x.startsWith(`${lang}.`) && x.includes(`.r${book.revid}.v${book.stats.templateVersion}.json`)
    && x.slice(lang.length + 1).startsWith(title));
  if (!built) { console.warn(`${lang}:${title}: built, but cache file not found — seed left alone`); continue; }
  if (built === f) { console.log(`${lang}:${title} already current`); continue; }
  await copyFile(join(CACHE, built), join(SEED, built));
  await unlink(join(SEED, f));
  changed++;
  console.log(`${lang}:${title}  ${f.match(/\.r\d+/)[0]} → .r${book.revid}  (${Date.now() - t}ms)`);
}
console.log(`${changed} of ${files.length} seeds refreshed`);
