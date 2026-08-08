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
  if (bl.type === 'cover') console.log('  COVER facts:', JSON.stringify(bl.facts), '| plates', bl.plates.length);
}
