// Per-language knowledge.
//
// Almost nothing in this pipeline is language-bound: archetypes, coordinates,
// dates, populations and rulers all come from Wikidata, which is shared across
// every Wikipedia. Only two things are written in the article's own language —
// the names of the end-matter sections, and the way prose spells a date.
//
// A language we don't know still produces a book. It loses apparatus filtering
// (reference sections become ordinary chapters) and the prose chronology, which
// is the honest failure: better an absent block than a chronology built by
// guessing at unfamiliar date grammar.

const LANGUAGES = {
  en: {
    name: 'English',
    apparatus: ['references', 'notes', 'citations', 'footnotes', 'bibliography', 'sources',
      'external links', 'further reading', 'see also', 'works cited', 'explanatory notes',
      'general references', 'general and cited references'],
    months: ['January', 'February', 'March', 'April', 'May', 'June', 'July',
      'August', 'September', 'October', 'November', 'December'],
    // "17 July 1942" and "July 17, 1942"
    dayFirst: true, monthFirst: true,
  },
  de: {
    name: 'Deutsch',
    apparatus: ['einzelnachweise', 'weblinks', 'literatur', 'siehe auch', 'anmerkungen',
      'quellen', 'fußnoten', 'fussnoten', 'belege', 'referenzen'],
    months: ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli',
      'August', 'September', 'Oktober', 'November', 'Dezember'],
    // German writes "1. Januar 1942" — the ordinal dot is optional in our grammar.
    dayFirst: true, monthFirst: false,
  },
  fr: {
    name: 'Français',
    apparatus: ['références', 'notes et références', 'voir aussi', 'liens externes',
      'bibliographie', 'annexes', 'articles connexes', 'notes'],
    months: ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet',
      'août', 'septembre', 'octobre', 'novembre', 'décembre'],
    dayFirst: true, monthFirst: false,
  },
  es: {
    name: 'Español',
    apparatus: ['referencias', 'véase también', 'enlaces externos', 'bibliografía',
      'notas', 'fuentes'],
    months: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio',
      'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
    dayFirst: true, monthFirst: false,
  },
  it: {
    name: 'Italiano',
    apparatus: ['note', 'bibliografia', 'voci correlate', 'altri progetti',
      'collegamenti esterni', 'fonti'],
    months: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio',
      'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
    dayFirst: true, monthFirst: false,
  },
  pt: {
    name: 'Português',
    apparatus: ['referências', 'ver também', 'ligações externas', 'bibliografia', 'notas'],
    months: ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho',
      'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
    dayFirst: true, monthFirst: false,
  },
  nl: {
    name: 'Nederlands',
    apparatus: ['referenties', 'externe links', 'zie ook', 'bronnen', 'noten', 'literatuur'],
    months: ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli',
      'augustus', 'september', 'oktober', 'november', 'december'],
    dayFirst: true, monthFirst: false,
  },
};

const FALLBACK = { name: null, apparatus: [], months: null, dayFirst: true, monthFirst: false };

export function langConfig(lang) {
  return LANGUAGES[lang] || FALLBACK;
}

export function isSupported(lang) {
  return Object.hasOwn(LANGUAGES, lang);
}

export function languageName(lang) {
  return LANGUAGES[lang]?.name || lang.toUpperCase();
}

/** Section names that are apparatus, not narrative, in this language. */
export function apparatusRe(lang) {
  const words = langConfig(lang).apparatus;
  if (!words.length) return null;
  const esc = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return new RegExp(`^(${esc})$`, 'i');
}

// Wikipedia language codes we will accept in a URL or a /read/ path. Kept as a
// pattern rather than a list: there are ~300 Wikipedias and this only has to
// separate a language segment from an article title.
const LANG_CODE = /^[a-z]{2,3}(-[a-z]{2,8})?$/;

export function looksLikeLangCode(s) {
  return typeof s === 'string' && LANG_CODE.test(s);
}

/**
 * Parse anything a reader might paste into { lang, title }.
 * Accepts full URLs (desktop, mobile, /wiki/ or ?title=), and bare titles.
 * Returns null when there is no article to be had.
 */
export function parseWikiInput(raw) {
  const input = String(raw || '').trim();
  if (!input) return null;

  // A bare title, or something with no protocol and no dots that could be a host.
  if (!/^(https?:)?\/\//i.test(input) && !/^[a-z0-9-]+\.(m\.)?wikipedia\.org/i.test(input)) {
    return { lang: 'en', title: normaliseTitle(input), source: 'text' };
  }

  let url;
  try {
    url = new URL(input.startsWith('http') ? input : `https://${input}`);
  } catch { return null; }

  const host = url.hostname.toLowerCase();
  const m = /^([a-z0-9-]+)\.(?:m\.)?wikipedia\.org$/.exec(host);
  if (!m) return null;

  const lang = m[1] === 'www' ? 'en' : m[1];

  // /wiki/Title is the common form; /w/index.php?title=Title is the other.
  let title = null;
  const wiki = /^\/wiki\/(.+)$/.exec(url.pathname);
  if (wiki) title = wiki[1];
  else if (url.searchParams.get('title')) title = url.searchParams.get('title');
  if (!title) return null;

  // Strip the fragment; a link to a section is still a link to the article.
  title = decodeURIComponent(title).split('#')[0];
  if (!title) return null;

  return { lang, title: normaliseTitle(title), source: 'url' };
}

function normaliseTitle(t) {
  return String(t).replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
}
