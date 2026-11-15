// Costruisce l'atlante degli sprite dai file PixelLab in assets/pixellab/:
//   characters/<chiave>/   ZIP del personaggio estratto (rotations/ e animations/)
//   items/<nome>.png       oggetti a una direzione
//   base.png               stendardo delle basi (verde chiave, ricolorato in gioco)
//   weapons/weapon<N>.png  armi in prima persona (240x150)
// Produce client/sprites/atlas.png, atlas.json e le armi. Uso: node tools/build-sprites.ts

import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPng, writePng, type RGBAImage } from './png.ts';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SRC = join(ROOT, 'assets/pixellab');
const OUT = join(ROOT, 'client/sprites');
const CELL = 128;

/** Vista del motore (0 = di fronte, 2 = fianco sinistro...) -> direzione PixelLab. */
const DIRS = ['south', 'south-west', 'west', 'north-west', 'north', 'north-east', 'east', 'south-east'];

/**
 * Pose del motore -> fotogramma PixelLab: rotazione oppure [animazione, fotogramma].
 * Un fotogramma negativo conta dalla fine.
 */
type Src = 'rotation' | [anim: string, frame: number | 'aim' | 'fire' | 'pain'];
interface CharSpec { key: string; dir: string; poses: Record<string, Src>; dead: [anim: string, frame: number] }
const HUMAN: Record<string, Src> = {
  stand: 'rotation', walk1: ['walk3', 1], walk2: ['walk3', 3], aim: ['shoot8', 'aim'], fire: ['shoot8', 'fire'], pain: ['pain3', 'pain'],
};
const CHARS: CharSpec[] = [
  { key: 'guard', dir: 'guard', poses: HUMAN, dead: ['death', -1] },
  { key: 'trooper', dir: 'trooper', poses: HUMAN, dead: ['death', -1] },
  { key: 'officer', dir: 'officer', poses: HUMAN, dead: ['death', -1] },
  ...[0, 1, 2, 3, 4].map((h) => ({ key: `player${h}`, dir: `player${h}`, poses: HUMAN, dead: ['death', -1] as [string, number] })),
  { key: 'hound', dir: 'hound', poses: { stand: 'rotation', walk1: ['walk', 1], walk2: ['walk', 3], aim: ['bite', 1], fire: ['bite', 2], pain: ['pain3', 'pain'] }, dead: ['death', -1] },
];

const ITEMS: Record<string, string> = {
  'item:medkit': 'medkit', 'item:food': 'food', 'item:ammo': 'ammo', 'item:clip': 'clip', 'item:smg': 'smg',
  'item:chaingun': 'chaingun', 'item:coins': 'coins', 'item:gem': 'gem', flag: 'briefcase',
  'item:vest': 'vest', 'item:grenade': 'grenade', 'item:key': 'keycard',
};

// ------------------------------------------------------------------ utilità sulle immagini

function bbox(img: RGBAImage): { x0: number; y0: number; x1: number; y1: number } | null {
  let x0 = img.w, y0 = img.h, x1 = -1, y1 = -1;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    if (img.px[(y * img.w + x) * 4 + 3] < 128) continue;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/** Copia `img` in una cella con lo spostamento dato; i pixel fuori cella si perdono. */
function place(img: RGBAImage, dx: number, dy: number): RGBAImage {
  const out = { w: CELL, h: CELL, px: new Uint8Array(CELL * CELL * 4) };
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const X = x + dx, Y = y + dy;
    if (X < 0 || Y < 0 || X >= CELL || Y >= CELL) continue;
    const s = (y * img.w + x) * 4;
    // i bordi semitrasparenti di alcune animazioni diventerebbero aloni grigi
    if (img.px[s + 3] < 200) continue;
    const d = (Y * CELL + X) * 4;
    out.px[d] = img.px[s]; out.px[d + 1] = img.px[s + 1]; out.px[d + 2] = img.px[s + 2]; out.px[d + 3] = 255;
  }
  return out;
}

/** Riduce in scala (vicino più prossimo) se l'immagine non entra nella cella. */
function fit(img: RGBAImage, maxW: number, maxH: number): RGBAImage {
  const b = bbox(img);
  if (!b) return img;
  const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
  const s = Math.min(1, maxW / bw, maxH / bh);
  if (s >= 1) return img;
  const w = Math.round(img.w * s), h = Math.round(img.h * s);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const si = (Math.floor(y / s) * img.w + Math.floor(x / s)) * 4, di = (y * w + x) * 4;
    px[di] = img.px[si]; px[di + 1] = img.px[si + 1]; px[di + 2] = img.px[si + 2]; px[di + 3] = img.px[si + 3];
  }
  return { w, h, px };
}

// ------------------------------------------------------------------ personaggi

function stateDir(charDir: string): string {
  const base = join(SRC, 'characters', charDir);
  const sub = readdirSync(base, { withFileTypes: true }).find((d) => d.isDirectory());
  if (!sub) throw new Error(`${charDir}: nessuno stato nello ZIP`);
  return join(base, sub.name);
}

/** Fotogrammi di un'animazione in una direzione, cercando la cartella per nome. */
function animFrames(state: string, anim: string, dir: string): string[] {
  const root = join(state, 'animations');
  if (!existsSync(root)) return [];
  const names = readdirSync(root);
  const name = names.find((n) => n === anim) ?? names.find((n) => n.toLowerCase().startsWith(anim.toLowerCase()));
  if (!name) return [];
  const d = join(root, name, dir);
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.png')).sort().map((f) => join(d, f));
}

/** Pixel gialli e chiari (vampa) in un fotogramma. */
function flashPixels(img: RGBAImage): number {
  let n = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const o = i * 4;
    if (img.px[o + 3] >= 128 && img.px[o] > 220 && img.px[o + 1] > 170 && img.px[o + 2] < 160) n++;
  }
  return n;
}

/** Sceglie il fotogramma di fuoco (più vampa rispetto al primo) e quello di mira (il precedente). */
function shotFrames(frames: string[]): { aim: number; fire: number } {
  const counts = frames.map((f) => flashPixels(readPng(f)));
  let fire = Math.min(2, frames.length - 1), best = 30;
  for (let i = 1; i < counts.length; i++) if (counts[i] - counts[0] > best) { best = counts[i] - counts[0]; fire = i; }
  return { aim: Math.max(1, fire - 1), fire };
}

/**
 * Fotogramma di dolore: il primo tra 2, 3 e 1 senza lampi e con la figura ancora in piedi
 * (alta almeno l'80% della posa ferma); altrimenti il primo.
 */
function painFrame(frames: string[], standH: number): number {
  for (const i of [2, 3, 1]) {
    if (i >= frames.length) continue;
    const img = readPng(frames[i]);
    const b = bbox(img);
    if (b && b.y1 - b.y0 + 1 >= standH * 0.8 && flashPixels(img) < 40 && !hasGlow(img)) return i;
  }
  return Math.min(1, frames.length - 1);
}

/** Pixel azzurri molto chiari: scie e bagliori spuri delle animazioni. */
function hasGlow(img: RGBAImage): boolean {
  let n = 0;
  for (let i = 0; i < img.w * img.h; i++) {
    const o = i * 4;
    if (img.px[o + 3] >= 128 && img.px[o + 2] > 200 && img.px[o + 1] > 180 && img.px[o] < 140) n++;
  }
  return n > 12;
}

/** Tiene solo il pezzo più grande e quelli di almeno il 4% della sua area (via scie e schegge). */
function dropSpecks(img: RGBAImage): RGBAImage {
  const { w, h, px } = img;
  const label = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (label[i] >= 0 || px[i * 4 + 3] < 128) continue;
    const id = sizes.length;
    let n = 0;
    const st = [i];
    label[i] = id;
    while (st.length) {
      const c = st.pop()!, x = c % w, y = (c / w) | 0;
      n++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const j = Y * w + X;
        if (label[j] < 0 && px[j * 4 + 3] >= 128) { label[j] = id; st.push(j); }
      }
    }
    sizes.push(n);
  }
  const big = Math.max(0, ...sizes);
  const out = new Uint8Array(px);
  for (let i = 0; i < w * h; i++) if (label[i] >= 0 && sizes[label[i]] < big * 0.04) out[i * 4 + 3] = 0;
  return { w, h, px: out };
}

/** Toglie a strati i pixel grigio chiaro sul bordo della sagoma (alone di alcune animazioni). */
function stripHalo(img: RGBAImage, passes = 4): RGBAImage {
  const { w, h } = img;
  const px = new Uint8Array(img.px);
  const opaque = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && px[(y * w + x) * 4 + 3] >= 128;
  for (let p = 0; p < passes; p++) {
    const kill: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (px[o + 3] < 128) continue;
      const r = px[o], g = px[o + 1], b = px[o + 2];
      const grey = Math.max(r, g, b) - Math.min(r, g, b) < 28 && Math.min(r, g, b) > 120;
      if (grey && (!opaque(x - 1, y) || !opaque(x + 1, y) || !opaque(x, y - 1) || !opaque(x, y + 1))) kill.push(o);
    }
    if (!kill.length) break;
    for (const o of kill) px[o + 3] = 0;
  }
  return { w, h, px };
}

const cells: { key: string; img: RGBAImage }[] = [];
const missing: string[] = [];

for (const c of CHARS) {
  if (!existsSync(join(SRC, 'characters', c.dir))) { missing.push(`${c.key} (intero personaggio)`); continue; }
  const state = stateDir(c.dir);
  const rot = (dir: string) => readPng(join(state, 'rotations', `${dir}.png`));
  // piedi della figura di fronte: la stessa quota per tutte le pose
  const south = rot('south');
  const foot = bbox(south)!.y1;
  const dy = CELL - 1 - foot;
  for (let v = 0; v < 8; v++) {
    const dir = DIRS[v];
    for (const [pose, src] of Object.entries(c.poses)) {
      let img: RGBAImage | null = null;
      if (src === 'rotation') img = rot(dir);
      else {
        const frames = animFrames(state, src[0], dir);
        const fr = src[1];
        const standB = bbox(rot(dir));
        const idx = typeof fr === 'number' ? (fr < 0 ? frames.length + fr : Math.min(fr, frames.length - 1))
          : !frames.length ? -1
          : fr === 'pain' ? painFrame(frames, standB ? standB.y1 - standB.y0 + 1 : 100)
          : shotFrames(frames)[fr];
        const f = frames[idx];
        // negli spari la vampa può essere staccata dall'arma: lì non si tolgono i frammenti
        if (f) img = fr === 'aim' || fr === 'fire' ? readPng(f) : dropSpecks(readPng(f));
        if (img && c.key === 'hound') img = stripHalo(img);
      }
      if (!img) { missing.push(`${c.key}:${pose}:${v}`); continue; }
      // le animazioni hanno una tela più grande ma lo stesso centro della rotazione
      cells.push({ key: `${c.key}:${pose}:${v}`, img: place(img, Math.round((CELL - img.w) / 2), Math.round((south.h - img.h) / 2) + dy) });
    }
  }
  // a terra: ultimo fotogramma della caduta vista di fronte, appoggiato al pavimento
  const df = animFrames(state, c.dead[0], 'south');
  const dead = df[c.dead[1] < 0 ? df.length + c.dead[1] : c.dead[1]];
  if (dead) {
    const img = fit(readPng(dead), CELL - 2, CELL - 2);
    const b = bbox(img)!;
    cells.push({ key: `${c.key}:dead`, img: place(img, Math.round(CELL / 2 - (b.x0 + b.x1) / 2), CELL - 1 - b.y1) });
  } else missing.push(`${c.key}:dead`);
}

// ------------------------------------------------------------------ oggetti, basi, valigette

const itemImg = (file: string) => readPng(join(SRC, 'items', `${file}.png`));
for (const [key, file] of Object.entries(ITEMS)) {
  if (!existsSync(join(SRC, 'items', `${file}.png`))) { missing.push(key); continue; }
  const img = itemImg(file);
  const b = bbox(img)!;
  // appoggiati al pavimento, al centro della cella
  cells.push({ key, img: place(img, Math.round(CELL / 2 - (b.x0 + b.x1) / 2), CELL - 1 - b.y1) });
  if (key === 'flag') {
    // valigetta portata: sopra la testa di chi la porta
    cells.push({ key: 'flagc', img: place(img, Math.round(CELL / 2 - (b.x0 + b.x1) / 2), 1 - b.y0) });
  }
}
// granata in volo: più piccola, all'altezza dei fianchi
if (existsSync(join(SRC, 'items', 'grenade.png'))) {
  const g = readPng(join(SRC, 'items', 'grenade.png'));
  const half: RGBAImage = { w: g.w >> 1, h: g.h >> 1, px: new Uint8Array((g.w >> 1) * (g.h >> 1) * 4) };
  for (let y = 0; y < half.h; y++) for (let x = 0; x < half.w; x++) half.px.set(g.px.subarray(((y * 2) * g.w + x * 2) * 4, ((y * 2) * g.w + x * 2) * 4 + 4), (y * half.w + x) * 4);
  const b = bbox(half)!;
  cells.push({ key: 'proj:grenade', img: place(half, Math.round(CELL / 2 - (b.x0 + b.x1) / 2), 92 - b.y1) });
}
// esplosione: 4 fasi da 64 px ingrandite a 128, centrate poco sopra il pavimento
for (let f = 0; f < 4; f++) {
  const file = join(SRC, 'fx', `boom${f}.png`);
  if (!existsSync(file)) { missing.push(`fx:boom${f}`); continue; }
  const src = readPng(file);
  const big: RGBAImage = { w: src.w * 2, h: src.h * 2, px: new Uint8Array(src.w * src.h * 16) };
  for (let y = 0; y < big.h; y++) for (let x = 0; x < big.w; x++) big.px.set(src.px.subarray(((y >> 1) * src.w + (x >> 1)) * 4, ((y >> 1) * src.w + (x >> 1)) * 4 + 4), (y * big.w + x) * 4);
  const b = bbox(big)!;
  cells.push({ key: `fx:boom${f}`, img: place(big, Math.round(CELL / 2 - (b.x0 + b.x1) / 2), Math.round(84 - (b.y0 + b.y1) / 2)) });
}

if (existsSync(join(SRC, 'base.png'))) {
  const img = fit(readPng(join(SRC, 'base.png')), CELL - 4, CELL - 2);
  const b = bbox(img)!;
  cells.push({ key: 'base', img: place(img, Math.round(CELL / 2 - (b.x0 + b.x1) / 2), CELL - 1 - b.y1) });
} else missing.push('base');

// ------------------------------------------------------------------ atlante

const cols = Math.ceil(Math.sqrt(cells.length));
const rows = Math.ceil(cells.length / cols);
const sheet: RGBAImage = { w: cols * CELL, h: rows * CELL, px: new Uint8Array(cols * CELL * rows * CELL * 4) };
const entries: Record<string, number> = {};
cells.forEach((c, i) => {
  entries[c.key] = i;
  const ox = (i % cols) * CELL, oy = Math.floor(i / cols) * CELL;
  for (let y = 0; y < CELL; y++) sheet.px.set(c.img.px.subarray(y * CELL * 4, (y + 1) * CELL * 4), ((oy + y) * sheet.w + ox) * 4);
});
mkdirSync(OUT, { recursive: true });
writePng(join(OUT, 'atlas.png'), sheet);

// armi in prima persona: bocca = pixel opaco più alto nella fascia centrale (20–80% della larghezza)
const weapons: string[] = [], muzzle: number[] = [], muzzleX: number[] = [];
for (let w = 0; w < 4; w++) {
  const f = join(SRC, 'weapons', `weapon${w}.png`);
  if (!existsSync(f)) { missing.push(`weapon${w}`); continue; }
  const img = readPng(f);
  let top = img.h, tx = img.w / 2;
  for (let y = 0; y < img.h && top === img.h; y++) {
    for (let x = Math.floor(img.w * 0.2); x < img.w * 0.8; x++) if (img.px[(y * img.w + x) * 4 + 3] >= 128) { top = y; tx = x; break; }
  }
  copyFileSync(f, join(OUT, `weapon${w}.png`));
  weapons.push(`weapon${w}.png`);
  muzzle.push(top - img.h);
  muzzleX.push(Math.round(tx - img.w / 2));
}
// pareti: una striscia di texture 64x64, nell'ordine degli indici TEX_* del livello
const walls: number[] = [];
const wallDir = join(SRC, 'walls');
if (existsSync(wallDir)) {
  for (const f of readdirSync(wallDir).sort()) {
    const m = /^tex(\d+)\.png$/.exec(f);
    if (m) walls.push(Number(m[1]));
  }
  walls.sort((a, b) => a - b);
  const strip: RGBAImage = { w: walls.length * 64, h: 64, px: new Uint8Array(walls.length * 64 * 64 * 4) };
  walls.forEach((t, i) => {
    const img = readPng(join(wallDir, `tex${t}.png`));
    for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) {
      const si = ((y % img.h) * img.w + (x % img.w)) * 4, di = (y * strip.w + i * 64 + x) * 4;
      strip.px[di] = img.px[si]; strip.px[di + 1] = img.px[si + 1]; strip.px[di + 2] = img.px[si + 2]; strip.px[di + 3] = 255;
    }
  });
  writePng(join(OUT, 'walls.png'), strip);
}
writeFileSync(join(OUT, 'atlas.json'), JSON.stringify({ cell: CELL, cols, entries, weapons: weapons.length === 4 ? weapons : [], muzzle, muzzleX, walls }, null, 1));

console.log(`atlante: ${cells.length} celle (${sheet.w}x${sheet.h}), armi: ${weapons.length}, pareti: ${walls.length}`);
if (missing.length) console.log(`mancanti (restano procedurali): ${missing.length}\n  ${missing.slice(0, 30).join(', ')}${missing.length > 30 ? ' …' : ''}`);
