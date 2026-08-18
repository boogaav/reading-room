# Reading Room

Turns any Wikipedia article into an interactive book. **No language model is involved
anywhere in this pipeline** — every block on the page is a deterministic transform of
Parsoid HTML and Wikidata claims.

```bash
npm start               # http://localhost:5208
```

The home page takes a pasted Wikipedia link — from any language edition — or a typed
title with autocomplete. Direct routes work too:

| Route | |
|---|---|
| `/read/<Title>` | English |
| `/read/<lang>/<Title>` | any other Wikipedia, e.g. `/read/de/Uruguay` |

## Languages

Almost nothing here is language-bound. Archetypes, coordinates, dates, populations and
rulers all come from Wikidata, which is shared across every Wikipedia. Only two things
are written in the article's own language: the names of its end-matter sections, and the
way its prose spells a date. Both live in `src/lang.js`.

A switcher in the rail header lists every edition that carries the article — 263 of them
for Uruguay — with each edition's own title for the subject, because switching is not a
translation of the page you are on but a move to a different article written by different
people. Editions whose section names and date grammar are known sort first; the rest are
labelled as building without a chronology. Backed by `prop=langlinks`.

`en`, `de`, `fr`, `es`, `it`, `pt`, `nl` are known. **Any other language still produces a
book** — it loses apparatus filtering (reference sections become ordinary chapters) and
the prose chronology. The home page says so before you open it, rather than quietly
serving a thinner book. Adding a language is one object literal.

## The room

`/` is a bookshelf, not a landing page. Every article you open is remembered in
`localStorage` and stands there afterwards as a spine — **thickness from word count,
height from chapter count**, hue from archetype — so the shelf is a physical read on
what you have collected. Reach for a book and it comes out of the shelf and turns to
show its front: cover plate, subtitle, and its real measurements. Books the server has
already bound stand behind yours, dimmed, because they open instantly but are unread.

Reading history never leaves the browser. The server has no account to hang it on and
does not want one; `/api/shelf` only reports what is in its own cache.

## Ink and paper

Both themes, toggled from the header and remembered, defaulting to the system setting.
The choice is applied by an inline script before first paint — a deferred module would
flash the wrong theme. Recurring effects (washes, shadows, scrims, image filters, the
cover veil) are named tokens rather than literals, so a theme is one block of overrides
instead of forty scattered edits, and the map swaps between CARTO's dark and light tiles
with it.

## Reading aloud

A button in the header of every page, using the browser's own speech
synthesiser — no key, no cost, and nothing leaves the machine.

The reader speaks the book: title, then each chapter's heading and prose in
order, skipping the apparatus (a casualty scale read as a list of figures is
noise) and stripping reference markers so numbers do not interrupt sentences.
The passage being spoken is tinted and scrolled to. The home page takes
inventory of the shelf instead.

Three things make this harder than calling `speak()` on the page text, and all
three are handled in `public/voice.js`: long utterances get truncated, so text is
cut into sentence-sized pieces; Chrome stops after ~15 seconds unless nudged, so
a watchdog resumes it; and the reader repaints when the apparatus lands, so
passages are collected at play time rather than held as stale node references.

**Which voice matters far more than any parameter.** macOS ships around fifteen
novelty voices (Bells, Boing, Zarvox, Trinoids) that are local and match `en`
perfectly, so a naive "prefer local" rule picks one of them to read a book;
Chrome's own "Google …" voices are much more natural and are *not* local. Voices
are therefore ranked — Premium/Enhanced/Neural, then Google, then Siri, then
Microsoft — with novelties removed, and the control bar lets you pick from what
your machine actually has. The choice is remembered per language.

Language travels with the passage, not the page: a shelf holding Korean, German
and Esperanto volumes speaks each title in its own voice.

## Atlases from GitHub

Some repositories are not projects but datasets — a README that is really a
table. `/atlas/<owner>/<repo>` reads one as an atlas.

The README is fetched **rendered**: GitHub will return its own HTML for a
markdown file, so footnote markers, tables and autolinks arrive as elements and
can be parsed with the same discipline Parsoid gets, instead of a markdown
grammar of our own.

The `ledger` shape is a list of dated incidents, each a line of the same
sentence. On `pcaversaccio/reentrancy-attacks` all **81 of 81** entries parse.
Detection requires most of a long list to read cleanly, which is what keeps
ordinary repositories out of the template; anything else falls back to a plain
reading of the README.

The chain each incident happened on is never stated in that repo — and does not
need to be. **The block explorer linked is the chain**: `etherscan.io` means
Ethereum as surely as `P625` means a coordinate. Fourteen chains come out of
eighty-one entries that way, and the year histogram keeps its silent years so a
gap reads as a finding rather than a missing column.

### The `catalogue` shape

`/atlas/eips` is the same idea against a source that is not GitHub: 1,194
Ethereum Improvement Proposals, faceted by where each one stands and what it
touches.

`eips.ethereum.org` publishes no API, but it publishes the same corpus cut two
ways — `/all` groups every proposal by status, and `/core`, `/erc`,
`/networking`, `/interface`, `/meta`, `/informational` group them by category.
Joining those on the proposal number costs **7 requests instead of 1,194**, and
the join is exact: every row on `/all` finds a category.

The centrepiece is the status × category matrix, because the pair is the point —
how far each kind of proposal actually gets. It says something the list does not:
**Stagnant is the largest status at 402**, ahead of Final at 279, and Core
proposals are three times likelier to be withdrawn than ERCs.

The number histogram is labelled *number space*, not time. Proposal numbers are
handed out roughly in order so it reads as a rough timeline, and rough is the
operative word.

## Libraries

The shelf on the home page lives in `localStorage`, which makes it a property of
a browser rather than of a person. A library is the same shelf with a name on
the door: visit `/<name>`, pick a secret code, and it is yours from any browser.
Press **＋** in the header of any book or atlas to keep it there.

The code is a password by another name, so it is treated as one — scrypt-hashed
with a per-library salt, compared in constant time, never stored or logged in
the clear, and rate-limited to eight attempts per name and origin per ten
minutes. Sessions are HMAC-signed cookies, `HttpOnly` and `SameSite=Lax`.

It is deliberately **not** presented as an account system. There is no email and
no recovery, and the claim page says exactly that before you choose a code.
A private library answers identically to one that does not exist, so visiting a
name cannot be used to discover whether it is taken.

### Persistence needs a decision

Libraries are the only state here that cannot be regenerated from upstream, so
they live in `DATA_DIR` (default `./data`) rather than `.cache`. On Fly that
needs a volume — and because Fly volumes attach to one machine and do not
replicate, **two machines would mean two different sets of libraries**. Running
one machine is the simple correct answer:

```bash
fly volumes create reading_room_data --size 1 --region sin --app wikibook-reading-room
fly scale count 1 --app wikibook-reading-room
fly deploy
```

`fly.toml` already carries the mount and `DATA_DIR=/data`. Without the volume the
feature still works, but every deploy wipes the libraries — which is why this is
not deployed by default.

## The v0 question

The proposal was: build the deterministic layer first, and only then decide whether an
LLM "director" pass is needed to choose and order the blocks. This is that layer.

**Verdict so far: the director pass is not needed for the four archetypes built here.**
Wikipedia's own structure carries more than expected — see "What came out free" below.
Where output is weak it is because the *source* is weak (a stub, a list article, an
abstract concept), and a model could not fix that without inventing facts.

## Architecture

```
title
  ├─ Parsoid HTML  ──► extract/source.js   sections, infobox, figures, refs, wikilinks
  ├─ Wikidata      ──► archetype.js        P31 → P279* walk → template pack
  │                    extract/entities.js links → typed/located/dated entities
  │                    extract/timeline.js prose dates → chronology
  └─ templates/    ──► blocks[]            per-archetype interactive apparatus
```

`book.js` orchestrates and caches. Cache key is **(title, revision_id, TEMPLATE_VERSION)**:
a Wikipedia edit rebuilds one book, a template change rebuilds all of them. Bump
`TEMPLATE_VERSION` in `src/book.js` after editing anything under `src/`.

Every upstream response is also cached to `.cache/`, so a cold build costs ~9–13s and a
warm rebuild ~150ms.

## The binding engine

A cold build is 20–40 seconds: Parsoid renders a big article in ~5s, then 260
wikilinks and a lineage walk cost a dozen round trips each. Wikipedia is one page
that links to everything, so a reader's journey is a walk through cold builds.
Two mechanisms make that walk feel bound already.

**Progressive binding.** `/api/book/<title>?stream=1` returns newline-delimited
JSON, one frame per real milestone. The article's own text — cover, spine, notes,
chronology — needs no entity resolution, so it is emitted as soon as it is
parsed, and the apparatus follows when it lands:

```
{"type":"stage","name":"revision","at":896,"revid":1368082269}
{"type":"stage","name":"parsed","at":1274,"chapters":42,"notes":474,"links":1297}
{"type":"text","book":{…}}          ← reader starts reading here
{"type":"stage","name":"resolving","at":7089,"links":260}
{"type":"apparatus","blocks":[…]}   ← blocks splice in above the spine
```

On *Poland* that is a readable book at **7.1s** instead of a spinner until 39s.
The two phases are the same `buildBlocks` call twice: with no entities the packs
degrade to exactly the shape they already use for a subject whose links don't
resolve. There is no second renderer to keep in step.

The reader reuses the spine node across the two paints and compensates scroll
against it, so the apparatus arriving never moves the paragraph you are reading.

**Intent-driven warming.** Hovering a link for 120ms, focusing it, or pressing on
it calls `/api/warm?title=…`, which builds the book behind the page you are on.
Measured: a warmed volume opens in **0.4s** against **30.5s** cold.

This is deliberately timid, and the restraint is the point — warming everything a
page links to would be four times more effective and would also be a crawler,
which is what this repo's `robots.txt` exists to prevent. So: one build at a
time, a queue of 8 that drops its stalest entry, 24 speculative builds per
reading session, never on `saveData`, and only ever from an explicit reach.
Background builds run behind foreground ones on the network gate and can hold at
most two of its four slots, so speculation cannot slow the page you are reading.
Builds are deduplicated by title, so clicking a link that is already warming
joins that build instead of racing a second copy of it.

`GET /api/engine` reports the gate, the warm queue and what is building.

## Archetypes

Selected by walking the subclass graph upward from the subject's `P31`. First root hit wins.

| Archetype | Detected via | Blocks |
|---|---|---|
| `person` | human | vitals · contemporaries axis · places map · chronology |
| `battle` | battle / war / conflict / military operation | belligerents · order of battle · forces comparison · casualty scale · dramatis personae · theatre map · chronology |
| `country` | country / sovereign state / historical country / constituent state / federation | insignia · chain of states · dated series · tenure axis · territory map · the record · chronology |
| `place` | settlement / geographic location / admin entity | stats · situation map · gazetteer · chronology |
| `generic` | fallback | facts · map · chronology |

Order is priority — the first root hit wins, and it matters: every country is also a
geographic location, so `country` is checked before `place`. Federated states (Bavaria,
California) reach `country` through `Q7275` and get the same treatment, which is the
intended reading of "constituent state".

All five then get the reading spine, adjacent volumes, and end notes. Adding an archetype
is one function in `src/templates/index.js`.

### The `country` pack

A nation is a sequence of states, so the book reads as one. Four of its blocks exist only
because Wikidata statement **qualifiers** are kept — `claimValues()` returns mainsnak
values and throws qualifiers away, which is right for "what is this thing's population"
and useless for "what were its populations". `claimStatements()` in `src/wiki.js` returns
`{ value, qualifiers, rank }`, and `src/extract/country.js` is built on it.

- **Chain of states** — `P1365`/`P1366`/`P155`/`P156` walked both ways, three hops,
  deduped and bounded, each node dated by `P571`/`P576` and flagged by `P41`. The Soviet
  Union resolves to *Russian Empire → Russian Republic → RSFSR → **USSR** → Russia,
  Belarus, Ukraine, Georgia, Moldova, Armenia (+11 not shown)*.
- **Dated series** — `P1082`/`P1081`/`P2131` plotted from their `P585` qualifiers as
  inline SVG. Only one measurement basis is charted at a time; see "Honesty rules".
- **Tenure axis** — `P35`/`P6` with `P580`/`P582`, portraits batched from enwiki.
- **Territory** — `P47` neighbours and `P150` subdivisions as two toggleable pin layers
  on the existing map block.

Countries disagree about which qualifier names what a founding date is the founding *of*:
Japan uses `P805`, Ukraine and France use `P4649`, and Ukraine's 1991 statement names only
its immediate cause (`P1478`). All three are tried, in that order. `P828` "has cause" is
deliberately not — Ukraine's 1991 cause is the Soviet coup attempt, and labelling a
founding with a coup would state something false.

Three country-specific tweaks live outside the pack: the chronology accepts bare years
(`bareYears`, off for every other archetype — a battle narrated in days would find only
noise there), the date window takes the *earliest* `P571` rather than the top-ranked one,
and `History`'s subsections are promoted to full chapters.

## What came out free

For *Battle of Stalingrad*, with zero model calls:

- 27 chapters, 15,864 words, 382 addressable reference markers
- Both sides' **order of battle**, correctly nested under Army Group / Front headings
- **Force comparison** in typed quantities (personnel, tanks, artillery, aircraft) across
  both phases of the battle, parsed from infobox strength rows
- 24 **commanders** with portraits and one-line Wikidata descriptions, grouped by side
- 34 **places** with coordinates, plotted on a map
- 31 **dated events** with the sentence each came from and a link to its chapter

For *Japan*, likewise:

- Nine **earlier capitals** with their date ranges — Heijō-kyō, Nagaoka-kyō, Heian-kyō,
  Edo — none of which the infobox mentions
- Three **dated foundings**, each named: 660 BC (the imperial year), 1890 (the Meiji
  constitution), 1947 (the present one). The cover used to read "Founded 1947"
- A population curve that **peaks in 2010** and falls after
- 80 dated events across 1,915 years, on an axis that can hold them

And for *France*, nine seats of government including Vichy, London, Brazzaville, Algiers
and Bayeux — the government-in-exile, straight out of `P36` date qualifiers.

*Ukraine* is the block's best case. Its six inception statements each name what they are
the inception **of**, so "Founded" becomes a six-stage account of Ukrainian statehood —
Kievan Rus' (900), Galicia–Volhynia (1199), the Cossack Hetmanate (1648), the Ukrainian
People's Republic (1917), the Ukrainian SSR (1919), the Declaration of Independence
(1991) — and every one of them is a link to its own volume.

## Honesty rules

These are design constraints, not niceties — they are what makes a no-model pipeline
trustworthy:

1. **Never rewrite prose.** Text is reorganised and re-presented, never regenerated.
2. **Never hide a parse miss.** The forces block always offers "show the infobox source
   rows"; an untyped quantity is displayed verbatim rather than dropped. A lineage that
   was truncated says by how many; a head of state with no dated term is named rather
   than silently omitted; a population chart that plots one measurement basis says how
   many statements on other bases it left out (Japan: 6 census points plotted, 31 not).
3. **Never contradict the article.** Where the infobox and Wikidata disagree (Zhukov's
   birth date), the infobox wins, because that is what the reader is about to read.
4. **Show the provenance.** The colophon carries the revision, the licence, the author
   history link, the archetype and the class path that selected it.

## Known limits

- English Wikipedia only.
- Entity resolution is capped at 140 links per article, raised to 260 for `country`
  (Japan carries 783). Production should use the Wikidata JSON dump or a property-scoped
  SPARQL query instead of `wbgetentities`.
- Chronology only reads dates carrying an explicit year. "On 23 August" (year implied by
  context) is skipped rather than guessed.
- More dated sentences are found than an axis can hold (Ukraine: 130 against a cap of
  110), so some are dropped. *Which* ones is a real editorial act, and taking every n-th
  by position is not neutral — it once kept "contributions to UN peacekeeping operations
  since 1992" and dropped the signing of the Budapest Memorandum. Thinning now keeps the
  richest *mention* in each neighbourhood of the axis: a date pinned to a day over a bare
  year, then the sentence carrying more of its own context. Both signals are structural.
  Neither is a claim about which events mattered.
- The cover picks the widest landscape photograph, rejecting flags, maps and charts by
  filename and caption. It is a keyword test and it loses to other languages: Romania's
  cover was a salary choropleth called `Salariu_net_județele_României_2024.jpg` until the
  caption test caught it, and what it falls back to is a scanned historical map. Telling
  a photograph from a diagram properly means reading the image, which is a model.
- A country's chronology axis is **compressed** once its events span more than 150 years:
  position blends calendar time with event rank, because a linear axis over two millennia
  puts nine tenths of the rail under an empty Middle Ages. The shaded bands are equal
  spans of time drawn at unequal width, so the distortion is visible rather than silent.
  The blend is monotonic — the axis can compress, but it can never reorder.
- The chain of states inherits Wikidata's own judgement about what succeeds what. France
  "replaces" the Kingdom of France and also the Kingdom of Bora Bora, the Rauracian
  Republic and the Free Cities of Menton and Roquebrune. Those are annexations, correctly
  recorded and oddly weighted, and they are shown rather than filtered.
- List articles, disambiguation pages and abstract concepts fall through to `generic`,
  which is a plain reader. That is the intended failure mode.
- Bulk ingest must use the Wikimedia Enterprise HTML dumps, not the live API.

## Deploy

```bash
fly deploy
```

The runtime is Node + cheerio and nothing else. `seed/books/` holds pre-built book JSON
keyed `(title, revision, template version)`; the Dockerfile drops it into the cache
directory so the showcase articles render instantly on a cold machine. A cache miss —
the article was edited since — just falls through to a live build.

**Bumping `TEMPLATE_VERSION` invalidates every seed file**, so regenerate them in the same
commit or the showcase goes back to cold builds:

```bash
V=$(node -e "import('./src/book.js').then(m=>process.stdout.write(String(m.TEMPLATE_VERSION)))"); rm -f seed/books/*.json; for t in Battle_of_Stalingrad Battle_of_Hastings Georgy_Zhukov Kyoto Volgograd Photosynthesis Category_theory Japan Soviet_Union Ukraine; do node scripts/build.mjs "$t" --force >/dev/null && cp .cache/books/"$t".r*.v"$V".json seed/books/; done
```

Copy the named titles, not `.cache/books/*` — the cache also holds every article you
built while working, and the seed is meant to be the showcase, not the scratch pile.

`.cache/` (raw upstream responses, ~3 MB per book) is never committed.

At Wikipedia scale this is the shape production wants anyway: precompute the head, serve
it as static JSON, and let the long tail build lazily. `robots.txt` blocks crawlers from
`/read/` so a bot cannot walk the article space and turn this into a scraper.

## Licensing

Article text is CC BY-SA 4.0 and is attributed per book in the colophon, with links to the
exact revision and the author history. Media files carry their own licences on Wikimedia
Commons. Any public deployment must keep the colophon.
