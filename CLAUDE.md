# Working on Reading Room

Turns Wikipedia articles into interactive books, and structured web sources into
interactive atlases. `README.md` explains *what* it does and why each design
choice was made — read it first. This file is about *how to work on it*.

Live: https://readingroom.booga.me · Repo: `boogaav/reading-room` (private)

## The one rule

**No language model is involved in the pipeline, anywhere.** Every block on
every page is a deterministic transform of a source: Parsoid HTML, Wikidata
claims, GitHub's rendered README, a published HTML table. This is the whole
premise, it is stated on the site and in the colophon of every page, and it is
not negotiable without the user explicitly deciding to abandon it.

If output looks thin, the source is thin. Say so; do not fill the gap.

## Honesty rules (design constraints, not preferences)

These are what make a no-model pipeline trustworthy. Breaking one is a bug.

1. **Never rewrite prose.** Text is reorganised and re-presented, never regenerated.
2. **Never hide a parse miss.** Show the source wording verbatim instead of
   dropping it — see the `forces` block on `/read/Battle_of_Hastings`.
3. **Never contradict the source.** Where an infobox and Wikidata disagree, the
   infobox wins: it is what the reader is about to read.
4. **Label what a thing actually is.** The EIP histogram says *number space*, not
   time, because proposal numbers only approximate time.
5. **Say what is not counted.** Proposer counts come from GitHub handles only,
   and the block says names without a handle are excluded.
6. **Show provenance.** Every page's colophon carries source, revision, licence.
7. **A gap is a finding.** Silent years stay in histograms as empty columns.

## Layout

```
server.js              routes; plain node:http, no framework
src/wiki.js            all upstream fetching + disk cache + concurrency gate
src/book.js            orchestrates a book; owns TEMPLATE_VERSION and the catalogue
src/lang.js            per-language section names + date grammar (7 known)
src/archetype.js       P31 → P279* walk → which template pack
src/extract/*.js       Parsoid HTML + Wikidata → structure
src/templates/index.js one function per archetype → blocks[]
src/github/*.js        repo → ledger atlas
src/eips/catalogue.js  eips.ethereum.org → catalogue atlas
src/library/store.js   named shelves, scrypt-hashed codes, sessions
public/*.js            one renderer per page + shared theme/voice/shelf/keep modules
```

Client modules are shared on purpose: `shelf.js` draws spines for both the home
page and a library, `theme.js`/`voice.js`/`keep.js` are used by every page. The
shelf renderer was duplicated once and drifted — do not duplicate it again.

## Conventions that bite

- **Bump `TEMPLATE_VERSION` in `src/book.js`** after changing anything under
  `src/` that affects book output. It is part of the cache key; without a bump
  nothing rebuilds and you will debug stale output for twenty minutes.
  `ATLAS_VERSION` and `CATALOGUE_VERSION` work the same way.
- Cache keys: books `(lang, title, revid, TEMPLATE_VERSION)`, atlases
  `(owner, repo, pushed_at, ATLAS_VERSION)`.
- `.cache/` is rebuildable and gitignored. `data/` is user libraries — never
  committed, never a build artefact.
- `seed/` ships pre-built books and atlases inside the Docker image so a cold
  machine serves instantly. Regenerate after a version bump or the seeds go stale.
- Node built-ins + `cheerio` only. Do not add dependencies without asking.

## Gotchas already paid for

- **Wikimedia rejects arbitrary thumbnail widths** (400, not 404). Only
  `120/250/330/500/960/1280/1920`. `normaliseImage` snaps to these.
- **Parsoid refs from template transclusion** carry
  `typeof="mw:Transclusion mw:Extension/ref"` — an exact-match selector misses
  ~1 in 7. Use `REF_SEL`.
- **GitHub unauthenticated API is 60 req/hour per IP** and a shared host's
  address is usually already spent. Set `GITHUB_TOKEN` for real use.
- **Port 5208 is often held by another session's dev server.** Use
  `PORT=5299 DATA_DIR=/tmp/rr-data node server.js` for isolated testing.
- **The browser preview pane goes hidden mid-session**, which collapses layout to
  zero width and blanks screenshots. Check `innerWidth`/`visibilityState` before
  concluding the page is broken; a tall viewport + reload usually recovers it.
- Verify rendered DOM, not just HTTP 200 — `/read/x` returns 200 even when the
  client fails.

## Start here

`STATE.md` is generated from measured facts — HEAD, dirty files, cache versions,
seed freshness, and what production is actually serving. It is gitignored, so if
it is missing:

```bash
node scripts/handoff.mjs --probe
```

It rewrites itself automatically before every compaction and at session end
(`.claude/settings.json`). Prefer it over the summary below, which is a snapshot
written by hand and can age.

## State as of the last session

**On prod:** books (4 archetypes, 7 languages), both atlases, home bookshelf,
themes, voice reading, language switcher.

**Built, tested, pushed, NOT deployed:** libraries (`/<name>` + secret code).
Deploying currently *fails* — `fly.toml` declares a volume mount that does not
exist yet. Two open decisions, both the user's:

1. `fly volumes create reading_room_data --size 1 --region sin` and
   `fly scale count 1` (Fly volumes attach to one machine and do not replicate,
   so two machines would split libraries in two) — **or** swap the volume for a
   shared store (Fly Postgres/Redis) to keep two machines.
2. `fly secrets set GITHUB_TOKEN=…` so arbitrary repos build in production
   rather than only the seeded one.

Do not run either without the user saying so: both provision paid resources or
reduce redundancy.

## Deploying

```bash
export FLY_ACCESS_TOKEN=$(grep -m1 access_token ~/.fly/config.yml | sed 's/.*access_token: *//' | tr -d '"'"'"' ')
fly deploy --now --yes          # takes 6–10 min; app wikibook-reading-room
```

Then verify against `https://readingroom.booga.me`, not the `.fly.dev` host.
