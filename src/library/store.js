// Libraries: a named shelf that outlives one browser.
//
// The shelf on the home page lives in localStorage, which means it is really a
// property of a browser rather than of a person. A library is the same shelf
// with a name on the door.
//
// The "secret code" is a password by another name, so it is treated as one:
// never stored, never logged, only ever compared against a scrypt hash in
// constant time. It is deliberately *not* presented as an account system —
// there is no email, no recovery, and the UI says so, because a code that
// cannot be reset is a promise you have to make honestly.
import { mkdir, readFile, writeFile, readdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scrypt as scryptCb, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb);

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
// Deliberately not `.cache`: that directory is a rebuildable derivative and is
// wiped on every deploy. A library is the only thing here that cannot be
// regenerated from upstream, so it lives somewhere a volume can be mounted.
export const DATA_DIR = process.env.DATA_DIR || join(ROOT, 'data');
const LIBRARIES = join(DATA_DIR, 'libraries');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export const MIN_CODE = 8;
export const MAX_ITEMS = 500;

// Anything already meaningful at the root of the site, so a library can never
// shadow a route or a static file.
const RESERVED = new Set([
  'read', 'atlas', 'api', 'assets', 'static', 'public', 'admin', 'login', 'logout',
  'signin', 'signup', 'settings', 'about', 'help', 'search', 'new', 'index',
  'robots.txt', 'favicon.ico', 'sitemap.xml',
  'home.html', 'home.js', 'home.css', 'index.html', 'reader.js', 'reader.css',
  'atlas.html', 'atlas.js', 'atlas.css', 'theme.js', 'voice.js', 'history.js',
  'library.html', 'library.js', 'library.css',
]);

/** Usernames are a URL path segment, so the rules are the strict ones. */
export function normaliseUsername(raw) {
  const name = String(raw || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{1,29}$/.test(name)) return null;
  if (RESERVED.has(name)) return null;
  if (name.includes('.')) return null;
  return name;
}

export function isReserved(name) {
  return RESERVED.has(String(name || '').toLowerCase());
}

// ---- hashing --------------------------------------------------------------

async function hashCode(code, salt = randomBytes(16)) {
  const key = await scrypt(String(code), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return { salt: salt.toString('base64'), hash: key.toString('base64'), ...SCRYPT };
}

async function verifyCode(code, stored) {
  if (!stored?.salt || !stored?.hash) return false;
  const key = await scrypt(String(code), Buffer.from(stored.salt, 'base64'), stored.keylen || 32,
    { N: stored.N || SCRYPT.N, r: stored.r || SCRYPT.r, p: stored.p || SCRYPT.p });
  const known = Buffer.from(stored.hash, 'base64');
  // Length must match before timingSafeEqual, which throws on a mismatch.
  return key.length === known.length && timingSafeEqual(key, known);
}

// ---- persistence ----------------------------------------------------------

const fileFor = (name) => join(LIBRARIES, `${name}.json`);

export async function readLibrary(name) {
  try { return JSON.parse(await readFile(fileFor(name), 'utf8')); }
  catch { return null; }
}

/** Write via a temp file and rename, so a crash cannot truncate a library. */
async function writeLibrary(lib) {
  await mkdir(LIBRARIES, { recursive: true });
  const tmp = fileFor(`.${lib.username}.${process.pid}.tmp`);
  await writeFile(tmp, JSON.stringify(lib, null, 2));
  await rename(tmp, fileFor(lib.username));
  return lib;
}

/** What a visitor may see: everything except the code. */
export function publicView(lib) {
  if (!lib) return null;
  const { code, ...rest } = lib;
  return rest;
}

// ---- opening and claiming -------------------------------------------------

/**
 * One door for both cases. An unclaimed name is claimed by whoever opens it
 * first; a claimed one needs its code. The caller cannot tell the two apart
 * from the response, which is the point — probing for existing names should
 * not be easier than guessing a code.
 */
export async function openLibrary(rawName, code) {
  const username = normaliseUsername(rawName);
  if (!username) {
    return { ok: false, reason: 'name', message: 'Two to thirty characters: letters, digits, hyphen or underscore.' };
  }
  if (String(code || '').length < MIN_CODE) {
    return { ok: false, reason: 'code', message: `The secret code needs at least ${MIN_CODE} characters.` };
  }

  const existing = await readLibrary(username);
  if (!existing) {
    const lib = {
      username,
      title: `${username}'s library`,
      visibility: 'public',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      items: [],
      code: await hashCode(code),
    };
    await writeLibrary(lib);
    return { ok: true, created: true, library: publicView(lib) };
  }

  if (!(await verifyCode(code, existing.code))) {
    return { ok: false, reason: 'auth', message: 'That name is taken and the code does not match it.' };
  }
  return { ok: true, created: false, library: publicView(existing) };
}

// ---- items ----------------------------------------------------------------

const keyOf = (item) => `${item.kind || 'book'}:${item.lang || 'en'}:${item.href}`;

export async function addItem(username, item) {
  const lib = await readLibrary(username);
  if (!lib) return null;
  if (!item?.href || !item?.title) return publicView(lib);

  const entry = {
    kind: item.kind === 'atlas' ? 'atlas' : 'book',
    lang: String(item.lang || 'en').slice(0, 12),
    title: String(item.title).slice(0, 300),
    href: String(item.href).slice(0, 500),
    archetype: String(item.archetype || 'generic').slice(0, 40),
    subtitle: String(item.subtitle || '').slice(0, 400),
    cover: /^https:\/\//.test(item.cover || '') ? String(item.cover).slice(0, 800) : null,
    words: Number(item.words) || 0,
    chapters: Number(item.chapters) || 0,
    addedAt: Date.now(),
  };

  // Re-adding moves a volume to the front rather than duplicating it.
  lib.items = [entry, ...lib.items.filter((i) => keyOf(i) !== keyOf(entry))].slice(0, MAX_ITEMS);
  lib.updatedAt = Date.now();
  await writeLibrary(lib);
  return publicView(lib);
}

export async function removeItem(username, href) {
  const lib = await readLibrary(username);
  if (!lib) return null;
  lib.items = lib.items.filter((i) => i.href !== href);
  lib.updatedAt = Date.now();
  await writeLibrary(lib);
  return publicView(lib);
}

export async function setDetails(username, { title, visibility }) {
  const lib = await readLibrary(username);
  if (!lib) return null;
  if (typeof title === 'string' && title.trim()) lib.title = title.trim().slice(0, 120);
  if (visibility === 'public' || visibility === 'private') lib.visibility = visibility;
  lib.updatedAt = Date.now();
  await writeLibrary(lib);
  return publicView(lib);
}

/** Public libraries only, newest first — the front desk, not a user directory. */
export async function listPublic(limit = 24) {
  let files = [];
  try { files = await readdir(LIBRARIES); } catch { return []; }
  const out = [];
  for (const f of files) {
    if (!f.endsWith('.json') || f.startsWith('.')) continue;
    const lib = await readLibrary(f.replace(/\.json$/, ''));
    if (!lib || lib.visibility !== 'public' || !lib.items.length) continue;
    out.push({
      username: lib.username, title: lib.title,
      count: lib.items.length, updatedAt: lib.updatedAt,
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
}

// ---- sessions -------------------------------------------------------------

let secretPromise = null;

/**
 * The signing key. Taken from the environment when set; otherwise generated
 * once and kept beside the libraries, so sessions survive a restart but a fresh
 * disk simply signs everyone out rather than trusting an old cookie.
 */
async function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (secretPromise) return secretPromise;
  secretPromise = (async () => {
    const path = join(DATA_DIR, '.session-secret');
    try { return (await readFile(path, 'utf8')).trim(); } catch { /* first run */ }
    const made = randomBytes(32).toString('base64url');
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(path, made, { mode: 0o600 });
    return made;
  })();
  return secretPromise;
}

const TTL_MS = 1000 * 60 * 60 * 24 * 30;

export async function mintSession(username) {
  const exp = Date.now() + TTL_MS;
  const body = `${username}.${exp}`;
  const sig = createHmac('sha256', await sessionSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export async function readSession(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [username, exp, sig] = parts;
  if (!normaliseUsername(username)) return null;
  if (!Number(exp) || Number(exp) < Date.now()) return null;

  const expected = createHmac('sha256', await sessionSecret()).update(`${username}.${exp}`).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return username;
}

// ---- attempt throttling ---------------------------------------------------

const attempts = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 8;

/** Slows guessing without needing a store; per name+origin, in memory. */
export function tooManyAttempts(key) {
  const now = Date.now();
  const rec = attempts.get(key);
  if (!rec || now - rec.first > WINDOW_MS) return false;
  return rec.count >= MAX_ATTEMPTS;
}

export function noteAttempt(key, ok) {
  const now = Date.now();
  if (ok) return attempts.delete(key);
  const rec = attempts.get(key);
  if (!rec || now - rec.first > WINDOW_MS) attempts.set(key, { first: now, count: 1 });
  else rec.count++;
}
