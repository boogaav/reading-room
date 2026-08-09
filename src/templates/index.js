// Template packs.
//
// A template turns the SourceModel + resolved entities into an ordered list of
// interactive blocks. This is the *only* place that knows what a battle book
// looks like versus a person book. Adding an archetype = adding a function here.
import { pickEntities } from '../extract/entities.js';

const UNIT_WORDS = [
  [/personnel|men\b|troops|soldiers|infantry|combatants/i, 'personnel'],
  [/tanks?\b|armou?red vehicles|afvs?/i, 'tanks'],
  [/aircraft|planes|airplanes/i, 'aircraft'],
  [/artillery|guns\b|mortars|howitzers|rocket launchers/i, 'artillery'],
  [/ships?|vessels|submarines/i, 'ships'],
  [/divisions?|brigades?|regiments?|battalions?/i, 'formations'],
  [/horses?/i, 'horses'],
];

const UNIT_ORDER = ['personnel', 'tanks', 'artillery', 'aircraft', 'ships', 'formations', 'horses'];

export function buildBlocks(archetype, ctx) {
  const pack = PACKS[archetype] || PACKS.generic;
  return pack(ctx).filter(Boolean);
}

const PACKS = {
  battle: battlePack,
  person: personPack,
  country: countryPack,
  place: placePack,
  generic: genericPack,
};

// ---- battle --------------------------------------------------------------

function battlePack(ctx) {
  const { source, entities, chronology, subject, window } = ctx;
  const row = rowFinder(source.infobox);

  const belligerents = row('belligerents', 'combatants', 'participants');
  const strength = row('strength');
  const units = row('units involved', 'units');
  const casualties = row('casualties', 'losses');
  const commanders = row('commanders');

  const sideNames = belligerents ? belligerents.values.map((v) => v.lines.slice(0, 6)) : [];

  return [
    coverBlock(ctx, [
      factOf(row('date'), 'When'),
      factOf(row('location'), 'Where'),
      factOf(row('result'), 'Outcome'),
    ]),

    belligerents && {
      type: 'sides',
      title: 'The Belligerents',
      sides: belligerents.values.map((v, i) => ({
        name: sideLabel(v, i),
        parties: v.lines.filter((l) => !/^during|^total/i.test(l)).slice(0, 8),
        entities: pickEntities(entities, v.links).slice(0, 8).map(cardOf),
        formations: units ? groupFormations(units.values[i]?.lines || []) : [],
      })),
    },

    strength && {
      type: 'forces',
      title: 'Order of Battle',
      caption: 'Parsed from the infobox strength rows. Source wording is shown in full — nothing here is inferred.',
      sides: strength.values.map((v, i) => ({
        name: sideNames[i]?.[0] || `Side ${i + 1}`,
        phases: parsePhases(v.lines),
        raw: v.lines,
      })),
      units: UNIT_ORDER,
    },

    casualties && {
      type: 'toll',
      title: 'The Cost',
      total: casualties.addenda.find((a) => /total/i.test(a)) || null,
      sides: casualties.values.map((v, i) => ({
        name: sideNames[i]?.[0] || `Side ${i + 1}`,
        headline: firstQuantity(v.lines.find((l) => /casualt|killed|dead|losses|\d/i.test(l)) || v.lines[0] || ''),
        breakdown: v.lines.filter(Boolean).slice(0, 14),
      })),
    },

    commanders && {
      type: 'cast',
      title: 'Dramatis Personae',
      groups: commanders.values.map((v, i) => ({
        name: sideNames[i]?.[0] || `Side ${i + 1}`,
        people: pickEntities(entities, v.links, (e) => e.isHuman).slice(0, 12).map(cardOf),
      })),
    },

    mapBlock(ctx, 'The Theatre', subject?.coord),
    chronology.length >= 4 && { type: 'chronology', title: 'Chronology', events: chronology, window },
    { type: 'chapters' },
    shelfBlock(ctx),
    notesBlock(ctx),
  ];
}

// ---- person --------------------------------------------------------------

function personPack(ctx) {
  const { source, entities, chronology, subject, window } = ctx;
  const row = rowFinder(source.infobox);

  const people = [...entities.values()].filter((e) => e.isHuman && e.qid !== subject?.qid);
  const contemporaries = people
    .filter((e) => e.birth && subject?.birth && Math.abs(e.birth.year - subject.birth.year) <= 30)
    .sort((a, b) => a.birth.year - b.birth.year)
    .slice(0, 14);

  const age = ageAt(subject?.birth, subject?.death);
  const lifespan = subject?.birth && subject?.death
    ? `${subject.birth.year}–${subject.death.year}${age != null ? ` · ${age} years` : ''}`
    : null;

  return [
    // Prefer the infobox over Wikidata here. Where the two disagree (Zhukov's
    // birth is recorded differently in each), the cover must not contradict the
    // prose the reader is about to read.
    coverBlock(ctx, [
      factOf(row('born', 'birth date'), 'Born') || (subject?.birth && { label: 'Born', value: fmtDate(subject.birth) }),
      factOf(row('died', 'death date'), 'Died') || (subject?.death && { label: 'Died', value: fmtDate(subject.death) }),
      lifespan ? { label: 'Lifespan', value: lifespan } : null,
      factOf(row('occupation', 'known for', 'title'), 'Known for'),
    ]),

    { type: 'facts', title: 'Vitals', rows: infoboxFacts(source.infobox, 14) },

    contemporaries.length >= 3 && {
      type: 'contemporaries',
      title: 'Contemporaries',
      caption: 'Everyone mentioned in this article whose life overlapped the subject\'s, on a shared axis.',
      subject: subject ? { ...cardOf(subject), birth: subject.birth?.year, death: subject.death?.year } : null,
      people: contemporaries.map((e) => ({ ...cardOf(e), birth: e.birth?.year, death: e.death?.year || null })),
    },

    mapBlock(ctx, 'Places in this Life', subject?.coord),
    chronology.length >= 4 && { type: 'chronology', title: 'Chronology', events: chronology, window },
    { type: 'chapters' },
    shelfBlock(ctx),
    notesBlock(ctx),
  ];
}

// ---- place ---------------------------------------------------------------

function placePack(ctx) {
  const { source, chronology, subject, window } = ctx;
  const row = rowFinder(source.infobox);

  const stats = [
    subject?.population && { label: 'Population', value: fmtNum(subject.population) },
    subject?.area && { label: 'Area', value: `${fmtNum(Math.round(subject.area))} km²` },
    subject?.elevation && { label: 'Elevation', value: `${fmtNum(Math.round(subject.elevation))} m` },
    subject?.inception && { label: 'Founded', value: String(subject.inception.year) },
  ].filter(Boolean);

  return [
    // "Population" is ambiguous in settlement infoboxes — both Area and
    // Population have a "Total" sub-row — so take the Wikidata claim instead.
    coverBlock(ctx, [
      factOf(row('country'), 'Country'),
      subject?.population ? { label: 'Population', value: fmtNum(subject.population) } : null,
      subject?.inception
        ? { label: 'Founded', value: String(subject.inception.year) }
        : factOf(row('founded', 'established', 'settled'), 'Founded'),
    ]),

    stats.length && { type: 'stats', title: 'By the Numbers', stats },
    mapBlock(ctx, 'Situation', subject?.coord, { zoom: 9 }),
    { type: 'facts', title: 'Gazetteer', rows: infoboxFacts(source.infobox, 18) },
    chronology.length >= 4 && { type: 'chronology', title: 'Chronology', events: chronology, window },
    { type: 'chapters' },
    shelfBlock(ctx),
    notesBlock(ctx),
  ];
}

// ---- country -------------------------------------------------------------

/**
 * A nation is a sequence of states, so this pack reads as one: what it calls
 * itself, where it came from and what came after, how many of it there were,
 * who governed, and what it borders. Everything below `ctx.country` comes from
 * Wikidata statement *qualifiers* (see extract/country.js); everything else is
 * the article's own infobox and prose.
 */
function countryPack(ctx) {
  const { source, chronology, subject, window, country } = ctx;
  const row = rowFinder(source.infobox);
  const c = country || {};
  const pop = c.series?.population;

  // P571 is plural on a country and its *preferred* value is usually the newest
  // — which is why Japan's cover used to read "Founded 1947", the date of a
  // constitution rather than of a country. Take the earliest instead, and name
  // what it is a date of.
  const origin = c.foundings?.[0] || null;
  const foundedValue = origin
    ? `${fmtYear(origin.year)}${origin.of ? ` · ${origin.of}` : ''}`
    : null;

  const headline = pop?.last || null;
  const population = subject?.population ?? headline?.value ?? null;

  const art = countryCoverArt(source);

  return [
    {
      ...coverBlock(ctx, [
        c.identity?.capital ? { label: 'Capital', value: c.identity.capital.label } : factOf(row('capital'), 'Capital'),
        population ? { label: 'Population', value: fmtNum(Math.round(population)) } : null,
        foundedValue ? { label: 'Founded', value: foundedValue } : null,
        factOf(row('official language', 'national language', 'languages'), 'Language')
          || labelValue('Language', c.identity?.rows.find((r) => r.label === 'Official language')?.value),
        c.dissolution ? { label: 'Dissolved', value: fmtYear(c.dissolution.year) } : null,
      ]),
      // The infobox plate on a country article is the flag, which makes a poor
      // cover and a fine emblem. Take a photograph from the article instead.
      image: art.image,
      plates: art.plates,
    },

    (c.identity?.emblems.length || c.identity?.rows.length) && {
      type: 'identity',
      title: 'Insignia',
      emblems: c.identity.emblems,
      rows: c.identity.rows,
      capital: c.identity.capital,
      formerCapitals: c.identity.formerCapitals.slice(0, 12),
      foundings: (c.foundings || []).length > 1 ? c.foundings : [],
    },

    c.lineage && {
      type: 'lineage',
      title: 'The Chain of States',
      caption: 'Predecessor and successor states, walked in both directions from Wikidata\'s own succession claims. '
        + 'Columns are steps of succession, not distance in time — each state carries its own span. Every one is a book.',
      subjectQid: c.qid,
      nodes: c.lineage.nodes,
      edges: c.lineage.edges,
      levels: c.lineage.levels,
      truncated: c.lineage.truncated,
    },

    seriesBlock(c.series),

    c.rulers && {
      type: 'rulers',
      title: 'Who Governed',
      caption: 'Tenures as recorded in Wikidata, on one axis. Terms without a start date cannot be placed and are listed separately.',
      tracks: c.rulers.tracks,
      from: c.rulers.from,
      to: c.rulers.to,
    },

    territoryBlock(ctx, c.territory),

    { type: 'facts', title: 'The Record', rows: countryFacts(source.infobox, 26) },
    chronology.length >= 4 && { type: 'chronology', title: 'Chronology', events: chronology, window },
    { type: 'chapters' },
    shelfBlock(ctx),
    notesBlock(ctx),
  ];
}

const SERIES_SPEC = [
  ['population', 'Population', 'int'],
  ['hdi', 'Human Development Index', 'decimal'],
  ['gdp', 'GDP (nominal)', 'usd'],
];

function seriesBlock(series) {
  if (!series) return null;
  const available = SERIES_SPEC
    .map(([key, label, format]) => {
      const s = series[key];
      return s && { key, label, format, ...s };
    })
    .filter(Boolean);
  if (!available.length) return null;
  return {
    type: 'series',
    title: 'By the Numbers',
    caption: 'Dated Wikidata statements, plotted. Only one measurement basis is charted at a time — mixing bases would draw a line that exists in no source.',
    series: available,
  };
}

/**
 * The subject, its neighbours and its subdivisions on one map, as two layers.
 * Reuses the `map` renderer wholesale; `layers` is the only addition, and no
 * other archetype sets it.
 */
function territoryBlock(ctx, territory) {
  if (!territory) return null;
  const focus = ctx.subject?.coord || null;
  const points = [
    ...territory.neighbours.map((p) => ({ ...p, layer: 'neighbours' })),
    ...territory.subdivisions.slice(0, 60).map((p) => ({ ...p, layer: 'subdivisions' })),
  ];
  if (focus) {
    points.unshift({
      title: ctx.source.title, label: ctx.source.title,
      lat: focus.lat, lon: focus.lon, primary: true, layer: 'subject',
      description: 'The subject of this book',
    });
  }
  if (points.length < 2) return null;

  const layers = [
    { key: 'subject', label: ctx.source.title, on: true, n: focus ? 1 : 0 },
    { key: 'neighbours', label: 'Borders', on: true, n: territory.neighbours.length },
    { key: 'subdivisions', label: territory.subdivisionLabel, on: false, n: Math.min(territory.subdivisions.length, 60) },
  ].filter((l) => l.n);

  return {
    type: 'map',
    title: 'The Territory',
    caption: 'Neighbours from Wikidata P47, subdivisions from P150, each placed by its own P625 coordinate.'
      + missingNote(territory),
    points, layers, focus, zoom: 5,
  };
}

function missingNote(t) {
  const miss = (t.neighboursMissing || 0) + (t.subdivisionsMissing || 0);
  return miss ? ` ${miss} more are claimed but carry no coordinate, so they cannot be placed.` : '';
}

/**
 * Country infoboxes nest: an "Area" heading owns the "• Total" beneath it, and
 * three different rows are called "• Total". Re-attach each sub-row to the
 * heading it sat under, so the column reads without the original layout.
 */
function countryFacts(infobox, limit) {
  const headings = infobox.headings || [];
  const out = [];
  let lastTop = null; // most recent unbulleted row — "GDP (PPP)" owns "• Total"

  for (let i = 0; i < infobox.rows.length; i++) {
    const r = infobox.rows[i];
    const value = r.values.map((v) => (v.lines.length ? v.lines.join(' · ') : v.text)).filter(Boolean).join(' — ');
    const bulleted = /^[•·▪]/.test(r.label);
    if (!bulleted) lastTop = { label: r.label, at: i };
    if (!value || value.length >= 500) continue;

    let label = r.label;
    if (bulleted) {
      // A sub-row belongs to whichever came last: a valueless heading row
      // ("Area") or a labelled row that heads its own group ("GDP (PPP)").
      const heading = headings.filter((h) => h.atRow <= i).pop();
      const owner = !heading ? lastTop
        : !lastTop ? { label: heading.label, at: heading.atRow }
          : (heading.atRow >= lastTop.at ? { label: heading.label, at: heading.atRow } : lastTop);
      label = `${owner ? `${owner.label} — ` : ''}${label.replace(/^[•·▪]\s*/, '')}`;
    }
    out.push({ label, value });
    if (out.length >= limit) break;
  }
  return out;
}

// Flags, arms, locator maps and topographic plates are diagrams; a cover wants
// a photograph. Matched on the Commons filename, which is stable.
const NOT_COVER_ART = /flag|coat[_ ]of[_ ]arms|emblem|seal|logo|locator|orthographic|projection|topo|[_-]map|map[_-]|chart|graph|diagram|density|per[_ ]capita|\.svg(\.png)?$|\.gif$/i;
// The filename is only half the signal, and it is the half that is often not in
// English — Romania's cover was `Salariu_net_județele_României_2024.jpg`, a
// salary choropleth that no English keyword could catch. The caption is written
// for readers, so it says what the picture is.
const NOT_COVER_CAPTION = /\bmaps?\b|\bcharts?\b|\bgraphs?\b|\bdiagrams?\b|territorial (extent|changes|losses)|\bmigrations?\b|depicting|distribution of|\bdensity\b|salary|income|\bGDP\b|per capita|percentage|share of|\bby (county|counties|region|province|district|oblast|prefecture)\b/i;
// Commons convention does most of the work: photographs are JPEG, while maps,
// charts and diagrams are PNG, SVG or GIF. Without this the Soviet Union's
// cover is a GDP-per-capita plot and France's is a population-density map.
const PHOTOGRAPH = /\.jpe?g$/i;

/**
 * The cover wants a photograph of the place. Preference runs: a landscape
 * photograph, then any photograph (the cover crops with object-fit, so a
 * portrait still fills — Yugoslavia has no landscape photo at all), then
 * whatever is left. Widest wins inside each tier, document order breaks ties,
 * so the pick is stable across rebuilds.
 */
function countryCoverArt(source) {
  const named = (f) => decodeURIComponent(String(f.src).split('/').pop() || '');
  const usable = source.figures.filter((f) => (f.width || 0) > 0 && (f.height || 0) > 0
    && !NOT_COVER_ART.test(named(f)) && !NOT_COVER_CAPTION.test(f.caption || ''));
  const widest = (list) => list.slice().sort((a, b) =>
    (b.width - a.width) || (source.figures.indexOf(a) - source.figures.indexOf(b)));

  const photos = usable.filter((f) => PHOTOGRAPH.test(named(f)));
  const ranked = [
    ...widest(photos.filter((f) => f.width >= f.height)),
    ...widest(photos.filter((f) => f.width < f.height)),
    ...widest(usable.filter((f) => !PHOTOGRAPH.test(named(f)))),
  ];
  const image = ranked[0]?.src || source.figures[0]?.src || source.infobox.image || null;

  const plates = [];
  const push = (src, alt) => {
    if (src && !plates.some((p) => p.src === src)) plates.push({ src, thumb: thumbOf(src), alt: alt || '' });
  };
  push(image, ranked[0]?.caption);
  ranked.slice(1, 6).forEach((f) => push(f.src, f.caption));
  (source.infobox.images || []).slice(0, 3).forEach((i) => push(i.src, i.alt));
  return { image, plates: plates.length > 1 ? plates : [] };
}

/** Commons thumbnails are bucket-snapped; re-point a 960px plate at 250px. */
function thumbOf(src) {
  return String(src).includes('/thumb/') ? String(src).replace(/\/\d+px-/, '/250px-') : src;
}

function labelValue(label, value) {
  return value ? { label, value: String(value) } : null;
}

function fmtYear(y) {
  if (typeof y !== 'number') return '';
  return y < 0 ? `${Math.abs(y)} BC` : String(y);
}

// ---- generic fallback ----------------------------------------------------

function genericPack(ctx) {
  const { source, chronology, subject, window } = ctx;
  return [
    coverBlock(ctx, infoboxFacts(source.infobox, 3).map((r) => ({ label: r.label, value: r.value }))),
    source.infobox.rows.length && { type: 'facts', title: 'At a Glance', rows: infoboxFacts(source.infobox, 20) },
    mapBlock(ctx, 'Places', subject?.coord),
    chronology.length >= 6 && { type: 'chronology', title: 'Chronology', events: chronology, window },
    { type: 'chapters' },
    shelfBlock(ctx),
    notesBlock(ctx),
  ];
}

// ---- shared blocks -------------------------------------------------------

function coverBlock(ctx, facts) {
  const { source, summary, subject } = ctx;
  return {
    type: 'cover',
    title: source.title,
    subtitle: source.infobox.rows.find((r) => /^part of/i.test(r.values[0]?.text || ''))?.values[0]?.text
      || subject?.description || summary?.description || '',
    extract: summary?.extract || '',
    image: source.infobox.image || source.figures[0]?.src || null,
    plates: (source.infobox.images || []).slice(0, 6),
    facts: (facts || []).filter(Boolean),
  };
}

function mapBlock(ctx, title, focus, opts = {}) {
  const points = [...ctx.entities.values()]
    .filter((e) => e.coord && e.isPlace)
    .slice(0, 60)
    .map((e) => ({ title: e.title, label: e.label || e.title, lat: e.coord.lat, lon: e.coord.lon, description: e.description, thumb: e.thumb }));

  if (focus && !points.some((p) => Math.abs(p.lat - focus.lat) < 1e-6 && Math.abs(p.lon - focus.lon) < 1e-6)) {
    points.unshift({ title: ctx.source.title, label: ctx.source.title, lat: focus.lat, lon: focus.lon, primary: true, description: 'The subject of this book' });
  }
  if (points.length < 2) return null;
  return { type: 'map', title, points, focus: focus || null, zoom: opts.zoom || null };
}

function shelfBlock(ctx) {
  const { entities, source, subject } = ctx;
  const counts = new Map(source.links.map((l) => [l.title, l.count]));
  // Two links can redirect to one article, so the map is keyed by link title but
  // the shelf must be keyed by identity — otherwise a volume appears twice.
  const seen = new Set();
  const items = [...entities.values()]
    .filter((e) => e.qid !== subject?.qid && (e.thumb || e.description))
    .map((e) => ({ ...cardOf(e), weight: (counts.get(e.title) || 0) + (e.thumb ? 2 : 0) }))
    .sort((a, b) => b.weight - a.weight)
    .filter((e) => !e.qid || (!seen.has(e.qid) && seen.add(e.qid)))
    .slice(0, 12);
  if (!items.length) return null;
  return {
    type: 'shelf',
    title: 'Adjacent Volumes',
    caption: 'Wikipedia is 7 million articles that all feel like one page. These are the next ones in this thread.',
    items,
  };
}

function notesBlock(ctx) {
  if (!ctx.source.notes.length) return null;
  return { type: 'notes', title: 'End Notes', count: ctx.source.notes.length };
}

// ---- helpers -------------------------------------------------------------

/**
 * Names are tried in priority order, not OR'd together — otherwise a later
 * alias can win just because its row appears earlier in the infobox.
 */
function rowFinder(infobox) {
  const norm = infobox.rows.map((r) => ({ row: r, key: r.label.toLowerCase().replace(/\s+/g, ' ') }));
  return (...names) => {
    for (const n of names) {
      const hit = norm.find((r) => r.key.includes(n));
      if (hit) return hit.row;
    }
    return null;
  };
}

function factOf(row, label) {
  if (!row) return null;
  const value = row.values.map((v) => v.lines[0] || v.text).filter(Boolean).join(' · ');
  return value ? { label, value: value.slice(0, 160) } : null;
}

/**
 * Join on `lines`, not `text`: flattening a cell runs adjacent block elements
 * together ("In office9 February 1955"), which `lines` already separates.
 */
function infoboxFacts(infobox, limit) {
  return infobox.rows
    .map((r) => ({
      label: r.label,
      value: r.values.map((v) => (v.lines.length ? v.lines.join(' · ') : v.text)).filter(Boolean).join(' — '),
    }))
    .filter((r) => r.value && r.value.length < 500)
    .slice(0, limit);
}

function cardOf(e) {
  return { title: e.title, label: e.label || e.title, description: e.description || '', thumb: e.thumb || null, qid: e.qid };
}

function sideLabel(value, i) {
  const first = value.lines[0];
  if (first && !/^during|^\d/.test(first)) return first;
  return `Side ${i + 1}`;
}

/**
 * "During the Axis offensive:270,000 personnel" / "500 tanks" -> grouped phases
 * with typed quantities. Anything we can't type is preserved as raw text, so a
 * parse miss degrades to "shown verbatim" rather than "silently dropped".
 */
function parsePhases(lines) {
  const phases = [];
  let current = { name: null, items: [] };

  for (const line of lines) {
    if (!line) continue;
    const split = /^([A-Za-z][^:]{3,60}):\s*(.*)$/.exec(line);
    let body = line;
    if (split && !/^\d/.test(split[1])) {
      if (current.items.length || current.name) phases.push(current);
      current = { name: split[1].replace(/^during the\s*/i, '').trim(), items: [] };
      body = split[2];
    }
    const item = parseQuantity(body);
    if (item) current.items.push(item);
    else if (body.trim()) current.items.push({ unit: null, value: null, raw: body.trim() });
  }
  if (current.items.length || current.name) phases.push(current);
  return phases.filter((p) => p.items.length);
}

// A formation line is a group heading if it ends with a colon, or names a front
// or army group — infoboxes drop the colon once a reference marker is stripped.
const GROUP_HEADING = /^(Army Group\b.*|.+\bFront|.+\bGroup|OKH|Stavka)$/;

/** "Army Group B:" / "6th Army" / "4th Panzer Army" -> nested order of battle. */
function groupFormations(lines) {
  const groups = [];
  let current = null;
  for (const line of lines) {
    if (!line) continue;
    if (/:$/.test(line) || GROUP_HEADING.test(line)) {
      current = { name: line.replace(/:$/, ''), items: [] }; groups.push(current); continue;
    }
    if (!current) { current = { name: null, items: [] }; groups.push(current); }
    current.items.push(line);
  }
  return groups.filter((g) => g.items.length);
}

function parseQuantity(text) {
  const m = /^\s*([\d][\d,]*)\s*(?:[–-]\s*([\d][\d,]*))?\s*\+?\s*(.*)$/.exec(text || '');
  if (!m) return null;
  const lo = Number(m[1].replace(/,/g, ''));
  const hi = m[2] ? Number(m[2].replace(/,/g, '')) : null;
  if (!Number.isFinite(lo) || lo < 1) return null;
  const rest = m[3] || '';
  const unit = UNIT_WORDS.find(([re]) => re.test(rest))?.[1] || null;
  return { unit, value: hi ? Math.round((lo + hi) / 2) : lo, low: lo, high: hi, raw: text.trim() };
}

function firstQuantity(text) {
  const m = /([\d][\d,]{2,})\s*(?:[–-]\s*([\d][\d,]{2,}))?/.exec(text || '');
  if (!m) return null;
  const lo = Number(m[1].replace(/,/g, ''));
  const hi = m[2] ? Number(m[2].replace(/,/g, '')) : null;
  return { low: lo, high: hi, value: hi ? Math.round((lo + hi) / 2) : lo, raw: (text || '').trim().slice(0, 120) };
}

function fmtNum(n) {
  return new Intl.NumberFormat('en-US').format(n);
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

/** Years lived, not years spanned — the birthday may not have come round yet. */
function ageAt(birth, death) {
  if (!birth?.year || !death?.year) return null;
  let age = death.year - birth.year;
  if (birth.month && death.month) {
    if (death.month < birth.month) age--;
    else if (death.month === birth.month && birth.day && death.day && death.day < birth.day) age--;
  }
  return age >= 0 ? age : null;
}

function fmtDate(t) {
  if (!t) return '';
  if (t.day && t.month) return `${t.day} ${MONTH_NAMES[t.month - 1]} ${t.year}`;
  if (t.month) return `${MONTH_NAMES[t.month - 1]} ${t.year}`;
  return String(t.year);
}
