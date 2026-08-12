// GitHub clients.
//
// The README is fetched *rendered*, not raw. GitHub will return its own HTML
// for a markdown file, which means footnote markers, task lists, tables and
// autolinks arrive as real elements — the same situation Parsoid gives us on
// the Wikipedia side, and parseable with the same discipline instead of a
// markdown grammar of our own.
import { fetchCached } from '../wiki.js';

const API = 'https://api.github.com';

// Unauthenticated GitHub allows 60 requests an hour, which one impatient
// afternoon can exhaust. A token lifts it to 5,000; everything is disk-cached
// either way, so a repo costs two requests once and nothing after that.
const TOKEN = process.env.GITHUB_TOKEN || '';

function headers(accept = 'application/vnd.github+json') {
  const h = { Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}

/** owner/repo from any GitHub URL, or from "owner/repo" typed directly. */
export function parseRepoInput(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;

  // "owner/repo" typed bare is genuinely ambiguous — "AC/DC" is a band before
  // it is a repository — so the form is reported and the caller decides what to
  // do when no such repository exists.
  const bare = /^([\w.-]+)\/([\w.-]+)$/.exec(input);
  if (bare) return { owner: bare[1], repo: bare[2].replace(/\.git$/, ''), form: 'bare' };

  let url;
  try {
    url = new URL(input.startsWith('http') ? input : `https://${input}`);
  } catch { return null; }
  if (!/^(www\.)?github\.com$/i.test(url.hostname)) return null;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, ''), form: 'url' };
}

export async function fetchRepo(owner, repo) {
  const { body } = await fetchCached(`${API}/repos/${owner}/${repo}`, {
    json: true, ttlMs: 864e5, headers: headers(),
  });
  return body;
}

/** The README, already rendered to HTML by GitHub. */
export async function fetchReadmeHtml(owner, repo, ref = '') {
  const url = `${API}/repos/${owner}/${repo}/readme${ref ? `?ref=${encodeURIComponent(ref)}` : ''}`;
  const { body } = await fetchCached(url, {
    ttlMs: 864e5, headers: headers('application/vnd.github.html+json'),
  });
  return body;
}
