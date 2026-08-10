// Parsoid HTML -> SourceModel.
//
// This is the deterministic layer: no model, no guessing. Parsoid gives us
// semantic sections, typed wikilinks and structured refs, so "book skeleton"
// is a parse, not a generation.
import { load } from 'cheerio';

// Sections that are apparatus, not narrative. They become end-matter.
// Which sections are end-matter depends on the language the article is written
// in. An unknown language yields null, and every section stays a chapter — the
// honest degradation, since a wrong guess would silently delete content.
import { apparatusRe } from '../lang.js';

// Refs from a template transclusion carry typeof="mw:Transclusion mw:Extension/ref",
// so an exact attribute match silently misses roughly a seventh of them.
const REF_SEL = 'sup[typeof~="mw:Extension/ref"], sup.mw-ref';

/** Parsoid ref hrefs may be page-qualified ("./Article#cite_note-x"). */
const noteIdOf = (href) => String(href || '').split('#').pop();

const NAV_JUNK = 'style, script, link, .navbox, .navbox-styles, .metadata, .mbox, .ambox, .hatnote, .mw-editsection, .noprint, .sistersitebox, .side-box, .portal, .mw-empty-elt, .reflist, .mw-references-wrap, .refbegin, .shortdescription, .mw-kartographer-maplink';

export function extractSource(html, { title, lang = 'en' }) {
  const APPARATUS = apparatusRe(lang);
  const $ = load(html, null, false);

  const notes = extractNotes($);
  const infobox = extractInfobox($);

  // Strip the infobox out of the flow — it is rendered as structured blocks,
  // not as part of chapter prose.
  $('table.infobox').remove();
  $(NAV_JUNK).remove();

  const links = new Map();
  for (const t of infobox.linkTitles) bumpLink(links, t, { infobox: true });

  const chapters = [];
  const topSections = $('section[data-mw-section-id]').filter((_, el) => $(el).parents('section').length === 0);

  let lead = { html: '', text: '', figures: [] };

  topSections.each((_, el) => {
    const $sec = $(el);
    const sid = $sec.attr('data-mw-section-id');
    if (sid === '0') {
      lead = renderChunk($, $sec, links);
      return;
    }
    const heading = $sec.children('h1,h2,h3,h4,h5,h6').first();
    const name = cleanText($, heading);
    if (APPARATUS?.test(name)) return;
    walkSection($, $sec, chapters, links, 1, null, APPARATUS);
  });

  const figures = [lead, ...chapters].flatMap((c) => c.figures || []);

  return {
    title,
    lead,
    infobox,
    chapters,
    notes,
    figures,
    links: [...links.values()].sort((a, b) => (b.infobox - a.infobox) || (b.count - a.count)),
  };
}

// ---- sections ------------------------------------------------------------

function walkSection($, $sec, out, links, level, parentId, APPARATUS) {
  const heading = $sec.children('h1,h2,h3,h4,h5,h6').first();
  const name = cleanText($, heading);
  const id = `ch-${out.length}-${slug(name)}`;

  // Take this section's own content, excluding nested subsections.
  const $clone = $sec.clone();
  $clone.children('section').remove();
  $clone.children('h1,h2,h3,h4,h5,h6').first().remove();

  const chunk = renderChunk($, $clone, links);
  out.push({
    id, title: name || 'Untitled', level, parentId,
    html: chunk.html, text: chunk.text, figures: chunk.figures,
    words: chunk.text.split(/\s+/).filter(Boolean).length,
  });

  $sec.children('section').each((_, sub) => {
    const $sub = $(sub);
    const subName = cleanText($, $sub.children('h1,h2,h3,h4,h5,h6').first());
    if (APPARATUS?.test(subName)) return;
    walkSection($, $sub, out, links, level + 1, id, APPARATUS);
  });
}

/** Normalise a fragment into client-safe HTML + plain text + figures. */
function renderChunk($, $node, links) {
  const $c = $node.clone();
  $c.find(NAV_JUNK).remove();

  const figures = [];
  $c.find('figure').each((_, f) => {
    const $f = $(f);
    const $img = $f.find('img').first();
    const src = normaliseImage($img.attr('src'), 960);
    if (src) {
      figures.push({
        src,
        alt: $img.attr('alt') || '',
        caption: cleanText($, $f.find('figcaption').first()),
        file: decodeURIComponent(String($img.attr('resource') || '').replace(/^\.\/File:/, '')),
        width: Number($img.attr('width')) || null,
        height: Number($img.attr('height')) || null,
      });
    }
    $f.remove(); // figures are re-laid-out by the template, not inlined
  });

  // Reference markers -> our own note handles.
  $c.find(REF_SEL).each((_, s) => {
    const $s = $(s);
    const noteId = noteIdOf($s.find('a').attr('href'));
    const label = cleanText($, $s).replace(/[[\]]/g, '');
    $s.replaceWith(`<a class="wb-note" data-note="${esc(noteId)}" href="#${esc(noteId)}">${esc(label)}</a>`);
  });

  // Wikilinks -> hover-card handles.
  $c.find('a[rel="mw:WikiLink"]').each((_, a) => {
    const $a = $(a);
    const href = $a.attr('href') || '';
    const target = decodeURIComponent(href.replace(/^\.\//, '')).split('#')[0];
    if (!target || target.includes(':')) { $a.replaceWith($a.html() || ''); return; }
    bumpLink(links, target, {});
    $a.attr('class', 'wb-link').attr('data-title', target).removeAttr('rel').removeAttr('href').removeAttr('title');
  });

  $c.find('a[rel*="mw:ExtLink"]').each((_, a) => {
    const $a = $(a);
    $a.attr('target', '_blank').attr('rel', 'noopener noreferrer').attr('class', 'wb-ext');
  });

  $c.find('img').each((_, i) => {
    const $i = $(i);
    const s = normaliseImage($i.attr('src'), 640);
    if (s) $i.attr('src', s); else $i.remove();
  });

  // Drop Parsoid bookkeeping that bloats the payload.
  $c.find('*').each((_, el) => {
    for (const attr of ['about', 'typeof', 'data-mw', 'data-parsoid', 'id', 'data-mw-section-id']) {
      if (el.attribs && attr in el.attribs) delete el.attribs[attr];
    }
  });

  $c.find('table').each((_, t) => $(t).wrap('<div class="wb-scroll"></div>'));

  // Plain text must not contain reference markers: "…von Weichs.[48] The start…"
  // would otherwise defeat sentence splitting in the chronology extractor.
  const $t = $c.clone();
  $t.find('a.wb-note').remove();

  return { html: ($c.html() || '').trim(), text: cleanText($, $t), figures };
}

// ---- infobox -------------------------------------------------------------

/**
 * Military/geography infoboxes put a label in one row and the per-side values
 * in the NEXT row's separate <td>s. We keep the column split — that two-column
 * structure is what makes a forces comparison possible without any model.
 */
function extractInfobox($) {
  const $ib = $('table.infobox').first();
  if (!$ib.length) return { rows: [], image: null, images: [], caption: '', linkTitles: [] };

  const $box = $ib.clone();
  $box.find('style, script, .mw-editsection').remove();
  $box.find(REF_SEL).remove();
  // Hidden hCard/hCalendar microformat spans are invisible on Wikipedia but
  // would otherwise surface as "(1896-12-01)1 December 1896".
  $box.find('.bday, .dday, .dtstart, .dtend, .published, .updated').remove();

  const images = [];
  $box.find('img').each((_, img) => {
    const $i = $(img);
    const src = normaliseImage($i.attr('src'), 1280);
    if (src && !images.some((i) => i.src === src)) {
      images.push({
        src,
        thumb: normaliseImage($i.attr('src'), 250),
        alt: $i.attr('alt') || '',
        w: Number($i.attr('width')) || 0,            // displayed size — filters out flag icons
        fw: Number($i.attr('data-file-width')) || 0, // original size — picks the best plate
      });
    }
  });

  const linkTitles = [];
  const rows = [];
  const headings = [];
  walkInfoboxTable($, $box, rows, linkTitles, 0, headings);

  // Infoboxes put the canonical image first, so document order beats resolution.
  // Flag icons are filtered out by displayed width, not by file width — flags
  // are often huge SVGs rendered at 23px.
  const usable = images.filter((i) => i.w >= 120);
  const plate = usable[0] || images[0];

  return {
    rows,
    headings,
    image: plate?.src || null,
    images: usable,
    caption: cleanText($, $box.find('caption').first()),
    linkTitles,
  };
}

/**
 * Rows are paired *within a single table* — a label-only row takes its values
 * from the next row of the same table. Nested tables (which is where military
 * infoboxes hide Date/Location/Result) are recursed into, in document order.
 */
function walkInfoboxTable($, $table, rows, linkTitles, depth, headings = []) {
  if (depth > 4) return;
  const trs = $table.find('> tbody > tr, > tr').toArray();

  for (let i = 0; i < trs.length; i++) {
    const $r = $(trs[i]);
    const $th = $r.children('th').first();
    const $tds = $r.children('td');

    // A row that only wraps a nested table is scaffolding — descend.
    const nested = $r.find('table').toArray();
    if (nested.length && !cleanText($, $th)) {
      for (const t of nested) walkInfoboxTable($, $(t), rows, linkTitles, depth + 1, headings);
      continue;
    }

    // "Capital<br>and largest city" flattens to "Capitaland largest city".
    const label = cleanText($, brSpaced($, $th));
    if (!label) {
      // Trailing unlabelled cell (e.g. "Total dead: …") annotates the row above.
      const solo = $tds.length === 1 ? cleanText($, $tds.first()) : '';
      if (solo && rows.length && solo.length < 400) rows[rows.length - 1].addenda.push(solo);
      continue;
    }
    if ($th.hasClass('summary') || $th.attr('colspan') && !$tds.length && i === 0) continue;

    let valueCells = $tds.toArray();
    if (!valueCells.length && trs[i + 1]) {
      const $next = $(trs[i + 1]);
      if (!$next.children('th').length) { valueCells = $next.children('td').toArray(); i++; }
    }
    // A labelled row with nothing to its right is a section heading, not a fact.
    // Country infoboxes lean on these ("Area", then "• Total", "• Water (%)"),
    // so the sub-rows below are unreadable without them. Kept in a separate
    // list: `rows` is what every existing archetype reads, and must not move.
    if (!valueCells.length) {
      if (label && label.length < 60) headings.push({ label, atRow: rows.length });
      continue;
    }

    const values = valueCells.map((td) => {
      const $td = $(td);
      const titles = [];
      $td.find('a[rel="mw:WikiLink"]').each((_, a) => {
        const t = decodeURIComponent(String($(a).attr('href') || '').replace(/^\.\//, '')).split('#')[0];
        if (t && !t.includes(':')) { titles.push(t); linkTitles.push(t); }
      });
      return { text: tidy(cleanText($, $td)), lines: cellLines($, $td).map(tidy).filter(Boolean), links: titles };
    });

    rows.push({ label, values, sided: values.length > 1, addenda: [] });
  }
}

/**
 * Infobox cells embed hCard/hCalendar microformats that Wikipedia hides with
 * CSS. Not every one carries a class we can target, so strip the residue:
 * bare ISO dates in parentheses, and the empty parens left behind.
 */
function tidy(s) {
  return String(s || '')
    .replace(/\(\s*\d{4}-\d{2}-\d{2}\s*\)/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Clone with line breaks turned into whitespace, so flattening a label does not
 * fuse words across them. Japan's is literally
 * `<th>Capital<div>and largest city</div></th>`, which reads out as
 * "Capitaland largest city".
 */
function brSpaced($, $node) {
  if (!$node || !$node.length) return $node;
  const $c = $node.clone();
  $c.find('br').replaceWith(' ');
  $c.find('div, p, li').each((_, el) => { $(el).before(' '); });
  return $c;
}

/** Break a cell into visual lines so "270,000 personnel / 500 tanks" survives. */
function cellLines($, $td) {
  const $c = $td.clone();
  $c.find('br').replaceWith('\n');
  $c.find('li, p, div, tr').each((_, el) => { $(el).append('\n'); });
  return cleanText($, $c, true)
    .split('\n')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

// ---- notes ---------------------------------------------------------------

function extractNotes($) {
  const notes = [];
  $('li[id^="cite_note"]').each((_, li) => {
    const $li = $(li);
    const $body = $li.find('.mw-reference-text, .reference-text').first();
    const $src = $body.length ? $body : $li;
    const $clone = $src.clone();
    $clone.find('style, script').remove();
    $clone.find('a').each((_, a) => {
      const $a = $(a);
      const href = $a.attr('href') || '';
      if (/^https?:|^\/\//.test(href)) $a.attr('target', '_blank').attr('rel', 'noopener noreferrer');
      else $a.replaceWith($a.text());
    });
    const text = $clone.text().replace(/\s+/g, ' ').trim();
    if (text) notes.push({ id: $li.attr('id'), html: ($clone.html() || '').trim(), text });
  });
  return notes;
}

// ---- helpers -------------------------------------------------------------

function bumpLink(map, title, flags) {
  const key = title.replace(/_/g, ' ');
  const cur = map.get(key) || { title: key, count: 0, infobox: false };
  cur.count++;
  if (flags.infobox) cur.infobox = true;
  map.set(key, cur);
}

function cleanText($, $node, keepNewlines = false) {
  if (!$node || !$node.length) return '';
  const $c = $node.clone();
  $c.find('style, script, .mw-editsection').remove();
  $c.find(REF_SEL).remove();
  const t = $c.text().replace(/ /g, ' ');
  return keepNewlines ? t.replace(/[ \t]+/g, ' ').trim() : t.replace(/\s+/g, ' ').trim();
}

// Wikimedia rejects arbitrary thumbnail widths with a 400 ("use thumbnail sizes
// listed on w.wiki/GHai"). Only these buckets are served. Asking for a bucket
// larger than the original is fine — it just returns the original.
const THUMB_BUCKETS = [120, 250, 330, 500, 960, 1280, 1920];

function snapWidth(want) {
  let best = THUMB_BUCKETS[0];
  for (const b of THUMB_BUCKETS) if (b <= want) best = b;
  return best;
}

/** Protocol-relative + tracking-param + bucket-snapped-width cleanup. */
export function normaliseImage(src, width) {
  if (!src) return null;
  let url = String(src).split('?')[0];
  if (url.startsWith('//')) url = 'https:' + url;
  if (!/^https?:/.test(url)) return null;
  if (width && url.includes('/thumb/')) url = url.replace(/\/\d+px-/, `/${snapWidth(width)}px-`);
  return url;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'section';
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
