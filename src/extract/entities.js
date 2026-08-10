// Wikilinks -> typed, located, dated entities.
//
// This is what turns "a page full of blue links" into a cast list, a map and a
// timeline. Still zero model: P31 says what a thing is, P625 says where it is,
// P569/P570 say when it lived.
import { fetchPageProps, fetchEntities, claimIds, claimTime, claimCoord, claimQuantity } from '../wiki.js';

// Type roots we care about for block-building. Shallow on purpose: we check the
// direct P31 values plus one level of P279, which is enough for cast/map work.
const HUMAN = new Set(['Q5']);
const PLACE_HINT = new Set([
  'Q515', 'Q486972', 'Q6256', 'Q3957', 'Q532', 'Q82794', 'Q2221906', 'Q56061',
  'Q1549591', 'Q5119', 'Q15284', 'Q4022', 'Q23442', 'Q8502', 'Q46831', 'Q165',
  'Q41176', 'Q1187811', 'Q34876', 'Q10864048',
]);
const UNIT_HINT = new Set([
  'Q176799', 'Q37726', 'Q131647', 'Q6857706', 'Q1080794', 'Q3719246', 'Q101352',
  'Q4423781', 'Q1516513', 'Q207318', 'Q2385804',
]);

/**
 * @param {string[]} titles ranked link titles (infobox first, then frequency)
 * @param {number} limit how many we're willing to spend requests on
 */
export async function resolveEntities(titles, { limit = 140, lang = 'en' } = {}) {
  const wanted = titles.slice(0, limit);
  const props = await fetchPageProps(wanted, lang);

  const qids = [];
  const byTitle = new Map();
  for (const t of wanted) {
    const p = props[t] || props[t.replace(/_/g, ' ')];
    if (!p?.qid) continue;
    byTitle.set(t, { title: t, canonical: p.title, qid: p.qid, thumb: p.thumb });
    qids.push(p.qid);
  }

  const entities = await fetchEntities(qids, { props: 'claims|labels|descriptions', lang });

  const resolved = new Map();
  for (const [title, base] of byTitle) {
    const ent = entities[base.qid];
    if (!ent) { resolved.set(title, { ...base, types: [] }); continue; }
    const types = claimIds(ent, 'P31');
    const birth = claimTime(ent, 'P569');
    const death = claimTime(ent, 'P570');
    resolved.set(title, {
      ...base,
      label: (ent.labels?.[lang]?.value || ent.labels?.en?.value) || base.canonical || title,
      description: (ent.descriptions?.[lang]?.value || ent.descriptions?.en?.value) || '',
      types,
      isHuman: types.some((t) => HUMAN.has(t)),
      isPlace: !!claimCoord(ent) || types.some((t) => PLACE_HINT.has(t)),
      isUnit: types.some((t) => UNIT_HINT.has(t)),
      coord: claimCoord(ent),
      birth, death,
      start: claimTime(ent, 'P580'),
      end: claimTime(ent, 'P582'),
      inception: claimTime(ent, 'P571'),
      pointInTime: claimTime(ent, 'P585'),
      population: claimQuantity(ent, 'P1082'),
      area: claimQuantity(ent, 'P2046'),
      elevation: claimQuantity(ent, 'P2044'),
      country: claimIds(ent, 'P17')[0] || null,
      image: claimIds(ent, 'P18')[0] || null,
      countryOf: null,
    });
  }
  return resolved;
}

/** Pull the named entities out of an infobox row's linked titles, in order. */
export function pickEntities(resolved, titles, filter) {
  const out = [];
  const seen = new Set();
  for (const t of titles) {
    const e = resolved.get(t) || resolved.get(t.replace(/ /g, '_')) || resolved.get(t.replace(/_/g, ' '));
    if (!e || seen.has(e.qid)) continue;
    if (filter && !filter(e)) continue;
    seen.add(e.qid);
    out.push(e);
  }
  return out;
}

export function yearOf(t) {
  return t && typeof t.year === 'number' ? t.year : null;
}
