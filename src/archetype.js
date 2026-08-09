// Archetype detection: the scale unlock.
//
// We never design per article. We walk the Wikidata class graph (P31 -> P279*)
// from the subject upward, and the first archetype root we hit decides which
// template pack renders the book. ~20 archetypes cover most of Wikipedia;
// everything else falls through to `generic`, which is an honest plain reader.
import { fetchEntities, claimIds } from './wiki.js';

// Root classes, checked in priority order. A subject can be many things
// (Stalingrad the battle is also an "occurrence"); first match wins.
const ARCHETYPE_ROOTS = [
  ['person', new Set(['Q5', 'Q95074', 'Q15632617'])], // human, fictional character, fictional human
  ['battle', new Set([
    'Q178561',  // battle
    'Q198',     // war
    'Q180684',  // conflict
    'Q645883',  // military operation
    'Q831663',  // military campaign
    'Q2001676', // military offensive
    'Q1261499', // siege (via military operation, but pinned for safety)
  ])],
  // Above `place`, and deliberately so: every country is also a geographic
  // location, so `place` would swallow all of them. Q6256 was moved out of the
  // place set for the same reason — the two must not compete.
  ['country', new Set([
    'Q6256',    // country
    'Q3624078', // sovereign state
    'Q3024240', // historical country
    'Q1763527', // constituent state
    'Q7275',    // state
    'Q43702',   // federation
  ])],
  ['place', new Set([
    'Q2221906', // geographic location
    'Q486972',  // human settlement
    'Q56061',   // administrative territorial entity
    'Q515',     // city
    'Q82794',   // geographic region
    'Q41176',   // building
  ])],
];

const MAX_NODES = 400;
const MAX_DEPTH = 5;

/**
 * Bounded upward BFS over the subclass graph.
 * Returns { archetype, path, classes } — `path` is the chain that produced the
 * match, which we surface in the UI so the classification is auditable.
 */
export async function detectArchetype(subject) {
  const seeds = claimIds(subject, 'P31');
  if (!seeds.length) return { archetype: 'generic', path: [], classes: [] };

  // Direct hit before we spend any requests.
  const direct = matchRoots(seeds);
  if (direct) return { archetype: direct, path: seeds.filter((id) => rootSetFor(direct).has(id)), classes: seeds };

  const seen = new Set(seeds);
  const parentOf = new Map();
  let frontier = seeds;
  const allClasses = [...seeds];

  for (let depth = 0; depth < MAX_DEPTH && frontier.length && seen.size < MAX_NODES; depth++) {
    const entities = await fetchEntities(frontier, { props: 'claims' });
    const next = [];
    for (const id of frontier) {
      const ent = entities[id];
      if (!ent) continue;
      for (const parent of claimIds(ent, 'P279')) {
        if (seen.has(parent)) continue;
        seen.add(parent);
        parentOf.set(parent, id);
        next.push(parent);
        allClasses.push(parent);
      }
    }
    const hit = matchRoots(next);
    if (hit) {
      const root = next.find((id) => rootSetFor(hit).has(id));
      return { archetype: hit, path: chainTo(root, parentOf).reverse(), classes: allClasses };
    }
    frontier = next.slice(0, MAX_NODES - seen.size);
  }

  return { archetype: 'generic', path: [], classes: allClasses };
}

function rootSetFor(name) {
  return ARCHETYPE_ROOTS.find(([n]) => n === name)[1];
}

function matchRoots(ids) {
  for (const [name, roots] of ARCHETYPE_ROOTS) {
    if (ids.some((id) => roots.has(id))) return name;
  }
  return null;
}

function chainTo(id, parentOf) {
  const chain = [id];
  let cur = id;
  while (parentOf.has(cur)) { cur = parentOf.get(cur); chain.push(cur); }
  return chain;
}
