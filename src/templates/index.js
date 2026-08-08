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
  const items = [...entities.values()]
    .filter((e) => e.qid !== subject?.qid && (e.thumb || e.description))
    .map((e) => ({ ...cardOf(e), weight: (counts.get(e.title) || 0) + (e.thumb ? 2 : 0) }))
    .sort((a, b) => b.weight - a.weight)
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
