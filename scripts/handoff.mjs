#!/usr/bin/env node
// Regenerates STATE.md — the handoff a fresh session reads.
//
// Everything here is measured, never recalled. A handoff written from memory is
// exactly the thing that goes stale and misleads the next session, which is the
// same reason nothing else in this project is allowed to guess.
//
//   node scripts/handoff.mjs           local facts only (fast, for hooks)
//   node scripts/handoff.mjs --probe   also ask production what it is serving

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const sh = (cmd) => { try { return execSync(cmd, { encoding: 'utf8' }).trim(); } catch { return ''; } };
const PROD = 'https://readingroom.booga.me';

function versions() {
  const grab = (file, name) => {
    const m = new RegExp(`${name}\\s*=\\s*(\\d+)`).exec(readFileSync(file, 'utf8'));
    return m ? m[1] : '?';
  };
  return {
    template: grab('src/book.js', 'TEMPLATE_VERSION'),
    atlas: grab('src/github/atlas.js', 'ATLAS_VERSION'),
    catalogue: grab('src/eips/catalogue.js', 'CATALOGUE_VERSION'),
  };
}

/** Seeds built at an older version are stale and will rebuild live on a cold box. */
function seedHealth(v) {
  let books = [];
  try { books = readdirSync('seed/books').filter((f) => f.endsWith('.json')); } catch { /* none */ }
  const stale = books.filter((f) => !f.includes(`.v${v.template}.`));
  return { count: books.length, stale: stale.length };
}

async function probe() {
  const paths = ['/', '/read/Battle_of_Stalingrad', '/atlas/eips',
    '/atlas/pcaversaccio/reentrancy-attacks', '/api/library/me'];
  const out = [];
  for (const p of paths) {
    let status = 'unreachable';
    try {
      const ctl = AbortSignal.timeout(20000);
      status = String((await fetch(PROD + p, { signal: ctl })).status);
    } catch { /* keep unreachable */ }
    out.push({ path: p, status });
  }
  return out;
}

const v = versions();
const seeds = seedHealth(v);
const dirty = sh('git status --porcelain').split('\n').filter(Boolean);
const unpushed = sh('git rev-list --count @{u}..HEAD 2>/dev/null') || '0';
const live = process.argv.includes('--probe') ? await probe() : null;

const md = `# STATE — generated, do not hand-edit

Written by \`scripts/handoff.mjs\` on every compaction and session end. Every line
is measured from the repo or from production; nothing here is recalled. If it
disagrees with the code, the code is right — regenerate rather than patch.

Last written: ${new Date().toISOString().replace('T', ' ').slice(0, 16)} UTC

## Where the work is

- HEAD: \`${sh('git log -1 --format="%h %s"')}\`
- Unpushed commits: **${unpushed}**
- Uncommitted files: **${dirty.length}**${dirty.length ? `\n${dirty.slice(0, 12).map((l) => `  - \`${l}\``).join('\n')}` : ''}

## Cache versions

Bump these when changing what they build, or nothing rebuilds.

| Constant | Value | Lives in |
|---|---|---|
| \`TEMPLATE_VERSION\` | ${v.template} | \`src/book.js\` |
| \`ATLAS_VERSION\` | ${v.atlas} | \`src/github/atlas.js\` |
| \`CATALOGUE_VERSION\` | ${v.catalogue} | \`src/eips/catalogue.js\` |

Seeded books: ${seeds.count}${seeds.stale ? ` — **${seeds.stale} built at an older template version**, regenerate them` : ' (all current)'}

${live ? `## Production right now

| Path | |
|---|---|
${live.map((r) => `| \`${r.path}\` | ${r.status} |`).join('\n')}

A 404 on \`/api/library/me\` means libraries are still not deployed.
` : '## Production\n\nNot probed this run. `node scripts/handoff.mjs --probe` to check.\n'}
## Open decisions (a human must make these)

- **Libraries are built and pushed but not deployed.** \`fly.toml\` declares a
  volume mount that does not exist, so \`fly deploy\` fails until either
  \`fly volumes create reading_room_data --size 1 --region sin\` +
  \`fly scale count 1\` (volumes attach to one machine and do not replicate), or
  the volume is swapped for a shared store to keep two machines.
- **\`GITHUB_TOKEN\` is unset in production**, so only seeded repos build there;
  GitHub allows 60 unauthenticated requests an hour per IP.

Neither should be actioned without the user asking: both provision paid
resources or reduce redundancy.
`;

writeFileSync('STATE.md', md);
console.log(`STATE.md written — HEAD ${sh('git log -1 --format=%h')}, ${dirty.length} dirty, ${unpushed} unpushed`);
