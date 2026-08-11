// What you have read, kept on your own machine.
//
// The server knows which books are *bound* (they sit in its cache) but not which
// ones you opened, and it has no account to hang that on. So the shelf is local:
// a small list in localStorage, newest first, deduplicated by language+title.

export const HISTORY_KEY = 'readingroom.history';
const LIMIT = 48;

export function readHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((b) => b && b.title) : [];
  } catch { return []; }
}

/**
 * Records a book you actually opened. Called once the text frame lands, so a
 * build that failed never leaves a volume on the shelf.
 */
export function remember(book) {
  if (!book?.title) return;
  const lang = book.lang || 'en';
  const cover = book.blocks?.find((b) => b.type === 'cover');

  const entry = {
    lang,
    title: book.title,
    href: lang === 'en'
      ? `/read/${encodeURIComponent(book.title.replace(/ /g, '_'))}`
      : `/read/${lang}/${encodeURIComponent(book.title.replace(/ /g, '_'))}`,
    archetype: book.archetype || 'generic',
    words: book.stats?.words || 0,
    chapters: book.stats?.chapters || 0,
    subtitle: cover?.subtitle || book.subject?.description || '',
    cover: cover?.image || null,
    at: Date.now(),
  };

  try {
    const key = `${entry.lang}:${entry.title}`;
    const rest = readHistory().filter((b) => `${b.lang || 'en'}:${b.title}` !== key);
    localStorage.setItem(HISTORY_KEY, JSON.stringify([entry, ...rest].slice(0, LIMIT)));
  } catch { /* private mode, or full — the shelf is a nicety, not the product */ }
}

export function forget(lang, title) {
  try {
    const key = `${lang}:${title}`;
    localStorage.setItem(HISTORY_KEY,
      JSON.stringify(readHistory().filter((b) => `${b.lang || 'en'}:${b.title}` !== key)));
  } catch { /* ignore */ }
}
