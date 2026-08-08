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

/**
 * @param {object} source  SourceModel
 * @param {{from:number,to:number}|null} window inclusive year window
 */
export function extractChronology(source, window, { max = 80 } = {}) {
  const found = new Map(); // key -> event

  const chunks = [{ id: 'lead', title: 'Opening', text: source.lead.text },
    ...source.chapters.map((c) => ({ id: c.id, title: c.title, text: c.text }))];

  for (const chunk of chunks) {
    const text = chunk.text;
    if (!text) continue;
    const hits = [];

    for (const [re, order] of [[RE_DMY, 'dmy'], [RE_MDY, 'mdy'], [RE_MY, 'my']]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        let y, mo, d;
        if (order === 'dmy') { d = +m[1]; mo = MONTH_IDX.get(m[2].toLowerCase()); y = +m[3]; }
        else if (order === 'mdy') { mo = MONTH_IDX.get(m[1].toLowerCase()); d = +m[2]; y = +m[3]; }
        else { mo = MONTH_IDX.get(m[1].toLowerCase()); d = null; y = +m[2]; }
        if (!y || y > 2200) continue;
        if (d && d > 31) continue;
        hits.push({ y, mo, d, index: m.index, len: m[0].length, raw: m[0], precise: order !== 'my' });
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

  // Too many: keep precise dates first, then thin evenly so the axis stays legible.
  const precise = events.filter((e) => e.precise);
  const pool = precise.length >= max ? precise : events;
  const step = pool.length / max;
  return Array.from({ length: max }, (_, i) => pool[Math.floor(i * step)]).filter(Boolean);
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
