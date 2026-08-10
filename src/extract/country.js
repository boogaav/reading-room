// Country apparatus: everything a nation needs that `claimValues` cannot see.
//
// Four things live here, and all four exist only in statement *qualifiers*:
//   lineage    P1365/P1366/P155/P156 walked both ways, dated by P571/P576
//   series     P1082/P1081/P2131 dated by P585
//   rulers     P35/P6 with P580/P582 tenure bounds
//   territory  P47 neighbours and P150 subdivisions, placed by P625
//
// Still zero model. Every value below is a Wikidata claim or an article
// sentence; nothing is inferred, and anything that cannot be typed is either
// shown verbatim or dropped loudly (see `truncated` / `dropped` counters).
import {
  fetchEntities, fetchPageProps, claimStatements, claimIds, claimValues,
  claimTime, claimTimes, claimCoord, commonsThumb, siteOf,
  qualifierTime, qualifierId, byRank,
} from '../wiki.js';
import { datedSeries } from './series.js';

// Predecessors and successors. P1365/P1366 are the precise pair ("replaces" /
// "replaced by"); P155/P156 ("follows" / "followed by") are looser but are what
// most republics and unions actually use, so both are walked and the property
// that produced each edge is kept so the reader can see which is which.
const BACKWARD = [['P1365', 'replaces'], ['P155', 'follows']];
const FORWARD = [['P1366', 'replaced by'], ['P156', 'followed by']];

const MAX_HOPS = 3;
const MAX_NODES = 16;
// Fan-out narrows with distance: the first hop is the subject's own story and
// deserves room, three hops out it is trivia.
const FANOUT = [8, 3, 2];
// A level that fans out wide is a dissolution, not a chain. Keep walking from
// its first couple of nodes so a long chain (Kievan Rus' → … → Russia) still
// reaches its far end, but do not walk fifteen successor republics' separate
// histories into one picture.
const WALK_ON_FROM = 2;

const ENTITY_PROPS = 'claims|labels|descriptions|sitelinks';

// What a founding date is the founding *of*. Countries disagree about which
// qualifier carries this: Japan uses P805 ("statement is subject of"), Ukraine
// and France use P4649 ("of"), and Ukraine's 1991 statement names only its
// immediate cause. Tried in order of how directly each answers the question.
// P828 "has cause" is deliberately absent — Ukraine's 1991 cause is the Soviet
// coup attempt, and labelling a founding with a coup would state something false.
const FOUNDING_OF = ['P4649', 'P805', 'P1478'];

/**
 * @param {object} subject  the subject's Wikidata entity (claims|labels|descriptions)
 * @returns {Promise<object>} the `country` slice of the template context
 */
export async function extractCountry(subject, { title = null, lang = 'en' } = {}) {
  const SITE = siteOf(lang);
  if (!subject) return null;
  const qid = subject.id || null;

  const lineage = await buildLineage(subject, qid, lang);

  // One batched round for everything that is a bare Q-id reference.
  const identityIds = [
    ...claimIds(subject, 'P38'),      // currency
    ...claimIds(subject, 'P85'),      // anthem
    ...claimIds(subject, 'P37'),      // official language
    ...claimIds(subject, 'P1546'),    // motto
    ...claimIds(subject, 'P1622'),    // driving side
    ...claimIds(subject, 'P122'),     // basic form of government
  ];
  const capitalStatements = claimStatements(subject, 'P36');
  const rulerStatements = [
    ...claimStatements(subject, 'P35').map((s) => ({ ...s, role: 'Head of state', prop: 'P35' })),
    ...claimStatements(subject, 'P6').map((s) => ({ ...s, role: 'Head of government', prop: 'P6' })),
  ];
  const neighbourIds = claimIds(subject, 'P47').slice(0, 40);
  const subdivisionIds = claimIds(subject, 'P150').slice(0, 60);
  const foundings = claimTimes(subject, 'P571');

  const series = {
    population: datedSeries(subject, 'P1082', { minPoints: 5 }),
    hdi: datedSeries(subject, 'P1081', { minPoints: 5 }),
    gdp: datedSeries(subject, 'P2131', { minPoints: 5 }),
  };

  const lookupIds = [...new Set([
    ...Object.values(series).filter(Boolean).flatMap((s) => (s.criterion || '').split('/')).filter(Boolean),
    ...identityIds,
    ...capitalStatements.map((s) => s.value?.id).filter(Boolean),
    ...rulerStatements.map((s) => s.value?.id).filter(Boolean),
    ...rulerStatements.flatMap((s) => [qualifierId(s, 'P39'), qualifierId(s, 'P102')]).filter(Boolean),
    ...neighbourIds,
    ...subdivisionIds,
    ...foundings.flatMap((f) => FOUNDING_OF.map((p) => qualifierId(f.statement, p))).filter(Boolean),
  ])].filter((id) => id !== qid);

  const refs = await fetchEntities(lookupIds, { props: ENTITY_PROPS, sitefilter: SITE, lang });
  // A city-state is its own capital (Singapore's P36 is Q334). Self-reference is
  // not a parse miss, so resolve it against the subject rather than dropping it.
  if (qid) refs[qid] = title ? { ...subject, sitelinks: { [SITE]: { title } } } : subject;

  // What the subdivisions *are* is itself a claim: Japan's 47 are P31 "prefecture
  // of Japan". Name the layer from the data rather than calling everything
  // "Subdivisions".
  const subTypeIds = [...new Set(subdivisionIds.slice(0, 8).flatMap((id) => claimIds(refs[id], 'P31')))];
  const subTypes = subTypeIds.length ? await fetchEntities(subTypeIds, { props: 'labels' }) : {};

  // Thumbnails come from enwiki, which has better portrait crops than Commons
  // and is already batched and cached.
  const portraitTitles = [
    ...rulerStatements.map((s) => enTitle(refs[s.value?.id])),
    ...(lineage?.nodes || []).map((n) => n.title),
  ].filter(Boolean);
  const thumbs = portraitTitles.length ? await fetchPageProps(portraitTitles, lang) : {};
  for (const n of lineage?.nodes || []) {
    if (n.title && thumbs[n.title]?.thumb) n.thumb = thumbs[n.title].thumb;
  }

  return {
    qid,
    foundings: foundings
      .map((f) => {
        const named = FOUNDING_OF.map((p) => refs[qualifierId(f.statement, p)]).find((e) => e && labelOf(e, lang));
        return {
          year: f.year, month: f.month, day: f.day,
          rank: f.statement.rank,
          of: labelOf(named, lang) || null,
          ofTitle: enTitle(named) || null,
        };
      })
      .sort((a, b) => a.year - b.year),
    dissolution: claimTime(subject, 'P576'),

    identity: buildIdentity(subject, refs, capitalStatements, lang),
    lineage,
    // The criterion is what makes a series comparable with itself. Name it, and
    // say how many statements it cost, rather than quietly plotting a subset.
    series: Object.fromEntries(Object.entries(series).map(([k, s]) => [k, s && {
      ...s,
      criterionLabel: (s.criterion || '').split('/').map((id) => labelOf(refs[id], lang)).filter(Boolean).join(', ') || null,
    }])),
    rulers: buildRulers(rulerStatements, refs, thumbs, lang),
    territory: buildTerritory(subject, refs, neighbourIds, subdivisionIds, subTypes, subTypeIds, lang),
  };
}

// ---- identity ------------------------------------------------------------

function buildIdentity(subject, refs, capitalStatements, lang = 'en') {
  const flag = pickDated(claimStatements(subject, 'P41'));
  const arms = pickDated(claimStatements(subject, 'P94'));

  // Capital is plural and dated on old states — Japan lists nine. The current
  // one is the undated/preferred statement; the rest are a real finding.
  const capitals = capitalStatements
    .map((s) => ({
      label: labelOf(refs[s.value?.id], lang),
      title: enTitle(refs[s.value?.id]),
      from: qualifierTime(s, 'P580')?.year ?? null,
      to: qualifierTime(s, 'P582')?.year ?? null,
      rank: s.rank,
    }))
    .filter((c) => c.label);
  const current = capitals.find((c) => c.rank === 'preferred' && c.to == null)
    || capitals.find((c) => c.to == null)
    || capitals[capitals.length - 1] || null;
  const former = capitals
    .filter((c) => c !== current && c.from != null)
    .sort((a, b) => a.from - b.from);

  const emblems = [
    flag && { kind: 'Flag', src: commonsThumb(flag.value, 500), file: flag.value },
    arms && { kind: 'Coat of arms', src: commonsThumb(arms.value, 330), file: arms.value },
  ].filter(Boolean);

  return {
    emblems,
    capital: current,
    formerCapitals: former,
    rows: [
      labelRow('Motto', mottoOf(subject, refs, lang)),
      labelRow('Anthem', labelOf(refs[claimIds(subject, 'P85')[0]])),
      labelRow('Official language', claimIds(subject, 'P37').map((id) => labelOf(refs[id], lang)).filter(Boolean).slice(0, 4).join(' · ')),
      labelRow('Currency', labelOf(refs[claimIds(subject, 'P38')[0]])),
      labelRow('Government', labelOf(refs[claimIds(subject, 'P122')[0]])),
      labelRow('Calling code', claimValues(subject, 'P474')[0] || null),
      labelRow('Driving side', labelOf(refs[claimIds(subject, 'P1622')[0]])),
    ].filter(Boolean),
  };
}

/** A motto is either an item reference or a monolingual string. Accept both. */
function mottoOf(subject, refs, lang = 'en') {
  const v = claimValues(subject, 'P1546')[0];
  if (!v) return null;
  if (v.id) return labelOf(refs[v.id], lang);
  return typeof v === 'string' ? v : v.text || null;
}

function labelRow(label, value) {
  return value ? { label, value: String(value) } : null;
}

/** The statement in force now: preferred rank, or the one with no end date. */
function pickDated(statements) {
  if (!statements.length) return null;
  const open = statements.filter((s) => !qualifierTime(s, 'P582'));
  const pool = open.length ? open : statements;
  return pool.slice().sort(byRank)[0];
}

// ---- lineage -------------------------------------------------------------

/**
 * Bounded, deduped, bidirectional walk over the succession graph. Levels are
 * signed: negative is earlier, positive is later, so the renderer can lay the
 * whole thing out as one left-to-right chain without a graph library.
 */
async function buildLineage(subject, qid, lang = 'en') {
  if (!qid) return null;
  const nodes = new Map([[qid, nodeOf(qid, subject, 0, null, lang)]]);
  const edges = [];
  const truncated = new Map(); // level -> how many we did not show

  for (const [props, sign] of [[BACKWARD, -1], [FORWARD, 1]]) {
    let frontier = [{ qid, entity: subject }];

    for (let hop = 0; hop < MAX_HOPS && frontier.length && nodes.size < MAX_NODES; hop++) {
      const level = sign * (hop + 1);
      const found = [];

      for (const parent of frontier) {
        const seen = new Set();
        const candidates = [];
        for (const [prop, verb] of props) {
          for (const id of claimIds(parent.entity, prop)) {
            if (seen.has(id)) continue;
            seen.add(id);
            candidates.push({ id, verb });
          }
        }
        const cap = FANOUT[hop] ?? 2;
        if (candidates.length > cap) {
          truncated.set(level, (truncated.get(level) || 0) + candidates.length - cap);
        }
        for (const c of candidates.slice(0, cap)) {
          // An edge is worth recording even when the node is already placed —
          // that is how a chain that rejoins itself stays visible.
          edges.push(sign < 0
            ? { from: c.id, to: parent.qid, via: c.verb }
            : { from: parent.qid, to: c.id, via: c.verb });
          if (nodes.has(c.id) || found.some((f) => f.id === c.id)) continue;
          if (nodes.size + found.length >= MAX_NODES) { truncated.set(level, (truncated.get(level) || 0) + 1); continue; }
          found.push(c);
        }
      }
      if (!found.length) break;

      const fetched = await fetchEntities(found.map((f) => f.id), { props: ENTITY_PROPS, sitefilter: siteOf(lang), lang });
      const placed = [];
      for (const f of found) {
        const ent = fetched[f.id];
        if (!ent) continue;
        nodes.set(f.id, nodeOf(f.id, ent, level, f.verb, lang));
        placed.push({ qid: f.id, entity: ent });
      }
      frontier = placed.slice(0, WALK_ON_FROM);
    }
  }

  const list = [...nodes.values()];
  // One neighbour is not a lineage, it is a footnote. Render nothing instead.
  if (list.length < 3) return null;

  const levels = [...new Set(list.map((n) => n.level))].sort((a, b) => a - b);
  return {
    nodes: list.sort((a, b) => a.level - b.level || (a.from ?? 0) - (b.from ?? 0)),
    edges: dedupeEdges(edges).filter((e) => nodes.has(e.from) && nodes.has(e.to)),
    levels,
    truncated: [...truncated.entries()].map(([level, n]) => ({ level, n })),
  };
}

function nodeOf(id, entity, level, via, lang = 'en') {
  const flag = pickDated(claimStatements(entity, 'P41'));
  const inceptions = claimTimes(entity, 'P571').map((t) => t.year);
  return {
    qid: id,
    level,
    via,
    label: labelOf(entity, lang) || id,
    title: enTitle(entity),
    description: entity?.descriptions?.en?.value || '',
    from: inceptions.length ? Math.min(...inceptions) : null,
    to: claimTime(entity, 'P576')?.year ?? null,
    flag: flag ? commonsThumb(flag.value, 250) : null,
    thumb: null,
  };
}

function dedupeEdges(edges) {
  const seen = new Set();
  return edges.filter((e) => {
    const k = `${e.from}>${e.to}`;
    if (seen.has(k) || e.from === e.to) return false;
    seen.add(k);
    return true;
  });
}

// ---- rulers --------------------------------------------------------------

const MAX_TENURES = 18;

/**
 * Tenure bars on a shared axis. A tenure with no start date cannot be drawn, so
 * it is separated out and shown as a card rather than silently dropped.
 */
function buildRulers(statements, refs, thumbs, lang = 'en') {
  const tracks = new Map();

  for (const s of statements) {
    const ent = refs[s.value?.id];
    if (!ent) continue;
    const title = enTitle(ent);
    const from = qualifierTime(s, 'P580')?.year ?? null;
    const to = qualifierTime(s, 'P582')?.year ?? null;
    const person = {
      qid: s.value.id,
      label: labelOf(ent, lang) || s.value.id,
      title,
      thumb: (title && thumbs[title]?.thumb) || null,
      description: ent.descriptions?.en?.value || '',
      note: labelOf(refs[qualifierId(s, 'P39')], lang) || labelOf(refs[qualifierId(s, 'P102')], lang) || '',
      from, to,
      current: from != null && to == null,
    };
    if (!tracks.has(s.role)) tracks.set(s.role, { role: s.role, prop: s.prop, dated: [], undated: [] });
    (from != null ? tracks.get(s.role).dated : tracks.get(s.role).undated).push(person);
  }

  const out = [];
  for (const t of tracks.values()) {
    t.dated.sort((a, b) => a.from - b.from);
    if (t.dated.length > MAX_TENURES) {
      t.omitted = t.dated.length - MAX_TENURES;
      t.dated = t.dated.slice(-MAX_TENURES); // the recent end is the legible end
    }
    if (t.dated.length || t.undated.length) out.push(t);
  }

  const dated = out.reduce((a, t) => a + t.dated.length, 0);
  if (dated < 4) return null; // an axis with three bars is a list, not a chart

  const years = out.flatMap((t) => t.dated.flatMap((p) => [p.from, p.to].filter((y) => y != null)));
  const now = new Date().getUTCFullYear();
  return {
    tracks: out,
    from: Math.min(...years),
    to: Math.max(...years, out.some((t) => t.dated.some((p) => p.current)) ? now : -Infinity),
  };
}

// ---- territory -----------------------------------------------------------

function buildTerritory(subject, refs, neighbourIds, subdivisionIds, subTypes, subTypeIds, lang = 'en') {
  const pin = (id, layer) => {
    const ent = refs[id];
    const coord = ent && claimCoord(ent);
    if (!coord) return null;
    return {
      title: enTitle(ent) || labelOf(ent, lang),
      label: labelOf(ent, lang) || id,
      lat: coord.lat, lon: coord.lon,
      description: ent.descriptions?.en?.value || '',
      layer,
    };
  };

  const neighbours = neighbourIds.map((id) => pin(id, 'neighbours')).filter(Boolean);
  const subdivisions = subdivisionIds.map((id) => pin(id, 'subdivisions')).filter(Boolean);

  // Modal P31 label across the first few subdivisions, title-cased for a legend.
  // The Soviet republics are typed "historical country", which names them
  // correctly and describes them uselessly — a class that generic is no better
  // than the default word.
  const GENERIC = /^(country|historical country|sovereign state|state|nation|territory|republic|former administrative territorial entity)$/i;
  const tally = new Map();
  for (const id of subTypeIds) {
    const l = labelOf(subTypes[id], lang);
    if (l && !GENERIC.test(l)) tally.set(l, (tally.get(l) || 0) + 1);
  }
  let subdivisionLabel = 'Subdivisions', best = 0;
  for (const [l, n] of tally) if (n > best) { best = n; subdivisionLabel = plural(l); }

  return {
    neighbours,
    subdivisions,
    subdivisionLabel,
    neighboursMissing: neighbourIds.length - neighbours.length,
    subdivisionsMissing: subdivisionIds.length - subdivisions.length,
  };
}

/** "prefecture of Japan" -> "Prefectures of Japan". Nouns only, no grammar. */
function plural(label) {
  const s = String(label);
  const head = s.split(' of ')[0];
  const rest = s.slice(head.length);
  const p = /(s|x|ch|sh)$/i.test(head) ? `${head}es` : /[^aeiou]y$/i.test(head) ? `${head.slice(0, -1)}ies` : `${head}s`;
  return (p + rest).replace(/^./, (c) => c.toUpperCase());
}

// ---- helpers -------------------------------------------------------------

function labelOf(entity, lang = 'en') {
  const labels = entity?.labels;
  if (!labels) return null;
  // The article's own language first, English second — fetchEntities asks for
  // exactly those two, so a German book gets German names where they exist.
  return labels[lang]?.value || labels.en?.value || Object.values(labels)[0]?.value || null;
}

/**
 * The article title on the wiki this book is being built from. `sitefilter`
 * narrows each entity to a single sitelink, so whichever key is present is the
 * right one — no need to know the site code down here.
 */
function enTitle(entity) {
  const links = entity?.sitelinks;
  if (!links) return null;
  const key = Object.keys(links)[0];
  return key ? links[key].title : null;
}
