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

`en`, `de`, `fr`, `es`, `it`, `pt`, `nl` are known. **Any other language still produces a
book** — it loses apparatus filtering (reference sections become ordinary chapters) and
the prose chronology. The home page says so before you open it, rather than quietly
serving a thinner book. Adding a language is one object literal.

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
