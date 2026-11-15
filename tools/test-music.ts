// Test della musica procedurale: brani deterministici, diversi per seed e tema, ben formati.
// Uso: node tools/test-music.ts

import { composeSong } from '../client/music.ts';

let failed = 0;
const ok = (cond: boolean, what: string) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${what}`); if (!cond) failed++; };

const a = composeSong(12345, 0), b = composeSong(12345, 0), c = composeSong(54321, 0), d = composeSong(12345, 2);
ok(JSON.stringify(a) === JSON.stringify(b), 'stesso seed e tema: stesso brano');
ok(JSON.stringify(a.lead) !== JSON.stringify(c.lead), 'seed diverso: melodia diversa');
ok(a.style.name === 'Fortezza' && d.style.name === 'Archivio' && d.style.bpm < a.style.bpm, 'il tema sceglie carattere e tempo');
let good = true;
for (let seed = 1; seed <= 200; seed++) {
  for (let theme = 0; theme < 4; theme++) {
    const s = composeSong(seed * 7919, theme);
    const notes = s.lead.filter((n) => n >= 0);
    if (s.lead.length !== 128 || notes.length < 16 || notes.some((n) => n < 40 || n > 100)) good = false;
    if (s.bass.filter((n) => n >= 0).length < 16 || !s.drums.some((x) => x & 1)) good = false;
    if (s.lead[0] === -2) good = false;
  }
}
ok(good, '800 brani: 8 battute, melodia nel registro giusto, basso e cassa presenti');

console.log(failed ? `FALLITO: ${failed} controlli` : 'OK: tutti i controlli superati');
process.exit(failed ? 1 : 0);
