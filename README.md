# Reading Room

Turns any Wikipedia article into an interactive book. **No language model is involved
anywhere in this pipeline** — every block on the page is a deterministic transform of
Parsoid HTML and Wikidata claims.

```bash
node server.js          # http://localhost:5208/read/Battle_of_Stalingrad
```

Any article works: `/read/<Article_Title>`.

## The v0 question

The proposal was: build the deterministic layer first, and only then decide whether an
LLM "director" pass is needed to choose and order the blocks. This is that layer.

**Verdict so far: the director pass is not needed for the three archetypes built here.**
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

## Archetypes

Selected by walking the subclass graph upward from the subject's `P31`. First root hit wins.

| Archetype | Detected via | Blocks |
|---|---|---|
| `battle` | battle / war / conflict / military operation | belligerents · order of battle · forces comparison · casualty scale · dramatis personae · theatre map · chronology |
| `person` | human | vitals · contemporaries axis · places map · chronology |
| `place` | settlement / geographic location / admin entity | stats · situation map · gazetteer · chronology |
| `generic` | fallback | facts · map · chronology |

All four then get the reading spine, adjacent volumes, and end notes. Adding an archetype
is one function in `src/templates/index.js`.

## What came out free

For *Battle of Stalingrad*, with zero model calls:

- 27 chapters, 15,864 words, 382 addressable reference markers
- Both sides' **order of battle**, correctly nested under Army Group / Front headings
- **Force comparison** in typed quantities (personnel, tanks, artillery, aircraft) across
  both phases of the battle, parsed from infobox strength rows
- 24 **commanders** with portraits and one-line Wikidata descriptions, grouped by side
- 34 **places** with coordinates, plotted on a map
- 31 **dated events** with the sentence each came from and a link to its chapter

## Honesty rules

These are design constraints, not niceties — they are what makes a no-model pipeline
trustworthy:

1. **Never rewrite prose.** Text is reorganised and re-presented, never regenerated.
2. **Never hide a parse miss.** The forces block always offers "show the infobox source
   rows"; an untyped quantity is displayed verbatim rather than dropped.
3. **Never contradict the article.** Where the infobox and Wikidata disagree (Zhukov's
   birth date), the infobox wins, because that is what the reader is about to read.
4. **Show the provenance.** The colophon carries the revision, the licence, the author
   history link, the archetype and the class path that selected it.

## Known limits

- English Wikipedia only.
- Entity resolution is capped at 140 links per article. Production should use the
  Wikidata JSON dump or a property-scoped SPARQL query instead of `wbgetentities`.
- Chronology only reads dates carrying an explicit year. "On 23 August" (year implied by
  context) is skipped rather than guessed.
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

`.cache/` (raw upstream responses, ~3 MB per book) is never committed.

At Wikipedia scale this is the shape production wants anyway: precompute the head, serve
it as static JSON, and let the long tail build lazily. `robots.txt` blocks crawlers from
`/read/` so a bot cannot walk the article space and turn this into a scraper.

## Licensing

Article text is CC BY-SA 4.0 and is attributed per book in the colophon, with links to the
exact revision and the author history. Media files carry their own licences on Wikimedia
Commons. Any public deployment must keep the colophon.
