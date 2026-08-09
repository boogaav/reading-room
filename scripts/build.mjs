import { buildBook } from '../src/book.js';
const title = process.argv[2] || 'Battle_of_Stalingrad';
const b = await buildBook(title, { force: process.argv.includes('--force') });
console.log('=== ', b.title, '|', b.archetype, '| rev', b.revid);
console.log('classPath:', b.classPath.join(' → ') || '(direct)');
console.log('stats:', JSON.stringify(b.stats));
console.log('blocks:', b.blocks.map(x => x.type).join(', '));
for (const bl of b.blocks) {
  if (bl.type === 'forces') {
    bl.sides.forEach(s => { console.log('  FORCES', s.name); s.phases.forEach(p => console.log('    phase', JSON.stringify(p.name), p.items.filter(i=>i.unit).map(i=>`${i.unit}=${i.value}`).join(' ')||'(untyped)')); });
  }
  if (bl.type === 'toll') { console.log('  TOLL total:', bl.total); bl.sides.forEach(s => console.log('   ', s.name, '→', JSON.stringify(s.headline))); }
  if (bl.type === 'cast') bl.groups.forEach(g => console.log('  CAST', g.name, '→', g.people.length, 'people:', g.people.slice(0,5).map(p=>p.label).join(', ')));
  if (bl.type === 'sides') bl.sides.forEach(s => console.log('  SIDE', s.name, '|', s.parties.join(', ')));
  if (bl.type === 'map') console.log('  MAP points:', bl.points.length, '| e.g.', bl.points.slice(0,5).map(p=>p.label).join(', '));
  if (bl.type === 'chronology') console.log('  CHRONO:', bl.events.length, 'window', JSON.stringify(bl.window), '| first:', bl.events[0]?.raw, '|', bl.events[0]?.sentence?.slice(0,70));
  if (bl.type === 'shelf') console.log('  SHELF:', bl.items.map(i=>i.label).join(', '));
  if (bl.type === 'cover') console.log('  COVER facts:', JSON.stringify(bl.facts), '| plates', bl.plates.length, '| art', (bl.image||'').split('/').pop());
  if (bl.type === 'identity') {
    console.log('  IDENTITY emblems:', bl.emblems.map(e=>e.kind).join(', ') || '—');
    bl.rows.forEach(r => console.log('    ', r.label, '=', r.value));
    if (bl.foundings.length) console.log('     foundings:', bl.foundings.map(f=>`${f.year}${f.of?` (${f.of})`:''}`).join(' · '));
    if (bl.formerCapitals.length) console.log('     former capitals:', bl.formerCapitals.map(f=>`${f.label} ${f.from}–${f.to??''}`).join(', '));
  }
  if (bl.type === 'lineage') {
    console.log('  LINEAGE', bl.nodes.length, 'nodes /', bl.edges.length, 'edges | truncated', JSON.stringify(bl.truncated));
    for (const lv of bl.levels) console.log('     col', lv, ':', bl.nodes.filter(n=>n.level===lv).map(n=>`${n.label} (${n.from??'?'}–${n.to??''})`).join(' · '));
  }
  if (bl.type === 'series') bl.series.forEach(s => console.log(`  SERIES ${s.key}: ${s.points.length} pts ${s.first.year}→${s.last.year} peak ${s.peak.year} | dropped ${s.dropped} | basis ${s.criterionLabel || 'single'}`));
  if (bl.type === 'rulers') bl.tracks.forEach(t => console.log(`  RULERS ${t.role}: ${t.dated.length} dated ${t.undated.length} undated | axis ${bl.from}–${bl.to} |`, t.dated.slice(-3).map(p=>`${p.label} ${p.from}–${p.to??'…'}`).join(', ')));
  if (bl.type === 'facts') console.log('  FACTS:', bl.rows.length, 'rows |', bl.rows.slice(0,6).map(r=>`${r.label}=${String(r.value).slice(0,24)}`).join(' | '));
}
if (b.archetype === 'country') {
  const parts = b.chapters.filter(c => c.level === 1).map(c => c.title);
  console.log('SPINE lvl-1 chapters:', parts.join(' · '));
}
