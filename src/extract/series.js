// Dated Wikidata claims -> a time series.
//
// A country's population is not a number, it is 37 numbers each carrying a
// P585 point-in-time qualifier. `claimValues` collapses that to one, which is
// how Japan ends up with a single "125,570,246" and no history. This reads the
// qualifiers instead.
//
// The trap is that a dated series is often not one series. Singapore records 76
// population statements under several different P1013 "criterion used" values
// (total population, resident population, …). Plotting them on one line would
// draw a saw-tooth that exists nowhere in the source. So we pick the single
// dominant criterion, plot only that, and report how many points that cost.
import { claimStatements, qualifierTime, qualifierId } from '../wiki.js';

const RANK_ORDER = { preferred: 0, normal: 1 };

/**
 * @param {object} entity   Wikidata entity
 * @param {string} prop     a quantity property carrying P585 qualifiers
 * @param {{minPoints?:number}} opts
 * @returns {{points:{year:number,value:number}[], dropped:number, criterion:string|null,
 *            first:object, last:object, peak:object, low:object}|null}
 */
export function datedSeries(entity, prop, { minPoints = 5 } = {}) {
  const raw = [];
  for (const s of claimStatements(entity, prop)) {
    const t = qualifierTime(s, 'P585');
    const amount = Number(String(s.value?.amount ?? '').replace('+', ''));
    if (!t || typeof t.year !== 'number' || !Number.isFinite(amount)) continue;
    // P1013 says *which* population (total, resident, de jure); P459 says how it
    // was arrived at (census, estimate). Mixing either produces a saw-tooth, so
    // both together form the key.
    const criterion = [qualifierId(s, 'P1013') || '', qualifierId(s, 'P459') || ''].join('/');
    raw.push({ year: t.year, value: amount, rank: s.rank, criterion });
  }
  if (!raw.length) return null;

  // Dominant criterion wins, counted in *distinct years* rather than statements:
  // Japan's largest bucket is 25 monthly estimates spanning four years, while
  // its census bucket is 6 statements spanning 1995–2020. The second is a
  // series; the first is a cluster. A tie goes to whichever appeared first, so
  // the choice is stable across rebuilds.
  const tally = new Map();
  for (const p of raw) {
    const k = p.criterion || '';
    if (!tally.has(k)) tally.set(k, new Set());
    tally.get(k).add(p.year);
  }
  let criterion = null, best = -1;
  for (const [k, years] of tally) if (years.size > best) { best = years.size; criterion = k; }

  const kept = raw.filter((p) => (p.criterion || '') === criterion);
  const dropped = raw.length - kept.length;

  // One point per year: a preferred-rank statement beats a normal one.
  const byYear = new Map();
  for (const p of kept) {
    const prev = byYear.get(p.year);
    if (!prev || (RANK_ORDER[p.rank] ?? 1) < (RANK_ORDER[prev.rank] ?? 1)) byYear.set(p.year, p);
  }

  const points = [...byYear.values()]
    .map((p) => ({ year: p.year, value: p.value }))
    .sort((a, b) => a.year - b.year);

  if (points.length < minPoints) return null;

  const peak = points.reduce((a, b) => (b.value > a.value ? b : a));
  const low = points.reduce((a, b) => (b.value < a.value ? b : a));
  return {
    points,
    dropped,
    criterion: criterion.replace(/^\/|\/$/g, '') || null,
    first: points[0],
    last: points[points.length - 1],
    peak,
    low,
  };
}
