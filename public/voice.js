// Reading aloud.
//
// The browser's own speech synthesiser, which costs nothing, needs no key, and
// keeps the promise the rest of this project makes: nothing is sent anywhere.
//
// Three things make this harder than calling speak() on the page text:
//
//   1. Long utterances are unreliable. Chrome truncates and drops `onend` past
//      roughly a paragraph, so everything is cut into sentence-sized pieces and
//      queued one at a time.
//   2. Chrome also stops speaking after ~15 seconds unless nudged, so a
//      watchdog resumes it while it believes itself to be playing.
//   3. A book is not its DOM. The reader repaints when the apparatus lands, so
//      passages are re-collected at the moment playback starts and addressed by
//      index, never by a node reference held across a repaint.

export const voiceAvailable = () =>
  typeof window !== 'undefined'
  && 'speechSynthesis' in window
  && 'SpeechSynthesisUtterance' in window;

const RATE_KEY = 'readingroom.voice.rate';

// Long enough to keep prosody, short enough that no engine truncates it.
const MAX_CHUNK = 240;

const state = {
  passages: [],   // [{ text, node, label }]
  i: 0,
  playing: false,
  paused: false,
  lang: 'en',
  rate: 1,
  bar: null,
  btn: null,
  collect: null,
  watchdog: null,
};

// ---- voices --------------------------------------------------------------

let voicesReady = null;

function voices() {
  if (voicesReady) return voicesReady;
  voicesReady = new Promise((resolve) => {
    const got = speechSynthesis.getVoices();
    if (got.length) return resolve(got);
    // Most engines populate the list asynchronously, some only after a tick.
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, 1200);
  });
  return voicesReady;
}

/*
 * Voice quality is almost entirely a question of *which* voice, not of any
 * parameter we can set. Two facts drive the ranking below:
 *
 *   - macOS ships around fifteen novelty voices (Bells, Boing, Zarvox,
 *     Trinoids, Whisper…) that are `localService` and match `en` perfectly, so
 *     a naive "prefer local" rule can and does pick one of them to read a book.
 *   - Chrome's own "Google …" voices are markedly more natural than the classic
 *     system ones, and they are *not* local — so preferring local picks the
 *     worse voice on the most common setup.
 */
const NOVELTY = /\b(albert|bad news|bahh|bells|boing|bubbles|cellos|deranged|good news|hysterical|jester|junior|organ|pipe organ|ralph|superstar|trinoids|whisper|wobble|zarvox|fred|kathy|grandma|grandpa|eddy|flo|reed|rocko|sandy|shelley|sandy)\b/i;

// Engines that actually sound like a person, best first.
const TIERS = [
  [/premium|enhanced|neural|natural/i, 60],
  [/^google/i, 45],
  [/siri/i, 40],
  [/microsoft/i, 25],
];

function quality(v) {
  const name = `${v.name || ''} ${v.voiceURI || ''}`;
  if (NOVELTY.test(name)) return -100;
  let score = 0;
  for (const [re, points] of TIERS) if (re.test(name)) { score = points; break; }
  if (v.default) score += 2;
  return score;
}

/** Every voice that can read this language, best first, novelties removed. */
export async function voicesFor(lang) {
  const all = await voices();
  const want = String(lang || 'en').toLowerCase();
  const base = want.split('-')[0];
  return all
    .filter((v) => {
      const vl = (v.lang || '').toLowerCase().replace('_', '-');
      return vl === want || vl.split('-')[0] === base;
    })
    .map((v) => ({ v, q: quality(v) }))
    .filter((x) => x.q > -100)
    .sort((a, b) => b.q - a.q || a.v.name.localeCompare(b.v.name))
    .map((x) => x.v);
}

const voiceKey = (lang) => `readingroom.voice.name.${String(lang).split('-')[0]}`;

/**
 * A German book should be read in German. Honours a saved choice for this
 * language, otherwise takes the best-ranked voice available.
 */
async function pickVoice(lang) {
  const list = await voicesFor(lang);
  if (!list.length) return null;
  try {
    const saved = localStorage.getItem(voiceKey(lang));
    if (saved) {
      const hit = list.find((v) => v.name === saved);
      if (hit) return hit;
    }
  } catch { /* ignore */ }
  return list[0];
}

// ---- text preparation ----------------------------------------------------

/** Sentence-sized pieces, so no engine has a chance to truncate one. */
function chunk(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  if (clean.length <= MAX_CHUNK) return [clean];

  const out = [];
  let buf = '';
  // Split on sentence ends, keeping the terminator with its sentence.
  for (const piece of clean.split(/(?<=[.!?])\s+/)) {
    if ((buf + ' ' + piece).trim().length > MAX_CHUNK && buf) { out.push(buf.trim()); buf = piece; }
    else buf = (buf ? buf + ' ' : '') + piece;
    // A single sentence longer than the cap still has to be broken somewhere.
    while (buf.length > MAX_CHUNK) {
      const cut = buf.lastIndexOf(' ', MAX_CHUNK);
      out.push(buf.slice(0, cut > 60 ? cut : MAX_CHUNK).trim());
      buf = buf.slice(cut > 60 ? cut : MAX_CHUNK).trim();
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * Expand collected passages into speakable pieces, keeping their node and their
 * language. A shelf holds books from many Wikipedias, and a Korean title read
 * by an English voice is noise — so language travels with the passage, not with
 * the page.
 */
function flatten(passages) {
  const out = [];
  for (const p of passages) {
    for (const text of chunk(p.text)) {
      out.push({ text, node: p.node || null, label: p.label || '', lang: p.lang || null });
    }
  }
  return out;
}

// ---- playback ------------------------------------------------------------

function highlight(node) {
  document.querySelectorAll('.speaking').forEach((n) => n.classList.remove('speaking'));
  if (!node) return;
  node.classList.add('speaking');
  const r = node.getBoundingClientRect();
  // Only move the page when the reader would otherwise lose the passage.
  if (r.top < 80 || r.bottom > innerHeight - 60) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

async function speakCurrent() {
  const p = state.passages[state.i];
  if (!p) return stop();

  highlight(p.node);
  updateBar();

  const lang = p.lang || state.lang;
  const u = new SpeechSynthesisUtterance(p.text);
  u.lang = lang;
  u.rate = state.rate;
  const v = await pickVoice(lang);
  if (v) u.voice = v;

  u.onend = () => {
    if (!state.playing) return;
    state.i++;
    if (state.i >= state.passages.length) return stop({ finished: true });
    speakCurrent();
  };
  // A failed piece must not end the reading; skip it and carry on.
  u.onerror = (ev) => {
    if (!state.playing || ev.error === 'interrupted' || ev.error === 'canceled') return;
    state.i++;
    if (state.i >= state.passages.length) return stop({ finished: true });
    speakCurrent();
  };

  speechSynthesis.speak(u);
}

export function start() {
  if (!voiceAvailable()) return;
  const collected = state.collect ? state.collect() : [];
  state.passages = flatten(collected);
  if (!state.passages.length) return;

  speechSynthesis.cancel();
  state.i = 0;
  state.playing = true;
  state.paused = false;
  showBar();
  runWatchdog();
  speakCurrent();
  paintBtn();
}

export function stop({ finished = false } = {}) {
  state.playing = false;
  state.paused = false;
  speechSynthesis.cancel();
  clearInterval(state.watchdog);
  state.watchdog = null;
  document.querySelectorAll('.speaking').forEach((n) => n.classList.remove('speaking'));
  hideBar(finished);
  paintBtn();
}

export function togglePause() {
  if (!state.playing) return;
  if (state.paused) { speechSynthesis.resume(); state.paused = false; }
  else { speechSynthesis.pause(); state.paused = true; }
  paintBtn();
  updateBar();
}

function jump(delta) {
  if (!state.playing) return;
  const next = Math.min(state.passages.length - 1, Math.max(0, state.i + delta));
  state.i = next;
  speechSynthesis.cancel();     // fires onerror:'interrupted', which we ignore
  state.paused = false;
  speakCurrent();
  paintBtn();
}

/**
 * Chrome stops speaking after about fifteen seconds unless something touches
 * the queue. Pausing and resuming while it believes it is playing keeps it
 * going, and is a no-op everywhere else.
 */
function runWatchdog() {
  clearInterval(state.watchdog);
  state.watchdog = setInterval(() => {
    if (!state.playing || state.paused) return;
    if (speechSynthesis.speaking) { speechSynthesis.pause(); speechSynthesis.resume(); }
  }, 9000);
}

// ---- the control bar -----------------------------------------------------

function showBar() {
  if (state.bar) { state.bar.hidden = false; return; }

  const bar = document.createElement('div');
  bar.className = 'voice-bar';
  bar.innerHTML =
    `<button class="voice-ctl" data-act="prev" aria-label="Previous passage">⏮</button>` +
    `<button class="voice-ctl voice-play" data-act="play" aria-label="Pause">⏸</button>` +
    `<button class="voice-ctl" data-act="next" aria-label="Next passage">⏭</button>` +
    `<div class="voice-where"><span class="voice-label"></span><span class="voice-count"></span></div>` +
    `<select class="voice-pick" aria-label="Voice"></select>` +
    `<label class="voice-rate">` +
      `<span class="sr-only">Speed</span>` +
      `<input type="range" min="0.6" max="1.8" step="0.1" value="${state.rate}">` +
      `<span class="voice-rate-val">${state.rate.toFixed(1)}×</span>` +
    `</label>` +
    `<button class="voice-ctl voice-stop" data-act="stop" aria-label="Stop reading">✕</button>`;

  bar.addEventListener('click', (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (act === 'play') togglePause();
    else if (act === 'stop') stop();
    else if (act === 'prev') jump(-1);
    else if (act === 'next') jump(1);
  });

  const range = bar.querySelector('input[type=range]');
  range.addEventListener('input', () => {
    state.rate = Number(range.value);
    bar.querySelector('.voice-rate-val').textContent = `${state.rate.toFixed(1)}×`;
    try { localStorage.setItem(RATE_KEY, String(state.rate)); } catch { /* ignore */ }
    // Rate only applies to a new utterance, so restart the current piece.
    if (state.playing) { speechSynthesis.cancel(); speakCurrent(); }
  });

  document.body.appendChild(bar);
  state.bar = bar;
  fillVoicePicker();
  updateBar();
}

/**
 * Which voices exist is entirely the reader's machine's business, so the honest
 * interface is a list rather than a promise about quality. Ranked best-first;
 * the choice is remembered per language, because a good English voice says
 * nothing about which German one to use.
 */
async function fillVoicePicker() {
  const sel = state.bar?.querySelector('.voice-pick');
  if (!sel) return;
  const list = await voicesFor(state.lang);

  if (!list.length) {
    sel.innerHTML = '<option>no voice installed</option>';
    sel.disabled = true;
    return;
  }

  let saved = null;
  try { saved = localStorage.getItem(voiceKey(state.lang)); } catch { /* ignore */ }

  sel.innerHTML = list
    .map((v) => `<option value="${v.name.replace(/"/g, '&quot;')}"${v.name === saved ? ' selected' : ''}>`
      + `${v.name}</option>`)
    .join('');

  sel.onchange = () => {
    try { localStorage.setItem(voiceKey(state.lang), sel.value); } catch { /* ignore */ }
    // A voice only takes effect on a new utterance, so restart this passage.
    if (state.playing) { speechSynthesis.cancel(); speakCurrent(); }
  };
}

function hideBar(finished) {
  if (!state.bar) return;
  if (finished) {
    state.bar.querySelector('.voice-label').textContent = 'Finished';
    state.bar.querySelector('.voice-count').textContent = '';
    setTimeout(() => { if (!state.playing && state.bar) state.bar.hidden = true; }, 2200);
  } else {
    state.bar.hidden = true;
  }
}

function updateBar() {
  if (!state.bar) return;
  const p = state.passages[state.i];
  state.bar.querySelector('.voice-label').textContent = p?.label || '';
  state.bar.querySelector('.voice-count').textContent =
    `${state.i + 1} / ${state.passages.length}`;
  const play = state.bar.querySelector('.voice-play');
  play.textContent = state.paused ? '▶' : '⏸';
  play.setAttribute('aria-label', state.paused ? 'Resume' : 'Pause');
}

function paintBtn() {
  const b = state.btn;
  if (!b) return;
  const on = state.playing && !state.paused;
  b.textContent = on ? '❙❙' : '▶';
  b.title = state.playing ? (state.paused ? 'Resume reading aloud' : 'Pause reading aloud') : 'Read this page aloud';
  b.setAttribute('aria-label', b.title);
  b.setAttribute('aria-pressed', String(state.playing));
  b.classList.toggle('on', state.playing);
}

// ---- wiring --------------------------------------------------------------

/**
 * @param {HTMLElement} btn      the header button
 * @param {() => Array} collect  called at play time; returns [{text, node?, label?}]
 * @param {string} lang          the page's language, so the right voice is picked
 */
export function wireVoice(btn, { collect, lang = 'en' } = {}) {
  if (!btn) return;
  state.btn = btn;
  state.collect = collect;
  state.lang = lang;
  try {
    const saved = Number(localStorage.getItem(RATE_KEY));
    if (saved >= 0.6 && saved <= 1.8) state.rate = saved;
  } catch { /* ignore */ }

  if (!voiceAvailable()) {
    btn.hidden = true;
    return;
  }

  btn.hidden = false;
  btn.addEventListener('click', () => {
    if (!state.playing) start();
    else togglePause();
  });
  paintBtn();

  // Speech is global to the browser and outlives the document, so a navigation
  // that left it running would go on reading the previous page.
  addEventListener('pagehide', () => speechSynthesis.cancel());
  addEventListener('beforeunload', () => speechSynthesis.cancel());
}

/** Lets a page update the language after its content loads. */
export function setVoiceLang(lang) {
  state.lang = lang || 'en';
}
