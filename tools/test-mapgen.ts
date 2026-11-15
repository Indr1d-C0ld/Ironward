// Verifica il generatore su molti seed: determinismo, connettività, porte valide,
// oggetti e nemici su celle libere, uscita raggiungibile.
// Uso: node tools/test-mapgen.ts [quanti] [--print seed]

import { generateLevel, TEX_EXIT, type Level } from '../shared/level.ts';
import type { GameMode } from '../shared/defs.ts';

const baseWalk: number[] = [];

function check(lvl: Level): string[] {
  const errs: string[] = [];
  const W = lvl.w;
  const at = (x: number, y: number) => y * W + x;
  // Bordo pieno.
  for (let i = 0; i < W; i++) {
    if (!lvl.walls[at(i, 0)] || !lvl.walls[at(i, W - 1)] || !lvl.walls[at(0, i)] || !lvl.walls[at(W - 1, i)]) { errs.push('bordo aperto'); break; }
  }
  // Raggiungibilità da spawns[0] attraversando tutte le porte (anche segrete).
  const seen = new Uint8Array(W * lvl.h);
  const s0 = lvl.spawns[0];
  if (!s0) return ['nessuno spawn'];
  const q = [at(Math.floor(s0.x), Math.floor(s0.y))];
  seen[q[0]] = 1;
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    for (const n of [c + 1, c - 1, c + W, c - W]) {
      if (!seen[n] && lvl.walls[n] === 0) { seen[n] = 1; q.push(n); }
    }
  }
  let floor = 0;
  for (let i = 0; i < lvl.walls.length; i++) if (lvl.walls[i] === 0) floor++;
  if (q.length !== floor) errs.push(`celle irraggiungibili: ${floor - q.length}`);
  for (const d of lvl.doors) {
    const ok = d.ew
      ? lvl.walls[at(d.x, d.y - 1)] && lvl.walls[at(d.x, d.y + 1)] && !lvl.walls[at(d.x - 1, d.y)] && !lvl.walls[at(d.x + 1, d.y)]
      : lvl.walls[at(d.x - 1, d.y)] && lvl.walls[at(d.x + 1, d.y)] && !lvl.walls[at(d.x, d.y - 1)] && !lvl.walls[at(d.x, d.y + 1)];
    if (!ok) errs.push(`porta ${d.id} (${d.x},${d.y}) senza stipiti corretti`);
  }
  const free = (x: number, y: number) => lvl.walls[at(Math.floor(x), Math.floor(y))] === 0 && lvl.doorAt[at(Math.floor(x), Math.floor(y))] < 0;
  for (const it of lvl.items) if (!free(it.x, it.y)) errs.push(`oggetto ${it.kind} su cella non libera`);
  for (const e of lvl.enemies) if (!free(e.x, e.y)) errs.push(`nemico ${e.kind} su cella non libera`);
  for (const s of lvl.spawns) if (!free(s.x, s.y)) errs.push('spawn su cella non libera');
  if (lvl.mode === 'coop') {
    if (!lvl.exit) errs.push('manca l’uscita');
    else {
      const { x, y } = lvl.exit;
      if (lvl.walls[at(x, y)] !== TEX_EXIT) errs.push('uscita senza texture');
      if (![at(x + 1, y), at(x - 1, y), at(x, y + 1), at(x, y - 1)].some((n) => seen[n])) errs.push('uscita irraggiungibile');
    }
    if (lvl.spawns.length < 4) errs.push(`solo ${lvl.spawns.length} spawn coop`);
  } else if (lvl.spawns.length < 8) errs.push(`solo ${lvl.spawns.length} spawn ${lvl.mode}`);
  if (lvl.mode === 'tdm' || lvl.mode === 'ctf') {
    if (lvl.bases.length !== 2) errs.push('servono due basi');
    for (const b of lvl.bases) if (!free(b.x, b.y) || !seen[at(Math.floor(b.x), Math.floor(b.y))]) errs.push('base non raggiungibile');
    if (lvl.bases.length === 2 && Math.hypot(lvl.bases[0].x - lvl.bases[1].x, lvl.bases[0].y - lvl.bases[1].y) < 12) errs.push('basi troppo vicine');
    for (const ts of lvl.teamSpawns) {
      if (ts.length < 4) errs.push(`solo ${ts.length} spawn di squadra`);
      for (const sp of ts) if (!free(sp.x, sp.y)) errs.push('spawn di squadra su cella non libera');
    }
    // Simmetria centrale: ogni cella, porta, oggetto, base e spawn ha il gemello ruotato di 180°.
    const H = lvl.h;
    const rot = (i: number) => at(W - 1 - (i % W), H - 1 - Math.floor(i / W));
    let asym = 0;
    for (let i = 0; i < lvl.walls.length; i++) {
      const j = rot(i);
      if (lvl.walls[i] !== lvl.walls[j] || (lvl.doorAt[i] < 0) !== (lvl.doorAt[j] < 0)) asym++;
      else if (lvl.doorAt[i] >= 0) {
        const a = lvl.doors[lvl.doorAt[i]], b = lvl.doors[lvl.doorAt[j]];
        if (a.ew !== b.ew || a.secret !== b.secret || a.tex !== b.tex) asym++;
      }
    }
    if (asym) errs.push(`${asym} celle non simmetriche`);
    const key = (k: string, x: number, y: number) => `${k}@${x.toFixed(2)},${y.toFixed(2)}`;
    const itemSet = new Set(lvl.items.map((it) => key(it.kind, it.x, it.y)));
    if (lvl.items.some((it) => !itemSet.has(key(it.kind, W - it.x, H - it.y)))) errs.push('oggetti non simmetrici');
    const [b0, b1] = lvl.bases;
    if (b0 && b1 && (Math.abs(b0.x + b1.x - W) > 1e-9 || Math.abs(b0.y + b1.y - H) > 1e-9)) errs.push('basi non simmetriche');
    const [t0, t1] = lvl.teamSpawns;
    if (!t0 || !t1 || t0.length !== t1.length || t0.some((s, i) => Math.abs(s.x + t1[i].x - W) > 1e-9 || Math.abs(s.y + t1[i].y - H) > 1e-9)) errs.push('spawn di squadra non simmetrici');
    // Le basi devono comunicare senza passare da pareti segrete.
    if (b0 && b1) {
      const d = new Int32Array(W * H).fill(-1);
      const s = at(Math.floor(b0.x), Math.floor(b0.y));
      const qq = [s];
      d[s] = 0;
      for (let h = 0; h < qq.length; h++) {
        const c = qq[h];
        for (const n of [c + 1, c - 1, c + W, c - W]) {
          if (d[n] < 0 && lvl.walls[n] === 0 && (lvl.doorAt[n] < 0 || !lvl.doors[lvl.doorAt[n]].secret)) { d[n] = d[c] + 1; qq.push(n); }
        }
      }
      const walk = d[at(Math.floor(b1.x), Math.floor(b1.y))];
      if (walk < 0) errs.push('basi collegate solo da passaggi segreti');
      else baseWalk.push(walk);
    }
  }
  return errs;
}

function print(lvl: Level): void {
  const W = lvl.w;
  const lines: string[] = [];
  for (let y = 0; y < lvl.h; y++) {
    let s = '';
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = lvl.doorAt[i];
      if (d >= 0) s += lvl.doors[d].secret ? 'S' : lvl.doors[d].ew ? '|' : '-';
      else if (lvl.walls[i] === TEX_EXIT) s += 'X';
      else if (lvl.walls[i]) s += '#';
      else if (lvl.spawns.some((p) => Math.floor(p.x) === x && Math.floor(p.y) === y)) s += '@';
      else if (lvl.enemies.some((p) => Math.floor(p.x) === x && Math.floor(p.y) === y)) s += 'e';
      else if (lvl.items.some((p) => Math.floor(p.x) === x && Math.floor(p.y) === y)) s += '*';
      else s += '.';
    }
    lines.push(s);
  }
  console.log(lines.join('\n'));
}

const args = process.argv.slice(2);
if (args[0] === '--print') {
  const lvl = generateLevel(Number(args[1] ?? 1), (args[2] as GameMode) ?? 'coop');
  print(lvl);
  console.log(`rooms=${lvl.rooms.length} doors=${lvl.doors.length} enemies=${lvl.enemies.length} items=${lvl.items.length}`);
  process.exit(0);
}

const N = Number(args[0] ?? 300);
let failures = 0;
const t0 = performance.now();
for (const mode of ['coop', 'dm', 'tdm', 'ctf'] as GameMode[]) {
  let rooms = 0, doors = 0, secrets = 0, enemies = 0;
  for (let seed = 1; seed <= N; seed++) {
    const a = generateLevel(seed * 7919, mode);
    const b = generateLevel(seed * 7919, mode);
    const errs = check(a);
    if (Buffer.compare(Buffer.from(a.walls), Buffer.from(b.walls)) !== 0 || a.items.length !== b.items.length) errs.push('non deterministico');
    if (errs.length) { failures++; if (failures <= 10) console.log(`[${mode}] seed ${seed * 7919}: ${errs.join('; ')}`); }
    rooms += a.rooms.length; doors += a.doors.filter((d) => !d.secret).length; secrets += a.doors.filter((d) => d.secret).length; enemies += a.enemies.length;
  }
  const bw = baseWalk.splice(0).sort((x, y) => x - y);
  const walkInfo = bw.length ? `, percorso tra le basi ${bw[0]}–${bw[bw.length - 1]} (mediana ${bw[bw.length >> 1]})` : '';
  console.log(`${mode}: ${N} livelli, medie: stanze ${(rooms / N).toFixed(1)}, porte ${(doors / N).toFixed(1)}, segreti ${(secrets / N).toFixed(1)}, nemici ${(enemies / N).toFixed(1)}${walkInfo}`);
}
console.log(`${failures === 0 ? 'OK' : 'FALLITO'}: ${failures} livelli con errori (${(performance.now() - t0).toFixed(0)} ms)`);
process.exit(failures ? 1 : 0);
