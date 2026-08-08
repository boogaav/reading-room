# Build the `country` archetype

Paste this whole document into a fresh Claude Code session opened in the
`reading-room` repo.

---

## Context

You are working in **Reading Room** (`github.com/boogaav/reading-room`), which turns any
Wikipedia article into an interactive book. Read `README.md` first, then
`src/book.js`, `src/archetype.js`, `src/templates/index.js`, `src/extract/*.js` and
`public/reader.js` before changing anything.

The system is **deterministic — there is no language model anywhere in the pipeline, and
you must not add one.** Parsoid HTML supplies the book skeleton (sections, typed
wikilinks, structured refs); Wikidata supplies the archetype, typed entities,
coordinates and dates. Templates in `src/templates/index.js` decide which interactive
blocks an article gets. Existing packs: `battle`, `person`, `place`, `generic`.

Run it with `npm run dev` (port 5208), build one book from the CLI with
`node scripts/build.mjs <Article_Title> --force`.

## Goal

Add a **`country`** archetype that gives a nation the same treatment `battle` gives the
Battle of Stalingrad: a cinematic cover, then interactive apparatus, then the reading
spine, then adjacent volumes and end notes. Same visual language, same restraint, same
honesty rules.

The reference to match in quality is `/read/Battle_of_Stalingrad`. Open it before you
start. The bar is: *a reader should learn something from the apparatus that they could
not get by skimming the Wikipedia article.*

## Non-negotiable constraints

These are what make a no-model pipeline trustworthy. Do not relax them.

1. **Never rewrite prose.** Text is reorganised and re-presented, never regenerated.
2. **Never hide a parse miss.** If a value cannot be typed, show the source wording
   verbatim instead of dropping it. (See how the `forces` block degrades on
   `/read/Battle_of_Hastings`.)
3. **Never contradict the article.** Where the infobox and Wikidata disagree, the
   infobox wins — it is what the reader is about to read.
4. **Always show provenance.** The colophon carries revision, licence, author history,
   archetype and the class path that selected it.
5. **No new runtime dependencies** beyond `cheerio`. The Docker runtime installs
   production deps only and the Fly box is 512 MB.

## Starting facts (already verified — do not re-derive)

- `Japan` currently resolves to **`place`**, because `Q6256` (country) is in the `place`
  root set in `src/archetype.js` *and* in `PLACE_HINT` in `src/extract/entities.js`.
  Its book has only `cover, stats, map, facts, chronology, chapters, shelf, notes`, and
  its cover reads "Founded 1947" — the constitution date, which is misleading.
- Wikidata `Q17` (Japan) has, unused today:
  | Property | What | Count |
  |---|---|---|
  | `P1082` population | **all 37 carry a `P585` point-in-time qualifier** | 37 |
  | `P1081` HDI | dated series | 32 |
  | `P150` contains admin. entity | prefectures | 47 |
  | `P36` capital | **9, i.e. historical capitals with date qualifiers** | 9 |
  | `P47` shares border with | | 7 |
  | `P6` head of government | with `P580`/`P582` qualifiers | 5 |
  | `P1365` replaces | predecessor states | 2 |
  | `P41` / `P94` | flag image / coat of arms | 2 / 1 |
- **The single most important code change**: `claimValues()` in `src/wiki.js` returns only
  `mainsnak` values and **throws qualifiers away**. Almost every good country block needs
  qualifiers. Add a `claimStatements()` that returns `{ value, qualifiers, rank }` and
  build the new blocks on that. Leave `claimValues()` working as-is so existing
  archetypes are untouched.

## Archetype detection

Add `country` to `ARCHETYPE_ROOTS` in `src/archetype.js` **above `place`** — order is
priority, first root hit wins, and `place` would otherwise swallow every country.

Roots to match: `Q6256` (country), `Q3624078` (sovereign state), `Q3024240` (historical
country), `Q1763527` (constituent state), `Q7275` (state), `Q43702` (federation).

Then **remove `Q6256` from the `place` root set** so the two do not compete, and verify
that cities and regions still resolve to `place` (`Kyoto`, `Volgograd` are the
regression tests).

Deliberate scope decision: historical states (`Q3024240` — Soviet Union, Yugoslavia,
Ottoman Empire) route to `country` too. They are the most interesting cases because the
lineage and dissolution blocks actually fire.

## The blocks

Build these in `src/templates/index.js` as a `countryPack(ctx)`, with renderers in
`public/reader.js` and styles in `public/reader.css`. Order matters — this is the book's
narrative sequence.

1. **`cover`** — reuse the existing block. Facts: capital, population, founded, official
   language. Take these from Wikidata where the infobox is ambiguous (country infoboxes
   nest heavily). Use the flag (`P41`) as a plate, never as the cover plate — the cover
   image should be a landscape/city photograph from the article.

2. **`identity`** *(new)* — flag, coat of arms, motto (`P1546`), anthem (`P85`), currency
   (`P38`), calling code, driving side. A quiet emblem strip, not a data dump.

3. **`lineage`** *(new — the centrepiece)* — a horizontal chain of predecessor and
   successor states built from `P1365` replaces / `P1366` replaced by / `P155` follows /
   `P156` followed by, walked **both directions, 2–3 hops, deduped, bounded**. Each node
   shows name, span (`P571`–`P576`) and flag, and links to its own book.
   *Kievan Rus' → … → Russian Empire → RSFSR → Soviet Union → Russian Federation* is the
   shape to aim for. This is the block that makes a country feel like a book rather than
   a fact sheet — a nation as a sequence of states, each one its own volume.
   Not every country has a chain (Japan has 2 `P1365`); render nothing rather than a
   stub of one node.

4. **`population`** *(new)* — a real time series from `P1082` + `P585` qualifiers. Plain
   inline SVG line chart, no chart library. Label first/last/peak points only. If a
   country has fewer than 5 dated points, drop the block. Add HDI (`P1081`) and nominal
   GDP (`P2131`) as switchable series if their series are long enough.

5. **`rulers`** *(new)* — head of state (`P35`) and head of government (`P6`) with
   `P580`/`P582` qualifiers, drawn as a sequence of tenure bars on a shared axis with
   portraits, reusing the `contemporaries` visual from the `person` pack. Resolve names
   and images with the existing batched `fetchPageProps`. Where Wikidata's list is thin,
   fall back to a "Leaders" or "Politics" section of the article rather than inventing.

6. **`territory`** *(new)* — a map showing the country's own coordinate, its neighbours
   (`P47`) as linked pins, and its subdivisions (`P150`) as a second pin layer that can
   be toggled. Reuse the existing `map` block renderer and its lazy `IntersectionObserver`
   init — do not write a second Leaflet integration.

7. **`chronology`** — reuse the existing block, **but the time axis needs new work.**
   See "hard problems" below.

8. **`chapters`**, **`shelf`**, **`notes`** — reuse unchanged.

## Hard problems — solve these deliberately

- **Millennia, not months.** `renderChronology` in `public/reader.js` builds a linear
  axis and switches between year and month gridlines. A country spans 2,000+ years with
  events clustered in the last 200, so a linear axis is unreadable. Implement **era
  banding or a piecewise/compressed scale**, and label the eras. Do not break the
  `battle`/`person` cases that use the same block — gate on span length.

- **`deriveWindow` will mislead.** For a country, `P571` inception is often the modern
  constitution (Japan: 1947), which would clip 1,500 years of history out of the
  chronology. For `country`, prefer the earliest of the inception statements, or derive
  the window from the events actually found rather than from the subject's claims.

- **Enormous, deeply nested infoboxes.** Country infoboxes nest several levels
  (government, area, population by year, GDP by measure). `walkInfoboxTable` recurses to
  depth 3 — verify that is enough and that label/value pairing still holds. Expect to
  need per-row work here.

- **Article length.** Country articles are among the longest on Wikipedia. `Japan` is
  8,169 words with 35 chapters, 373 notes and **783 wikilinks** against an entity
  resolution cap of 140. Raise the cap for this archetype or rank links better — the
  cast and map quality depend on which 140 you pick.

- **The History section deserves sub-chaptering.** In most country articles it is one
  giant section. Consider promoting its subsections to top-level chapters for this
  archetype only.

## Code changes, by file

- `src/wiki.js` — add `claimStatements()` (values **plus** qualifiers and rank). Keep
  `claimValues()` untouched.
- `src/archetype.js` — add `country` roots above `place`; remove `Q6256` from `place`.
- `src/extract/entities.js` — remove `Q6256` from `PLACE_HINT` if it causes neighbours to
  be misclassified; add a `series.js` helper for dated-claim time series.
- `src/templates/index.js` — add `countryPack`, register it in `PACKS`.
- `public/reader.js` — renderers for `identity`, `lineage`, `population`, `rulers`;
  rework the chronology axis.
- `public/reader.css` — styles matching the existing warm-ink palette. Reuse the CSS
  variables; do not introduce a new colour system.
- `src/book.js` — **bump `TEMPLATE_VERSION`** (it is the cache key; nothing rebuilds
  without it).

## Test set

Build each and inspect the real output — not just that it doesn't throw:

| Article | Why |
|---|---|
| `Japan` | dense Wikidata, long series, thin lineage |
| `Soviet Union` | historical state; lineage and dissolution must fire |
| `France` | very long history, deep chronology, many rulers |
| `Singapore` | small, recent, city-state — sparse blocks must degrade cleanly |
| `Yugoslavia` | dissolves into several successors — lineage branches, not a line |
| `Kyoto`, `Volgograd` | **regressions**: must still be `place` |
| `Battle_of_Stalingrad`, `Georgy_Zhukov` | **regressions**: must be unchanged |

## Definition of done

- All seven country test articles render with no console errors and no horizontal
  overflow at 375px and 1400px.
- Every new block degrades to *absent*, never to empty or broken, when its data is
  missing — verify on `Singapore`.
- The two regression articles produce byte-identical blocks to before your change
  (compare `node scripts/build.mjs <title> --force` output).
- `README.md` archetype table updated.
- Screenshots of `Japan` and `Soviet Union` covers plus the `lineage` and `population`
  blocks.
- Report honestly which blocks are weak and why — if the source data is thin, say so
  rather than padding the page.
