// Chronology extraction.
//
// Wikipedia prose is dense with explicit dates ("On 19 November 1942, the Red
// Army launched Operation Uranus"). Pulling them out with a date grammar and
// anchoring each to its sentence + chapter gives a real scrubber for free.
// We clamp to the subject's own date window so "World War II" mentions in a
// Background section don't drag the axis out to 1914.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];
const MONTH_IDX = new Map(MONTHS.map((m, i) => [m.toLowerCase(), i + 1]));
const M = MONTHS.join('|');

const RE_DMY = new RegExp(`\\b(\\d{1,2})\\s+(${M})\\s+(\\d{3,4})\\b`, 'gi');
const RE_MDY = new RegExp(`\\b(${M})\\s+(\\d{1,2}),\\s*(\\d{3,4})\\b`, 'gi');
const RE_MY = new RegExp(`\\b(${M})\\s+(\\d{3,4})\\b`, 'gi');

// Bare years, opt-in. A battle is narrated in days and a life in months, so for
// those this pattern is all noise; a national history is narrated in years
// ("Japan was unified in 1590"), and without it the rail is nearly empty. Only
// AD 1000–2099 and explicit BC/BCE, so quantities and page numbers cannot pass.
// The `(?!,\d)` guards reject the leading group of a comma-grouped number:
// without it "around 900,000 reservists" reads as the year 900, and lands a
// sentence about the modern army at the far left of a millennial axis.
const RE_YEAR = /\b(1\d{3}|20\d{2})\b(?!,\d)(?!\s*(?:km|kg|m\b|ft|mi\b|%))/g;
// The lookbehind matters too: without it "14,500 BC" yields the year 500.
const RE_BC = /(?<![\d,])(\d{1,4})\s*(?:BCE?|B\.C\.)\b/g;
// A three-digit number is far more often a quantity than a year, so it counts
// only behind an explicit temporal cue. This is what reaches Japan's Nara and
// Heian periods, which sit entirely below the year 1000.
const RE_YEAR3 = /\b(?:in|by|since|until|from|around|circa|c\.|AD|during)\s+(\d{3})\b(?!,\d)/gi;

/**
 * @param {object} source  SourceModel
 * @param {{from:number,to:number}|null} window inclusive year window
 * @param {{max?:number, bareYears?:boolean}} opts
 */
export function extractChronology(source, window, { max = 80, bareYears = false } = {}) {
  const found = new Map(); // key -> event

  const chunks = [{ id: 'lead', title: 'Opening', text: source.lead.text },
    ...source.chapters.map((c) => ({ id: c.id, title: c.title, text: c.text }))];

  for (const chunk of chunks) {
    const text = chunk.text;
    if (!text) continue;
    const hits = [];

    const patterns = [[RE_DMY, 'dmy'], [RE_MDY, 'mdy'], [RE_MY, 'my']];
    if (bareYears) patterns.push([RE_BC, 'bc'], [RE_YEAR, 'y'], [RE_YEAR3, 'y']);

    for (const [re, order] of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        let y, mo, d;
        if (order === 'dmy') { d = +m[1]; mo = MONTH_IDX.get(m[2].toLowerCase()); y = +m[3]; }
        else if (order === 'mdy') { mo = MONTH_IDX.get(m[1].toLowerCase()); d = +m[2]; y = +m[3]; }
        else if (order === 'my') { mo = MONTH_IDX.get(m[1].toLowerCase()); d = null; y = +m[2]; }
        else if (order === 'bc') { mo = null; d = null; y = -Math.abs(+m[1]); }
        else { mo = null; d = null; y = +m[1]; }
        if (!y || y > 2200) continue;
        if (d && d > 31) continue;
        hits.push({ y, mo, d, index: m.index, len: m[0].length, raw: m[0], precise: order === 'dmy' || order === 'mdy' });
      }
    }

    // A month-year hit that sits inside a fuller date is a duplicate.
    hits.sort((a, b) => a.index - b.index || b.len - a.len);
    const claimed = [];
    for (const h of hits) {
      if (claimed.some((c) => h.index >= c.s && h.index < c.e)) continue;
      claimed.push({ s: h.index, e: h.index + h.len });
      if (window && (h.y < window.from || h.y > window.to)) continue;

      const key = `${h.y}-${h.mo}-${h.d || 0}`;
      if (found.has(key)) continue;
      const sentence = sentenceAround(text, h.index, h.len);
      if (!readableSentence(sentence)) continue;
      found.set(key, {
        year: h.y, month: h.mo, day: h.d, precise: h.precise, raw: h.raw,
        sentence,
        chapterId: chunk.id, chapterTitle: chunk.title,
        sort: h.y * 10000 + (h.mo || 0) * 100 + (h.d || 0),
      });
    }
  }

  const events = [...found.values()].sort((a, b) => a.sort - b.sort);
  if (events.length <= max) return events;
  return thin(events, max);
}

/**
 * Thinning has to drop events, and *which* ones it drops is a real editorial
 * act if you let it be one. Taking every n-th event by position is not neutral,
 * it is arbitrary: on Ukraine it kept "contributions to UN peacekeeping
 * operations since 1992" and dropped the signing of the Budapest Memorandum.
 *
 * So: cut the run into equal neighbourhoods to keep the axis evenly covered,
 * and inside each one keep the richest *mention* — a date the source pinned to
 * a day over a bare year, then the sentence that carries more of its own
 * context. Both signals are structural. Neither is a claim about which events
 * mattered; that judgement is not ours to make.
 */
function thin(events, max) {
  const width = events.length / max;
  const out = [];
  for (let i = 0; i < max; i++) {
    const slice = events.slice(Math.floor(i * width), Math.min(events.length, Math.floor((i + 1) * width)));
    if (!slice.length) continue;
    out.push(slice.reduce((best, e) => (weight(e) > weight(best) ? e : best)));
  }
  return out;
}

function weight(e) {
  return (e.precise ? 1e6 : 0) + Math.min(e.sentence.length, 400);
}

/**
 * Award and honours lists ("Order of Lenin (16 August 1936, 29 August 1939…)")
 * parse as dates but read as noise. Require something sentence-shaped.
 */
function readableSentence(s) {
  if (!s) return false;
  const words = s.split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
  if (words.length < 6) return false;
  const digits = (s.match(/\d/g) || []).length;
  if (digits / s.length > 0.22) return false;
  return true;
}

function sentenceAround(text, index, len) {
  let s = index, e = index + len;
  for (let i = index; i > Math.max(0, index - 400); i--) {
    if (text[i] === '.' && /\s/.test(text[i + 1] || ' ') && !/\b[A-Z]\.$/.test(text.slice(Math.max(0, i - 3), i + 1))) { s = i + 1; break; }
    s = i;
  }
  for (let i = index + len; i < Math.min(text.length, index + len + 400); i++) {
    e = i + 1;
    if (text[i] === '.' && /\s|$/.test(text[i + 1] || ' ')) break;
  }
  let out = text.slice(s, e).trim();
  if (out.length > 300) out = out.slice(0, 297).trimEnd() + '…';
  return out;
}

/** Parse a date-range window out of Wikidata claims or an infobox "Date" row. */
export function deriveWindow({ start, end, birth, death, dateText, openEndedTo }) {
  let from = start?.year ?? birth?.year ?? null;
  let to = end?.year ?? death?.year ?? null;

  if ((from == null || to == null) && dateText) {
    const years = [...dateText.matchAll(/\b(1\d{3}|20\d{2}|\d{3})\b/g)].map((m) => +m[1]);
    if (years.length) {
      from = from ?? Math.min(...years);
      to = to ?? Math.max(...years);
    }
  }
  if (from == null && to == null) return null;
  // A subject that started and hasn't ended (a city, a living person) runs to
  // today — otherwise a founding year collapses the window to a single year.
  if (to == null && from != null && openEndedTo) to = openEndedTo;
  from = from ?? to;
  to = to ?? from;
  // No padding. Years are already coarse: on a six-month battle a one-year pad
  // admits aftermath dates that stretch the axis to twice the subject's span.
  return { from, to, coreFrom: from, coreTo: to };
}
