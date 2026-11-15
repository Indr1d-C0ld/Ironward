// Grafica interamente procedurale in stile VGA: texture 64x64 delle pareti,
// sprite 128x128 di nemici, giocatori e oggetti, armi in prima persona.
// Niente asset esterni. Tutto è salvato come indici della palette a 256 colori
// (palette.ts), per colonne: indice = x * altezza + y. L'indice 0 è trasparente.

import {
  TEX_BRICK, TEX_BRICK_DARK, TEX_CONCRETE, TEX_CONCRETE_STRIPE, TEX_COUNT, TEX_DOOR, TEX_DOOR_JAMB, TEX_EXIT,
  TEX_METAL, TEX_METAL_RIVET, TEX_STONE, TEX_STONE_MOSS, TEX_TILE, TEX_TILE_GRIME, TEX_WOOD, TEX_WOOD_PANEL,
} from '../shared/level.ts';
import { PLAYER_COLORS, TEAMS } from '../shared/defs.ts';
import { dithered, indexedToCanvas, Paint, type Mat, type RGB } from './palette.ts';

/** lato delle texture delle pareti */
export const TS = 64;
/** lato degli sprite */
export const SS = 128;

const pack = (r: number, g: number, b: number, a = 255) =>
  ((a << 24) | (clampByte(b) << 16) | (clampByte(g) << 8) | clampByte(r)) >>> 0;
const clampByte = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);
const shade = (c: RGB, k: number): RGB => [c[0] * k, c[1] * k, c[2] * k];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function hash(x: number, y: number, s: number): number {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise che si ripete ogni 64 pixel. */
function noise(x: number, y: number, scale: number, s: number): number {
  const p = TS / scale;
  const fx = x / scale, fy = y / scale;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const tx = fx - x0, ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const h = (a: number, b: number) => hash(((a % p) + p) % p, ((b % p) + p) % p, s);
  const a = h(x0, y0) + (h(x0 + 1, y0) - h(x0, y0)) * sx;
  const b = h(x0, y0 + 1) + (h(x0 + 1, y0 + 1) - h(x0, y0 + 1)) * sx;
  return a + (b - a) * sy;
}

const fbm = (x: number, y: number, s: number) =>
  noise(x, y, 16, s) * 0.5 + noise(x, y, 8, s + 1) * 0.3 + noise(x, y, 4, s + 2) * 0.2;

/** Tela di pixel in righe, convertita alla fine nel formato a colonne. */
class Pix {
  d = new Uint32Array(TS * TS);
  set(x: number, y: number, c: RGB, a = 255): void {
    if (x < 0 || y < 0 || x >= TS || y >= TS) return;
    this.d[y * TS + x] = pack(c[0], c[1], c[2], a);
  }
  rect(x: number, y: number, w: number, h: number, c: RGB): void {
    for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c);
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
    for (let j = Math.floor(cy - ry); j <= cy + ry; j++) {
      for (let i = Math.floor(cx - rx); i <= cx + rx; i++) {
        const u = (i + 0.5 - cx) / rx, v = (j + 0.5 - cy) / ry;
        if (u * u + v * v <= 1) this.set(i, j, c);
      }
    }
  }
  fill(f: (x: number, y: number) => RGB): this {
    for (let y = 0; y < TS; y++) for (let x = 0; x < TS; x++) this.set(x, y, f(x, y));
    return this;
  }
  /** Indici di palette per colonne, con un leggero dithering. */
  columns(): Uint8Array {
    const out = new Uint8Array(TS * TS);
    for (let y = 0; y < TS; y++) {
      for (let x = 0; x < TS; x++) {
        const c = this.d[y * TS + x];
        out[x * TS + y] = dithered(c & 255, (c >>> 8) & 255, (c >>> 16) & 255, x, y, 3);
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ pareti

function blocks(x: number, y: number, bw: number, bh: number, seed: number, mortar: number) {
  const row = Math.floor(y / bh);
  const off = (row % 2) * (bw >> 1);
  const xx = (x + off) % TS;
  const col = Math.floor(xx / bw);
  const edge = xx % bw < mortar || y % bh < mortar;
  return { edge, tone: hash(col, row, seed), row, col, lx: xx % bw, ly: y % bh };
}

function stone(seed: number, moss: boolean): Pix {
  const base: RGB = [118, 116, 108];
  return new Pix().fill((x, y) => {
    const b = blocks(x, y, 21, 16, seed, 2);
    if (b.edge) return shade(base, 0.45);
    let c = shade(base, 0.72 + b.tone * 0.38 + (fbm(x, y, seed) - 0.5) * 0.35);
    if (b.lx === 2 || b.ly === 2) c = shade(c, 1.15);
    if (moss) {
      const m = fbm(x * 1.3, y, seed + 9) + (y / TS) * 0.35;
      if (m > 0.72) c = mix(c, [60, 96, 44], Math.min(1, (m - 0.72) * 4));
    }
    return c;
  });
}

function brick(seed: number, base: RGB): Pix {
  return new Pix().fill((x, y) => {
    const b = blocks(x, y, 16, 8, seed, 1);
    if (b.edge) return [70, 66, 60];
    return shade(base, 0.75 + b.tone * 0.35 + (noise(x, y, 4, seed) - 0.5) * 0.25);
  });
}

function concrete(seed: number, stripe: boolean): Pix {
  return new Pix().fill((x, y) => {
    let c: RGB = shade([132, 134, 128], 0.8 + fbm(x, y, seed) * 0.35);
    if (x % 32 === 0 || y % 32 === 0) c = shade(c, 0.6);
    if (hash(x, y, seed + 3) > 0.985) c = shade(c, 0.7);
    if (stripe && y >= 40 && y < 50) c = ((x + y) >> 3) % 2 ? [40, 38, 34] : [214, 170, 40];
    if (stripe && (y === 39 || y === 50)) c = [60, 58, 54];
    return c;
  });
}

function wood(seed: number, panel: boolean): Pix {
  return new Pix().fill((x, y) => {
    const plank = Math.floor(x / 8);
    const grain = Math.sin((y + hash(plank, 0, seed) * 64) * 0.35 + noise(x, y, 8, seed) * 6) * 0.5 + 0.5;
    let c: RGB = shade([132, 86, 48], 0.7 + grain * 0.25 + hash(plank, 1, seed) * 0.15);
    if (x % 8 === 0) c = shade(c, 0.55);
    if (panel) {
      if (y < 24) return shade([176, 160, 128], 0.85 + fbm(x, y, seed) * 0.2);
      if (y === 24 || y === 25) return [92, 58, 30];
      const inPanel = x % 32 > 4 && x % 32 < 28 && y > 30 && y < 58;
      if (inPanel) c = shade(c, 1.12);
      if ((x % 32 === 4 || x % 32 === 28) && y > 30 && y < 58) c = shade(c, 0.6);
      if ((y === 30 || y === 58) && x % 32 > 4 && x % 32 < 28) c = shade(c, 0.6);
    }
    return c;
  });
}

function metal(seed: number, rivets: boolean): Pix {
  return new Pix().fill((x, y) => {
    let c: RGB = shade([96, 108, 120], 0.8 + fbm(x, y, seed) * 0.25 + (y % 32) / 160);
    if (x % 32 === 0 || y % 32 === 0) c = [44, 50, 58];
    if (x % 32 === 1 || y % 32 === 1) c = shade(c, 1.25);
    if (rivets) {
      const rx = x % 32, ry = y % 32;
      for (const [px, py] of [[5, 5], [26, 5], [5, 26], [26, 26]]) {
        const d = (rx - px) ** 2 + (ry - py) ** 2;
        if (d <= 3) c = d <= 1 ? [190, 196, 204] : [60, 66, 74];
      }
    }
    return c;
  });
}

function tile(seed: number, grime: boolean): Pix {
  return new Pix().fill((x, y) => {
    if (x % 16 === 0 || y % 16 === 0) return [96, 104, 100];
    const t = hash(x >> 4, y >> 4, seed);
    let c: RGB = hash((x >> 4) * 7 + 3, (y >> 4) * 13 + 5, seed + 17) > 0.8 ? [120, 178, 170] : shade([206, 214, 208], 0.9 + t * 0.12);
    if (grime) {
      const g = fbm(x, y * 0.7, seed + 5) + (y / TS) * 0.4;
      if (g > 0.68) c = mix(c, [74, 70, 52], Math.min(0.85, (g - 0.68) * 3));
    }
    return c;
  });
}

function exitPanel(): Pix {
  const p = metal(77, true);
  p.rect(14, 10, 36, 44, [36, 40, 46]);
  p.rect(16, 12, 32, 40, [58, 66, 72]);
  // freccia verde verso l'alto
  for (let y = 0; y < 12; y++) p.rect(32 - y, 16 + y, y * 2, 1, [70, 200, 90]);
  p.rect(27, 28, 10, 10, [70, 200, 90]);
  // leva
  p.rect(30, 40, 4, 10, [160, 160, 170]);
  p.ellipse(32, 40, 4, 4, [210, 50, 40]);
  return p;
}

function door(): Pix {
  return new Pix().fill((x, y) => {
    let c: RGB = shade([148, 92, 50], 0.85 + fbm(x, y, 41) * 0.25);
    if (y % 12 === 0) c = shade(c, 0.6);
    if (y % 12 === 1) c = shade(c, 1.2);
    if (x < 3 || x > 60) c = [60, 44, 34];
    if (y > 54) c = ((x + y) >> 2) % 2 ? [36, 34, 30] : [222, 180, 40];
    if (x >= 50 && x <= 54 && y >= 26 && y <= 34) c = [210, 210, 200];
    return c;
  });
}

function jamb(): Pix {
  return new Pix().fill((x, y) => {
    let c: RGB = shade([70, 72, 78], 0.85 + noise(x, y, 4, 13) * 0.2);
    if (x % 16 < 2) c = [40, 42, 46];
    if (y % 16 === 8 && x % 16 > 6 && x % 16 < 10) c = [150, 150, 160];
    return c;
  });
}

export function buildTextures(): Uint8Array[] {
  const t: Uint8Array[] = new Array(TEX_COUNT);
  t[0] = new Uint8Array(TS * TS);
  t[TEX_STONE] = stone(1, false).columns();
  t[TEX_STONE_MOSS] = stone(1, true).columns();
  t[TEX_CONCRETE] = concrete(3, false).columns();
  t[TEX_CONCRETE_STRIPE] = concrete(3, true).columns();
  t[TEX_WOOD] = wood(5, false).columns();
  t[TEX_WOOD_PANEL] = wood(5, true).columns();
  t[TEX_METAL] = metal(7, false).columns();
  t[TEX_METAL_RIVET] = metal(7, true).columns();
  t[TEX_BRICK] = brick(9, [150, 70, 52]).columns();
  t[TEX_BRICK_DARK] = brick(10, [96, 64, 56]).columns();
  t[TEX_TILE] = tile(11, false).columns();
  t[TEX_TILE_GRIME] = tile(11, true).columns();
  t[TEX_EXIT] = exitPanel().columns();
  t[TEX_DOOR] = door().columns();
  t[TEX_DOOR_JAMB] = jamb().columns();
  return t;
}


// ------------------------------------------------------------------ materiali e colori

const CLOTH: Mat = { grain: 0.16 };
const SKIN: Mat = { grain: 0.04, spec: 0.08, shin: 6 };
const LEATHER: Mat = { grain: 0.1, spec: 0.22, shin: 8 };
const METAL: Mat = { spec: 0.75, shin: 18, amb: 0.3 };
const SHINY: Mat = { spec: 1, shin: 26, amb: 0.4 };
const WET: Mat = { spec: 0.6, shin: 20, amb: 0.4, dif: 0.5 };
const k = (c: RGB, f: number): RGB => [c[0] * f, c[1] * f, c[2] * f];
const BOOT: RGB = [62, 46, 36];
const BELT: RGB = [74, 52, 34];
const BRASS: RGB = [214, 168, 64];
const BLOOD: RGB = [150, 14, 12];
const FIRE_OUT: RGB = [255, 140, 30];
const FIRE_IN: RGB = [255, 244, 200];

// ------------------------------------------------------------------ figure in 3D, viste da 8 direzioni
//
// Le figure sono descritte in uno spazio 3D del personaggio: x verso la sua sinistra
// (a destra dello schermo quando ci guarda), y verso il basso in pixel dello sprite,
// z in avanti. Per ciascuna delle 8 viste lo scheletro viene ruotato attorno all'asse
// verticale e proiettato; le parti si disegnano dalla più lontana alla più vicina.

/** numero di viste per gli sprite orientabili */
export const VIEWS = 8;
type V3 = [number, number, number];

class View {
  readonly c: number;
  readonly s: number;
  /** view 0 = di fronte, 2 = fianco sinistro del personaggio, 4 = di spalle */
  constructor(view: number) {
    const th = (view * 2 * Math.PI) / VIEWS;
    this.c = Math.cos(th); this.s = Math.sin(th);
  }
  x(p: V3): number { return 64 + p[0] * this.c - p[2] * this.s; }
  depth(p: V3): number { return p[0] * this.s + p[2] * this.c; }
  /** quanto una direzione orizzontale (dx, dz) punta verso l'osservatore, da -1 a 1 */
  facing(dx: number, dz: number): number { const l = Math.hypot(dx, dz) || 1; return (dx * this.s + dz * this.c) / l; }
}

/** Parti da disegnare in ordine di profondità (a parità, in ordine di inserimento). */
class Scene {
  private parts: { d: number; i: number; f: () => void }[] = [];
  add(d: number, f: () => void): void { this.parts.push({ d, i: this.parts.length, f }); }
  draw(): void {
    this.parts.sort((a, b) => a.d - b.d || a.i - b.i);
    for (const p of this.parts) p.f();
  }
}

const mid = (a: V3, b: V3): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/** Strumenti 3D su una tela: ellissoidi, arti, segmenti di superficie. */
class Fig {
  readonly p: Paint;
  readonly v: View;
  readonly sc = new Scene();
  constructor(p: Paint, view: number) { this.p = p; this.v = new View(view); }
  ell(c: V3, ax: number, ay: number, az: number, col: RGB, m: Mat = {}, bias = 0): void {
    const { v } = this;
    this.sc.add(v.depth(c) + bias, () => this.p.ball(v.x(c), c[1], Math.hypot(ax * v.c, az * v.s), ay, col, m));
  }
  limb(a: V3, b: V3, ra: number, rb: number, col: RGB, m: Mat = {}, bias = 0): void {
    const { v } = this;
    this.sc.add(v.depth(mid(a, b)) + bias, () => this.p.limb(v.x(a), a[1], v.x(b), b[1], ra, rb, col, m));
  }
  /** Poligono di punti 3D (tese, orecchie, visiere). */
  poly(pts: V3[], col: RGB, m: Mat = {}, bias = 0): void {
    const { v } = this;
    let d = 0;
    for (const q of pts) d += v.depth(q);
    this.sc.add(d / pts.length + bias, () => this.p.poly(pts.flatMap((q) => [v.x(q), q[1]]), col, m));
  }
  at(d: number, f: () => void): void { this.sc.add(d, f); }
}

/**
 * Corpo a sezioni ellittiche (busto, testa): per ogni riga y c'è un'ellisse di
 * semiassi w (in x) e d (in z) centrata in (cx, cz).
 */
interface Section { w: number; d: number; cx: number; cz: number; }

/** Punto della superficie di una sezione all'angolo phi (0 = davanti, +pi/2 = fianco sinistro). */
function surf(s: Section, phi: number): V3 { return [s.cx + s.w * Math.sin(phi), 0, s.cz + s.d * Math.cos(phi)]; }
/** Visibilità del punto di superficie: > 0 se rivolto verso l'osservatore. */
function surfVis(v: View, s: Section, phi: number): number { return v.facing(Math.sin(phi) / s.w, Math.cos(phi) / s.d); }

/** Disegna un solido di rivoluzione schiacciato riga per riga, con colore per riga. */
function solid(f: Fig, y0: number, y1: number, sec: (y: number) => Section, color: (y: number) => RGB, m: Mat, bias = 0): void {
  const { v, p } = f;
  const sm = sec((y0 + y1) / 2);
  f.at(v.depth([sm.cx, 0, sm.cz]) + bias, () => {
    for (let y = Math.floor(y0); y < y1; y++) {
      const s = sec(y + 0.5);
      const cx = v.x([s.cx, 0, s.cz]);
      const e = Math.hypot(s.w * v.c, s.d * v.s);
      const c = color(y);
      const ny = 0;
      for (let x = Math.ceil(cx - e - 0.5); x < Math.ceil(cx + e - 0.5); x++) {
        const u = Math.max(-0.95, Math.min(0.95, (x + 0.5 - cx) / e));
        p.plot(x, y, p.lit(c, u, ny, Math.sqrt(1 - u * u), m, x, y));
      }
    }
  });
}

/** Elemento sulla superficie (bottone, tasca, occhio): disegnato solo se rivolto verso chi guarda. */
function onSurf(f: Fig, s: Section, y: number, phi: number, draw: (x: number, y: number, vis: number) => void, minVis = 0.2, out = 0): void {
  const vis = surfVis(f.v, s, phi);
  if (vis < minVis) return;
  const q = surf(s, phi);
  q[0] += Math.sin(phi) * out; q[2] += Math.cos(phi) * out;
  // subito dopo il solido su cui stanno, prima delle parti che gli passano davanti
  f.at(f.v.depth([s.cx, 0, s.cz]) + 0.5, () => draw(f.v.x(q), y, vis));
}

/** Fascia attorno a un solido (cintura, fascia del capo, visiera): segmenti verticali visibili. */
function band(f: Fig, sec: (y: number) => Section, y0: number, y1: number, phi0: number, phi1: number, col: RGB, m: Mat, bias = 30): void {
  const { v, p } = f;
  const s = sec((y0 + y1) / 2);
  f.at(v.depth([s.cx, 0, s.cz]) + bias, () => {
    const steps = 48;
    for (let i = 0; i <= steps; i++) {
      const phi = phi0 + ((phi1 - phi0) * i) / steps;
      for (let y = y0; y < y1; y++) {
        const sy = sec(y + 0.5);
        const vis = surfVis(v, sy, phi);
        if (vis <= 0) continue;
        const q = surf(sy, phi);
        const x = v.x(q);
        const u = Math.max(-0.95, Math.min(0.95, (x - v.x([sy.cx, 0, sy.cz])) / Math.max(1, Math.hypot(sy.w * v.c, sy.d * v.s))));
        p.plot(x, y, p.lit(col, u, 0, Math.sqrt(1 - u * u), m, x | 0, y));
      }
    }
  });
}

// ------------------------------------------------------------------ figure umane

export type Pose = 'stand' | 'walk1' | 'walk2' | 'aim' | 'fire' | 'pain' | 'dead';
export const POSES: readonly Pose[] = ['stand', 'walk1', 'walk2', 'aim', 'fire', 'pain', 'dead'];

type HatStyle = 'cap' | 'beret' | 'helmet' | 'hood' | 'band' | 'visor';
/** Stili dei copricapi dei giocatori, nello stesso ordine di HATS in progression.ts. */
export const HAT_STYLES: readonly HatStyle[] = ['cap', 'beret', 'helmet', 'hood', 'band'];
interface Outfit {
  body: RGB; dark: RGB; head: RGB; skin: RGB; gun: RGB; hat: HatStyle;
  /** guanti al posto delle mani nude */
  glove?: RGB;
  /** fucile lungo invece della pistola mitragliatrice */
  rifle?: boolean;
}

/** Scheletro 3D di una posa. Indice 0 = lato destro del personaggio (x negativa). */
interface Rig {
  head: V3; neck: V3; lean: number;
  sh: [V3, V3]; el: [V3, V3]; ha: [V3, V3];
  hip: [V3, V3]; kn: [V3, V3]; ft: [V3, V3];
}

function rigFor(pose: Pose): Rig {
  const r: Rig = {
    head: [0, 19, 0], neck: [0, 31, 0], lean: 0,
    sh: [[-15, 37, 0], [15, 37, 0]], el: [[-19, 56, -1], [19, 56, -1]], ha: [[-18, 73, 1], [18, 73, 1]],
    hip: [[-7, 73, 0], [7, 73, 0]], kn: [[-8, 97, 1], [8, 97, 1]], ft: [[-9, 119, 0], [9, 119, 0]],
  };
  if (pose === 'walk1' || pose === 'walk2') {
    const f = pose === 'walk1' ? 0 : 1, b = 1 - f; // gamba avanti e gamba indietro
    r.kn[f] = [r.kn[f][0], 95, 9]; r.ft[f] = [r.ft[f][0], 118, 10];
    r.kn[b] = [r.kn[b][0], 97, -3]; r.ft[b] = [r.ft[b][0], 115, -12];
    r.el[f][2] = -5; r.ha[f] = [r.ha[f][0], 71, -10]; // braccia in controfase
    r.el[b][2] = 4; r.ha[b] = [r.ha[b][0], 70, 12];
    for (const q of [r.head, r.neck, ...r.sh, ...r.el, ...r.ha]) q[1] += 1;
  } else if (pose === 'aim' || pose === 'fire') {
    r.el = [[-13, 52, 8], [13, 52, 8]];
    r.ha = [[-4, 52, 17], [4, 53, 16]];
  } else if (pose === 'pain') {
    r.lean = -4;
    for (const q of [r.head, r.neck, ...r.sh]) { q[1] += 2; q[2] -= 3; }
    r.head[2] -= 2;
    r.el = [[-24, 50, -4], [24, 52, -4]];
    r.ha = [[-31, 60, -2], [31, 62, -2]];
  }
  return r;
}

/** Sezione del busto alla riga y: spalle larghe, vita stretta, falde della giacca. */
function torsoSec(r: Rig): (y: number) => Section {
  return (y: number) => {
    const t = Math.max(0, Math.min(1, (y - 33) / (82 - 33)));
    const w = t < 0.25 ? 17 - t * 8 : t < 0.75 ? 15 - (t - 0.25) * 6 : 12 + (t - 0.75) * 8;
    const d = t < 0.4 ? 8 + t * 2.5 : 9 - (t - 0.4) * 3;
    return { w, d, cx: 0, cz: r.lean * (1 - t) };
  };
}

function headSec(r: Rig): (y: number) => Section {
  const [hx, hy, hz] = r.head;
  return (y: number) => {
    const u = (y - (hy + 2)) / 10.5;
    const k2 = Math.sqrt(Math.max(0.05, 1 - u * u));
    return { w: 8.5 * k2, d: 8.6 * k2, cx: hx, cz: hz };
  };
}

function humanoid3d(o: Outfit, pose: Pose, view: number): Paint {
  const p = new Paint(SS, SS);
  if (pose === 'dead') { corpse(p, o); p.outline(); return p; }
  const f = new Fig(p, view);
  const r = rigFor(pose);
  const v = f.v;
  const aiming = pose === 'aim' || pose === 'fire';

  // gambe, stivali
  for (let i = 0; i < 2; i++) {
    const ankle: V3 = [r.ft[i][0], r.ft[i][1] - 6, r.ft[i][2]];
    f.limb(r.hip[i], r.kn[i], 7, 5.6, o.dark, CLOTH);
    f.limb(r.kn[i], ankle, 5.6, 4.8, o.dark, CLOTH);
    f.limb([ankle[0], ankle[1] - 3, ankle[2]], [ankle[0], ankle[1] + 4, ankle[2]], 5.2, 5.4, BOOT, LEATHER, 0.5);
    f.ell([r.ft[i][0], r.ft[i][1], r.ft[i][2] + 3], 4.6, 3.6, 7.5, BOOT, LEATHER, 0.6);
  }
  // busto con cintura, abbottonatura, tasche, bandoliera
  const ts = torsoSec(r);
  solid(f, 33, 82, ts, (y) => (y >= 69 && y < 75 ? BELT : y >= 75 ? k(o.body, 0.92) : o.body), CLOTH);
  const sec = (y: number) => ts(y);
  for (let y = 40; y < 68; y += 8) onSurf(f, sec(y), y, 0.12, (x, yy) => p.ball(x, yy, 1.2, 1.2, BRASS, SHINY));
  onSurf(f, sec(36), 36, 0, (x, yy, vis) => p.poly([x - 7 * vis, yy - 3, x, yy + 4, x + 7 * vis, yy - 3], k(o.body, 0.7), CLOTH), 0.1); // colletto
  for (const phi of [-0.5, 0.5]) {
    onSurf(f, sec(46), 46, phi, (x, yy, vis) => {
      const w = Math.max(2, Math.round(10 * vis));
      p.box(Math.round(x - w / 2), yy - 4, w, 8, k(o.body, 0.9), CLOTH);
      p.line(x - w / 2, yy - 1, x + w / 2 - 1, yy - 1, k(o.body, 0.5));
    }, 0.25);
  }
  onSurf(f, sec(72), 72, 0, (x, yy, vis) => p.box(Math.round(x - 3.5 * vis), yy - 3, Math.max(2, Math.round(7 * vis)), 6, BRASS, SHINY), 0.2, 0.5); // fibbia
  for (const phi of [-0.75, 0.75, Math.PI - 0.6, Math.PI + 0.6]) {
    onSurf(f, sec(76), 76, phi, (x, yy, vis) => p.box(Math.round(x - 3.5 * vis), yy - 3, Math.max(2, Math.round(7 * vis)), 8, k(BELT, 0.9), LEATHER), 0.1, 1); // tasche del cinturone
  }
  // bandoliera: davanti dalla spalla sinistra al fianco destro, dietro il ritorno
  for (let t = 0; t <= 1; t += 0.03) {
    const y = 36 + t * 34;
    onSurf(f, sec(y), y, 0.75 - t * 1.5, (x, yy) => p.ball(x, yy, 1.9, 1.9, BELT, LEATHER), 0.05, 0.6);
    onSurf(f, sec(y), y, Math.PI - 0.75 + t * 1.5, (x, yy) => p.ball(x, yy, 1.9, 1.9, BELT, LEATHER), 0.05, 0.6);
  }
  // spalline
  f.ell([r.sh[0][0], r.sh[0][1] - 1, r.sh[0][2]], 6.5, 4.5, 6, k(o.body, 1.05), CLOTH, 2);
  f.ell([r.sh[1][0], r.sh[1][1] - 1, r.sh[1][2]], 6.5, 4.5, 6, k(o.body, 1.05), CLOTH, 2);

  // braccia e mani
  for (let i = 0; i < 2; i++) {
    f.limb(r.sh[i], r.el[i], 5.4, 4.6, o.body, CLOTH, 3);
    f.limb(r.el[i], r.ha[i], 4.6, 4, k(o.body, 0.94), CLOTH, 3);
    const cuff: V3 = [r.ha[i][0] + (r.el[i][0] - r.ha[i][0]) * 0.18, r.ha[i][1] + (r.el[i][1] - r.ha[i][1]) * 0.18, r.ha[i][2] + (r.el[i][2] - r.ha[i][2]) * 0.18];
    f.limb(cuff, r.ha[i], 4.4, 4.4, k(o.body, 0.7), CLOTH, 3.1);
    const hc: V3 = [r.ha[i][0], r.ha[i][1] + 3, r.ha[i][2]];
    f.ell(hc, 4.2, 4.6, 4.2, o.glove ?? o.skin, o.glove ? LEATHER : SKIN, 3.2);
  }

  // arma
  if (aiming) {
    const a: V3 = [0, 50, 12], b: V3 = [0, 47, 34];
    if (o.rifle) f.limb([0, 53, 6], [0, 58, -4], 3.4, 3.4, [116, 72, 40], LEATHER, 4); // calcio
    f.limb(a, [0, 49, 22], 5.5, 5, k(o.gun, 1.5), METAL, 4);
    f.limb([0, 49, 20], b, 2.4, 2.4, k(o.gun, 1.3), METAL, 4);
    f.limb([0, 54, 18], [0, 64, 16], 2.4, 2, k(o.gun, 0.9), METAL, 4); // caricatore
    const toward = v.facing(0, 1);
    if (toward > 0.6) f.at(v.depth(b) + 5, () => p.ball(v.x(b), b[1], 2, 2, [10, 10, 12]));
    if (pose === 'fire') {
      const m: V3 = [0, 47, 37];
      f.at(v.depth(m) + 6, () => {
        const gx = v.x(m), gy = m[1];
        const sz = 0.55 + 0.45 * Math.abs(toward);
        for (let q = 0; q < 8; q++) {
          const ang = (q / 8) * Math.PI * 2 + 0.2;
          const len = (q % 2 ? 9 : 16) * sz;
          p.poly([gx, gy, gx + Math.cos(ang - 0.3) * 5, gy + Math.sin(ang - 0.3) * 5, gx + Math.cos(ang) * len, gy + Math.sin(ang) * len, gx + Math.cos(ang + 0.3) * 5, gy + Math.sin(ang + 0.3) * 5], FIRE_OUT, { amb: 1, dif: 0 });
        }
        p.ball(gx, gy, 7 * sz, 6 * sz, [255, 200, 70], { amb: 1, dif: 0 });
        p.ball(gx, gy, 3.5 * sz, 3 * sz, FIRE_IN, { amb: 1, dif: 0 });
      });
    }
  } else {
    // arma nella mano sinistra del personaggio, puntata verso il basso
    const h = r.ha[1];
    if (o.rifle) {
      f.limb([h[0] + 1, h[1] - 14, h[2] + 3], [h[0] + 2, h[1] + 24, h[2] + 4], 2, 2, o.gun, METAL, 3.5);
      f.limb([h[0] + 1, h[1] - 2, h[2] + 3], [h[0] + 1, h[1] + 10, h[2] + 3], 3.4, 3.4, k(o.gun, 1.1), METAL, 3.6);
      f.limb([h[0] + 2, h[1] + 12, h[2] + 3], [h[0] + 3, h[1] + 30, h[2] + 3], 3.2, 4.2, [116, 72, 40], LEATHER, 3.6);
    } else {
      f.limb([h[0], h[1] + 2, h[2] + 2], [h[0], h[1] + 16, h[2] + 4], 3, 3, o.gun, METAL, 3.6);
      f.limb([h[0], h[1] + 14, h[2] + 4], [h[0], h[1] + 22, h[2] + 5], 1.4, 1.4, k(o.gun, 0.7), METAL, 3.6);
    }
  }

  // testa
  const hs = headSec(r);
  const [hx, hy, hz] = r.head;
  const hd = v.depth(r.head);
  f.limb(r.neck, [hx, hy + 8, hz], 4.2, 4.2, k(o.skin, 0.8), SKIN, 1);
  f.limb([r.neck[0], r.neck[1] + 1, r.neck[2]], [r.neck[0], r.neck[1] + 3, r.neck[2]], 6, 6, k(o.body, 0.75), CLOTH, 1.5); // colletto
  for (const side of [-1, 1]) f.ell([hx + side * 8.5, hy + 3, hz], 1.4, 3, 2.2, o.skin, SKIN, 4); // orecchie
  hatLayer(f, o, r, 'back');
  solid(f, hy - 8.5, hy + 12.5, hs, () => o.skin, SKIN, 5);
  // viso: elementi sulla superficie della testa
  const faceVis = surfVis(v, hs(hy + 2), 0);
  if (faceVis > 0.1) {
    f.at(hd + 5.5, () => {
      const pt = (phi: number, y: number) => v.x(surf(hs(y), phi));
      const brow = k(o.skin, 0.45);
      for (const side of [-1, 1]) {
        const phi = side * 0.42;
        if (surfVis(v, hs(hy + 2), phi) < 0.15) continue;
        const ex = pt(phi, hy + 2);
        p.line(ex - 2, hy, ex + 1, hy, brow);
        if (pose === 'pain') p.line(ex - 1, hy + 2, ex + 1, hy + 3, [30, 20, 20]);
        else { p.plot(ex - 0.5, hy + 2, [240, 236, 226]); p.plot(ex + 0.5, hy + 2, [30, 26, 30]); }
      }
      const nx = pt(0, hy + 4);
      p.line(nx, hy + 3, nx, hy + 5, k(o.skin, 0.72));
      p.plot(nx + v.s * -1.5, hy + 5, k(o.skin, 1.1)); // punta del naso in rilievo
      p.plot(nx + 1, hy + 6, k(o.skin, 0.6));
      const mx = pt(0, hy + 8);
      if (pose === 'pain') p.ball(mx, hy + 8, 2.2 * faceVis + 0.5, 2, [70, 20, 20]);
      else p.line(mx - 2 * faceVis, hy + 8, mx + 2 * faceVis, hy + 8, k(o.skin, 0.5));
    });
  }
  hatLayer(f, o, r, 'front');

  if (pose === 'pain') {
    onSurf(f, sec(52), 52, 0.1, (x, yy) => { p.ball(x, yy, 6, 5, BLOOD, WET); p.ball(x - 2, yy + 9, 2, 3, BLOOD, WET); p.ball(x + 3, yy + 14, 1.5, 2.5, BLOOD, WET); }, 0.1, 1);
  }
  f.sc.draw();
  p.outline();
  return p;
}

/** Copricapi in 3D. 'back' contiene le parti che stanno dietro la testa. */
function hatLayer(f: Fig, o: Outfit, r: Rig, layer: 'back' | 'front'): void {
  const [hx, hy, hz] = r.head;
  const c = o.head;
  const hs = headSec(r);
  const on = (dy: number, dz = 0): V3 => [hx, hy + dy, hz + dz];
  if (layer === 'back') {
    if (o.hat === 'hood') f.ell(on(1, -2), 12.5, 13.5, 12, k(c, 0.8), CLOTH, 4.5);
    if (o.hat === 'band') {
      f.ell(on(-3, -2.2), 9.2, 9.5, 9.4, [58, 42, 30], { grain: 0.4 }, 4.9); // capelli
      f.limb(on(-3, -8.5), [hx + 3, hy + 6, hz - 12], 1.6, 1, [176, 30, 30], CLOTH, 0); // nastri
      f.limb(on(-3, -8.5), [hx - 2, hy + 8, hz - 11], 1.4, 0.8, [150, 24, 24], CLOTH, 0);
    } else f.ell(on(-2, -2.2), 8.9, 9.5, 9, [60, 44, 32], { grain: 0.4 }, 4.9); // capelli corti, coprono la nuca
    return;
  }
  const bias = 8; // sopra la testa
  switch (o.hat) {
    case 'helmet':
    case 'visor': {
      f.ell(on(-7), 11, 8, 11, c, METAL, bias);
      f.ell(on(-2), 11.5, 2.2, 11.5, k(c, o.hat === 'helmet' ? 0.8 : 0.7), METAL, bias + 0.1); // tesa
      if (o.hat === 'visor') {
        band(f, hs, hy - 1, hy + 4, -1.1, 1.1, [60, 210, 230], SHINY, bias + 1);
        f.ell([hx + 10, hy + 1, hz], 2.2, 3, 2.2, [70, 74, 80], METAL, bias + 1.5);
      } else {
        band(f, hs, hy + 1, hy + 9, -Math.PI / 2 - 0.12, -Math.PI / 2 + 0.12, [40, 34, 28], LEATHER, bias + 1); // sottogola
        band(f, hs, hy + 1, hy + 9, Math.PI / 2 - 0.12, Math.PI / 2 + 0.12, [40, 34, 28], LEATHER, bias + 1);
      }
      break;
    }
    case 'cap':
      f.ell(on(-7), 9.5, 6, 9.5, c, CLOTH, bias);
      f.poly([[hx - 8, hy - 3, hz + 5], [hx + 8, hy - 3, hz + 5], [hx + 9, hy - 1, hz + 13], [hx - 9, hy - 1, hz + 13]], k(c, 0.75), CLOTH, bias); // visiera
      band(f, hs, hy - 4, hy - 2, -Math.PI, Math.PI, k(c, 0.55), CLOTH, bias + 0.5);
      band(f, hs, hy - 9, hy - 7, -0.15, 0.15, BRASS, SHINY, bias + 1); // stemma
      break;
    case 'beret':
      f.ell([hx + 2, hy - 8, hz - 1], 12, 5, 11, c, CLOTH, bias);
      band(f, hs, hy - 5, hy - 3, -Math.PI, Math.PI, k(c, 0.6), LEATHER, bias + 0.5);
      band(f, hs, hy - 8, hy - 5, -0.65, -0.35, BRASS, SHINY, bias + 1); // fregio
      break;
    case 'hood':
      f.ell(on(-7, -1), 10.5, 5.5, 10.5, c, CLOTH, bias);
      band(f, hs, hy - 5, hy + 12, -Math.PI / 2 - 0.5, -Math.PI / 2 + 0.25, c, CLOTH, bias + 0.5);
      band(f, hs, hy - 5, hy + 12, Math.PI / 2 - 0.25, Math.PI / 2 + 0.5, c, CLOTH, bias + 0.5);
      band(f, hs, hy - 5, hy + 12, Math.PI / 2 + 0.5, Math.PI * 1.5 - 0.5, k(c, 0.9), CLOTH, bias + 0.5);
      break;
    case 'band':
      band(f, hs, hy - 6, hy - 2, -Math.PI, Math.PI, [196, 36, 34], CLOTH, bias);
      break;
  }
}

/** Mano disegnata in 2D (per le figure a terra). */
function hand(p: Paint, o: Outfit, x: number, y: number): void {
  const c = o.glove ?? o.skin;
  p.ball(x, y, 4.2, 4.6, c, o.glove ? LEATHER : SKIN);
  p.line(x - 2, y + 2, x + 2, y + 2, k(c, 0.6));
}

// ------------------------------------------------------------------ mastino

function houndDead(): Paint {
  const p = new Paint(SS, SS);
  const fur: RGB = [112, 84, 56], dark: RGB = [64, 46, 32], light: RGB = [168, 132, 92];
  const FUR: Mat = { grain: 0.35 };
  p.ball(64, 121, 46, 6, k(BLOOD, 0.7), WET);
  p.ball(66, 112, 30, 11, fur, FUR);
  p.ball(64, 117, 22, 5, light, FUR);
  p.limb(90, 116, 108, 122, 3.4, 2.6, dark, FUR);
  p.limb(80, 118, 100, 124, 3.4, 2.6, dark, FUR);
  p.ball(32, 112, 11, 9, fur, FUR);
  p.ball(22, 116, 7, 5, dark, FUR);
  p.poly([30, 104, 38, 98, 40, 108], dark, FUR);
  p.line(28, 110, 33, 111, [20, 14, 10]);
  p.limb(96, 108, 116, 102, 2.4, 1.4, fur, FUR);
  p.outline();
  return p;
}

function hound3d(pose: Pose, view: number): Paint {
  if (pose === 'dead') return houndDead();
  const p = new Paint(SS, SS);
  const f = new Fig(p, view);
  const v = f.v;
  const fur: RGB = [112, 84, 56], dark: RGB = [64, 46, 32], light: RGB = [168, 132, 92];
  const FUR: Mat = { grain: 0.35 };
  const bob = pose === 'walk1' ? -2 : pose === 'walk2' ? 2 : 0;
  const swing = pose === 'walk1' ? 6 : pose === 'walk2' ? -6 : 0;
  const lunge = pose === 'aim' || pose === 'fire' ? 4 : 0;

  // tronco, petto, coda
  f.ell([0, 82 + bob, -8], 13, 14, 26, k(fur, 0.9), FUR);
  f.ell([0, 89 + bob, -6], 9, 7, 20, light, FUR, 0.5); // ventre
  f.ell([0, 80 + bob, 12 + lunge], 14, 14, 11, fur, FUR, 1);
  f.ell([0, 86 + bob, 18 + lunge], 9, 8, 6, light, FUR, 1.5);
  f.limb([0, 74 + bob, -30], [0, 60 + bob, -42], 3, 1.6, fur, FUR);
  // zampe: anteriori e posteriori in controfase
  const legs: [number, number, number][] = [[-8, 14 + lunge, swing], [8, 14 + lunge, -swing], [-9, -26, -swing], [9, -26, swing]];
  for (const [x, z, sw] of legs) {
    const hind = z < 0;
    const top: V3 = [x, 86 + bob, z];
    const knee: V3 = [x, 104, z + sw * 0.6 + (hind ? -4 : 0)];
    const paw: V3 = [x, 120, z + sw];
    if (hind) f.ell([x, 88 + bob, z], 6, 9, 10, k(fur, 0.85), FUR, 0.2); // coscia
    f.limb(top, knee, 5.4, 3.8, hind ? k(fur, 0.85) : fur, FUR, 0.3);
    f.limb(knee, paw, 3.6, 3.2, dark, FUR, 0.3);
    f.ell([x, 121, z + sw + 2], 4.5, 2.6, 5.5, dark, FUR, 0.4);
  }
  // collare e testa
  const hy = 60 + bob + lunge, hz = 24 + lunge;
  f.ell([0, hy + 10, hz - 4], 10, 3.4, 9, [150, 30, 26], LEATHER, 2);
  for (let i = -2; i <= 2; i++) {
    const phi = i * 0.5;
    f.ell([Math.sin(phi) * 10, hy + 11, hz - 4 + Math.cos(phi) * 9], 1.4, 1.4, 1.4, [210, 214, 220], SHINY, 2.5);
  }
  for (const side of [-1, 1]) f.poly([[side * 8, hy - 6, hz], [side * 12, hy - 20, hz - 2], [side * 3, hy - 9, hz + 1]], dark, FUR, 2.6); // orecchie
  f.ell([0, hy, hz], 13, 12, 12, fur, FUR, 3);
  f.ell([0, hy + 8, hz + 10], 7.5, 6, 9, light, FUR, 3.5); // muso
  const nose: V3 = [0, hy + 5, hz + 19];
  f.ell(nose, 3.2, 2.4, 2.4, [24, 18, 18], SHINY, 4);
  // occhi gialli sulla superficie della testa
  const hsec = (): Section => ({ w: 13, d: 12, cx: 0, cz: hz });
  for (const side of [-1, 1]) {
    const phi = side * 0.5;
    if (surfVis(v, hsec(), phi) < 0.15) continue;
    const q = surf(hsec(), phi);
    f.at(v.depth([0, 0, hz]) + 3.2, () => {
      const ex = v.x(q);
      p.ball(ex, hy - 3, 2.4, 2, [250, 200, 50], { amb: 0.9, dif: 0.3 });
      p.plot(ex, hy - 3, [30, 10, 0]);
      p.line(ex - 3, hy - 6, ex + 2, hy - 5, k(dark, 0.6));
    });
  }
  // fauci
  const mouth: V3 = [0, hy + 12, hz + 14];
  const toward = v.facing(0, 1);
  if (pose === 'aim' || pose === 'fire') {
    f.ell(mouth, 6, 4.5, 6, [110, 18, 22], {}, 4.2);
    if (toward > -0.3) {
      f.at(v.depth(mouth) + 4.3, () => {
        const mx = v.x(mouth);
        p.ball(mx, hy + 14, 3.5, 2, [200, 80, 90], {});
        for (const t of [-4, -1.5, 1.5, 4]) { p.line(mx + t, hy + 9, mx + t, hy + 11, [244, 240, 226]); p.line(mx + t, hy + 16, mx + t, hy + 15, [244, 240, 226]); }
      });
    }
  } else if (toward > 0) {
    f.at(v.depth(mouth) + 4.3, () => {
      const mx = v.x(mouth);
      p.line(mx - 4, hy + 11, mx + 4, hy + 11, k(dark, 0.6));
      p.line(mx - 2, hy + 12, mx - 2, hy + 13, [240, 236, 220]);
      p.line(mx + 2, hy + 12, mx + 2, hy + 13, [240, 236, 220]);
    });
  }
  if (pose === 'pain') {
    f.at(100, () => { const x = v.x([0, 0, 10]); p.ball(x - 4, 82 + bob, 6, 5, BLOOD, WET); p.ball(x - 5, 92 + bob, 2, 3, BLOOD, WET); });
  }
  f.sc.draw();
  p.outline();
  return p;
}

function corpse(p: Paint, o: Outfit): void {
  p.ball(66, 121, 50, 6, k(BLOOD, 0.7), WET);
  p.ball(48, 120, 18, 4, BLOOD, WET);
  // gambe
  p.limb(78, 114, 98, 115, 6.5, 5.5, o.dark, CLOTH);
  p.limb(98, 115, 113, 117, 5.5, 4.5, o.dark, CLOTH);
  p.limb(78, 117, 100, 120, 6, 5, k(o.dark, 0.8), CLOTH);
  p.ball(118, 114, 4, 6.5, BOOT, LEATHER);
  p.ball(105, 121, 4, 5, BOOT, LEATHER);
  // busto e cinturone
  p.limb(38, 112, 78, 115, 10, 9, o.body, CLOTH);
  p.limb(74, 106, 74, 123, 2.6, 2.6, BELT, LEATHER);
  p.box(72, 111, 5, 6, BRASS, SHINY);
  p.limb(44, 105, 70, 124, 1.8, 1.8, BELT, LEATHER);
  // braccia
  p.limb(42, 108, 54, 98, 4.6, 4, o.body, CLOTH);
  p.limb(54, 98, 66, 102, 4, 3.6, o.body, CLOTH);
  hand(p, o, 69, 102);
  p.limb(40, 118, 30, 124, 4.6, 4, k(o.body, 0.8), CLOTH);
  // testa reclinata
  p.limb(30, 112, 38, 112, 4, 4, k(o.skin, 0.8), SKIN);
  p.ball(22, 110, 9, 8.5, o.skin, SKIN);
  p.line(17, 107, 20, 108, [30, 24, 24]);
  p.line(17, 112, 21, 113, k(o.skin, 0.5));
  const c = o.head;
  if (o.hat === 'band') p.limb(26, 101, 30, 117, 2, 2, [196, 36, 34], CLOTH);
  else if (o.hat === 'hood') p.ball(25, 109, 9, 11, c, CLOTH);
  else p.ball(30, 110, 6, 10, c, o.hat === 'helmet' || o.hat === 'visor' ? METAL : CLOTH);
  // arma caduta
  p.limb(82, 125, 104, 124, 2, 2, o.gun, METAL);
  p.box(84, 121, 9, 5, k(o.gun, 1.2), METAL, 0);
}


// ------------------------------------------------------------------ oggetti

function item(kind: string): Paint {
  const p = new Paint(SS, SS);
  switch (kind) {
    case 'medkit':
      p.box(34, 92, 60, 34, [222, 222, 214], { grain: 0.06 }, 2);
      p.box(34, 88, 60, 7, [236, 236, 230], {}, 1); // coperchio
      p.box(58, 82, 12, 7, [60, 60, 66], LEATHER, 1); // maniglia
      p.box(60, 96, 8, 26, [200, 28, 28], {}, 1);
      p.box(51, 105, 26, 8, [200, 28, 28], {}, 1);
      p.box(36, 107, 4, 6, [150, 150, 156], METAL, 0);
      p.box(88, 107, 4, 6, [150, 150, 156], METAL, 0);
      break;
    case 'food':
      p.ball(64, 120, 34, 7, [226, 226, 220], SHINY);
      p.ball(64, 120, 26, 4.5, [196, 196, 190], {});
      p.ball(60, 109, 20, 11, [168, 96, 40], { spec: 0.5, shin: 10, grain: 0.15 });
      p.ball(55, 104, 8, 4, [214, 150, 80], { spec: 0.6, shin: 12 });
      p.limb(76, 110, 88, 100, 4.5, 3, [176, 104, 48], { spec: 0.4, shin: 10 });
      p.ball(90, 98, 3, 3, [236, 230, 210], {});
      p.ball(93, 100, 2.6, 2.6, [236, 230, 210], {});
      for (const [x, y] of [[40, 116], [46, 118], [84, 117]]) p.ball(x, y, 3.5, 2.5, [70, 150, 60], { grain: 0.3 });
      break;
    case 'ammo':
      p.box(30, 98, 68, 28, [92, 98, 58], { grain: 0.2 }, 2);
      p.box(30, 98, 68, 6, [110, 118, 70], {}, 1);
      p.box(42, 108, 44, 12, [74, 80, 46], {}, 0);
      for (let i = 0; i < 4; i++) p.box(46 + i * 10, 111, 6, 6, [190, 180, 120], {}, 0); // stampigliatura
      for (let i = 0; i < 7; i++) {
        const x = 36 + i * 9;
        p.limb(x, 98, x, 84, 3.2, 3.2, BRASS, SHINY);
        p.ball(x, 82, 3, 4.5, [190, 110, 60], SHINY);
      }
      break;
    case 'clip':
      p.poly([52, 96, 74, 96, 78, 126, 56, 126], [64, 66, 72], METAL, 'cyl');
      p.line(55, 104, 75, 104, [40, 42, 46]);
      for (let i = 0; i < 2; i++) { p.limb(58 + i * 9, 95, 58 + i * 9, 88, 3, 3, BRASS, SHINY); p.ball(58 + i * 9, 86, 2.8, 3.6, [190, 110, 60], SHINY); }
      break;
    case 'smg':
      p.limb(18, 106, 104, 104, 3.2, 3, [52, 54, 60], METAL); // canna
      p.poly([36, 98, 92, 98, 92, 112, 36, 112], [60, 62, 68], METAL, 'vcyl'); // castello
      for (let x = 72; x < 104; x += 5) p.ball(x, 104, 1.4, 1.4, [16, 16, 18]); // fori del manicotto
      p.poly([52, 112, 62, 112, 58, 128, 48, 128], [40, 40, 46], METAL, 'cyl'); // caricatore
      p.poly([70, 112, 78, 112, 76, 124, 68, 124], [48, 48, 52], METAL, 'cyl'); // impugnatura
      p.poly([14, 100, 36, 102, 36, 112, 14, 118], [120, 80, 48], LEATHER, 'vcyl'); // calcio
      break;
    case 'chaingun':
      for (let i = 0; i < 3; i++) p.limb(24, 96 + i * 7, 112, 98 + i * 6, 3.4, 3, [96, 100, 110], METAL);
      p.limb(98, 95, 98, 113, 3, 3, [130, 134, 144], METAL); // fascia
      p.poly([16, 90, 72, 90, 76, 118, 16, 118], [62, 66, 74], METAL, 'vcyl');
      p.box(30, 116, 26, 12, [82, 64, 40], LEATHER, 1); // cassetta
      for (let i = 0; i < 5; i++) p.ball(34 + i * 5, 114, 1.8, 2.6, BRASS, SHINY);
      p.limb(30, 86, 62, 86, 2.4, 2.4, [150, 154, 164], METAL); // maniglia
      break;
    case 'coins':
      for (const [x, y] of [[50, 120], [72, 120], [61, 114], [42, 124], [82, 124], [62, 124], [56, 108], [70, 110]]) {
        p.ball(x, y, 9, 5, [176, 126, 24], SHINY);
        p.ball(x, y - 1.5, 7.5, 3.4, [236, 196, 60], SHINY);
        p.line(x - 3, y - 2, x + 2, y - 2, [255, 250, 190]);
      }
      break;
    case 'gem': {
      const g: RGB = [60, 200, 220];
      p.poly([64, 84, 82, 100, 64, 104], k(g, 1.2), SHINY);
      p.poly([64, 84, 46, 100, 64, 104], k(g, 0.95), SHINY);
      p.poly([46, 100, 64, 104, 64, 126], k(g, 0.6), SHINY);
      p.poly([82, 100, 64, 104, 64, 126], k(g, 0.8), SHINY);
      p.line(64, 84, 64, 125, k(g, 1.5));
      p.line(57, 90, 60, 93, [255, 255, 255]);
      p.plot(58, 91, [255, 255, 255]);
      break;
    }
  }
  p.outline(0.5);
  return p;
}

/** Base di squadra: asta con stendardo e piedistallo. */
function teamBase(c: RGB): Paint {
  const p = new Paint(SS, SS);
  p.poly([38, 110, 90, 110, 98, 127, 30, 127], [96, 98, 104], METAL, 'cyl');
  p.box(44, 104, 40, 7, [120, 122, 130], METAL, 1);
  p.limb(64, 10, 64, 106, 2.6, 2.6, [160, 162, 170], METAL);
  p.ball(64, 8, 4.4, 4.4, BRASS, SHINY);
  // stendardo ondeggiante, in tre fasce
  const wave = (x: number) => Math.sin(x * 0.12) * 3;
  for (let i = 0; i < 3; i++) {
    const x0 = 66 + i * 14, x1 = x0 + 14;
    p.poly([x0, 16 + wave(x0), x1, 16 + wave(x1), x1, 50 + wave(x1), x0, 50 + wave(x0)], k(c, i % 2 ? 0.85 : 1.05), CLOTH, 'vcyl');
  }
  for (let i = 0; i < 5; i++) { // frange
    const x = 68 + i * 8;
    p.poly([x, 50 + wave(x), x + 6, 50 + wave(x + 6), x + 3, 57 + wave(x)], k(c, 0.7), CLOTH);
  }
  // emblema: ingranaggio con stella
  p.ball(87, 33, 9, 9, k(c, 0.45), CLOTH);
  for (let a = 0; a < 8; a++) p.ball(87 + Math.cos(a * Math.PI / 4) * 9, 33 + Math.sin(a * Math.PI / 4) * 9, 2, 2, k(c, 0.45), CLOTH);
  p.ball(87, 33, 5, 5, [236, 220, 170], CLOTH);
  p.limb(66, 16, 108, 16, 1.4, 1.4, k(c, 0.5), CLOTH);
  p.outline(0.5);
  return p;
}

/** Valigetta dei documenti; "high" la disegna sopra la testa di chi la porta. */
function briefcase(c: RGB, high: boolean): Paint {
  const p = new Paint(SS, SS);
  const y = high ? 2 : 94;
  p.limb(54, y + 6, 74, y + 6, 2.6, 2.6, [44, 36, 30], LEATHER); // maniglia
  p.limb(54, y + 6, 54, y + 11, 2.2, 2.2, [44, 36, 30], LEATHER);
  p.limb(74, y + 6, 74, y + 11, 2.2, 2.2, [44, 36, 30], LEATHER);
  p.poly([40, y + 10, 88, y + 10, 90, y + 34, 38, y + 34], c, LEATHER, 'vcyl');
  p.box(41, y + 13, 46, 3, [236, 232, 214], {}, 0); // fogli che sporgono
  p.line(40, y + 18, 88, y + 18, k(c, 0.5));
  p.box(46, y + 16, 6, 5, BRASS, SHINY, 1);
  p.box(76, y + 16, 6, 5, BRASS, SHINY, 1);
  p.box(58, y + 22, 12, 8, [230, 222, 196], {}, 1); // etichetta
  p.line(60, y + 25, 67, y + 25, [120, 110, 90]);
  p.line(60, y + 27, 65, y + 27, [120, 110, 90]);
  p.outline(0.45);
  return p;
}

const ENEMY_OUTFITS: Record<string, Outfit> = {
  guard: { body: [126, 120, 82], dark: [88, 82, 58], head: [86, 92, 66], skin: [214, 170, 130], gun: [48, 48, 52], hat: 'helmet', rifle: true },
  trooper: { body: [64, 74, 98], dark: [40, 46, 62], head: [40, 44, 56], skin: [200, 156, 120], gun: [36, 36, 40], hat: 'visor', glove: [36, 34, 34] },
};

/** Chiave dello sprite di un giocatore; view = 0..7 (0 di fronte), ignorata per i caduti. */
export const playerSpriteKey = (color: number, hat: number, pose: Pose, view = 0) =>
  pose === 'dead' ? `p${color}h${hat}:dead` : `p${color}h${hat}:${pose}:${view}`;
/** Chiave dello sprite di un nemico ("guard", "trooper", "hound"). */
export const enemySpriteKey = (kind: string, pose: Pose, view = 0) => (pose === 'dead' ? `${kind}:dead` : `${kind}:${pose}:${view}`);

/**
 * Vista (0..7) di un'entità rivolta verso l'angolo `facing` (radianti, come atan2 sulla mappa),
 * guardata da (cx, cy). 0 = ci guarda, 2 = mostra il fianco sinistro, 4 = di spalle.
 */
export function viewIndex(facing: number, ex: number, ey: number, cx: number, cy: number): number {
  const toViewer = Math.atan2(cy - ey, cx - ex);
  const th = facing - toViewer;
  return ((Math.round(th / ((2 * Math.PI) / VIEWS)) % VIEWS) + VIEWS) % VIEWS;
}

/**
 * Sprite per chiave: "guard:walk1:3", "hound:dead", "item:medkit", "p3h1:fire:0"
 * (giocatore colore 3, copricapo 1, visto di fronte). Le figure si generano quando
 * servono la prima volta, poi restano in memoria.
 */
export class SpriteBank {
  private m = new Map<string, Uint8Array>();

  constructor() {
    for (const kd of ['medkit', 'food', 'ammo', 'clip', 'smg', 'chaingun', 'coins', 'gem']) this.m.set(`item:${kd}`, item(kd).indexed());
    TEAMS.forEach((t, i) => {
      const c = PLAYER_COLORS[t.color].rgb;
      this.m.set(`base${i}`, teamBase(c).indexed());
      this.m.set(`flag${i}`, briefcase(c, false).indexed());
      this.m.set(`flagc${i}`, briefcase(c, true).indexed());
    });
  }

  /** Genera in anticipo le figure dei nemici (evita piccoli scatti la prima volta che compaiono). */
  warmEnemies(): void {
    for (const kind of ['guard', 'trooper', 'hound']) for (const pose of POSES) for (let v = 0; v < VIEWS; v++) this.get(enemySpriteKey(kind, pose, v));
  }

  get(key: string): Uint8Array | undefined {
    const hit = this.m.get(key);
    if (hit) return hit;
    let tex: Uint8Array | undefined;
    const en = /^(guard|trooper|hound):(\w+)(?::(\d))?$/.exec(key);
    const pl = /^p(\d+)h(\d+):(\w+)(?::(\d))?$/.exec(key);
    if (en) {
      const pose = en[2] as Pose, view = Number(en[3] ?? 0);
      if (!POSES.includes(pose) || view >= VIEWS) return undefined;
      tex = (en[1] === 'hound' ? hound3d(pose, view) : humanoid3d(ENEMY_OUTFITS[en[1]], pose, view)).indexed();
    } else if (pl) {
      const pc = PLAYER_COLORS[Number(pl[1])], hatStyle = HAT_STYLES[Number(pl[2])], pose = pl[3] as Pose, view = Number(pl[4] ?? 0);
      if (!pc || !hatStyle || !POSES.includes(pose) || view >= VIEWS) return undefined;
      const body = pc.rgb;
      tex = humanoid3d({ body, dark: mixRgb(k(body, 0.5), [52, 52, 58], 0.45), head: k(body, 0.62), skin: [222, 178, 138], gun: [40, 40, 46], hat: hatStyle }, pose, view).indexed();
    }
    if (tex) this.m.set(key, tex);
    return tex;
  }

  keys(): string[] {
    return [...this.m.keys()];
  }
}

const mixRgb = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

// ------------------------------------------------------------------ armi in prima persona

/** Le immagini delle armi sono 240x150, con l'origine in basso al centro. */
export const WW = 240, WH = 150;
const SLEEVE: RGB = [66, 78, 60];
const HAND: RGB = [214, 166, 124];

/**
 * Avambraccio che sale dal bordo inferiore fino al polso (wx, wy), con polsino,
 * e dorso della mano chiuso a pugno con le nocche in alto.
 */
function fpArm(p: Paint, bx: number, wx: number, wy: number, r: number, handW: number, handH: number): void {
  const dx = wx - bx, dy = wy - (WH + 30), len = Math.hypot(dx, dy);
  const ux = dx / len, uy = dy / len;
  p.limb(bx, WH + 30, wx - ux * 6, wy - uy * 6, r * 1.25, r, SLEEVE, CLOTH);
  p.limb(wx - ux * 12, wy - uy * 12, wx - ux * 6, wy - uy * 6, r * 1.05, r * 1.02, k(SLEEVE, 0.7), CLOTH); // polsino
  p.limb(wx - ux * 6, wy - uy * 6, wx, wy, r * 0.8, r * 0.85, HAND, SKIN); // polso
  const hx = wx + ux * handH * 0.35, hy = wy + uy * handH * 0.35;
  p.ball(hx, hy, handW / 2, handH / 2, HAND, SKIN);
  // nocche: quattro dita piegate lungo il bordo superiore del pugno
  for (let i = 0; i < 4; i++) {
    const t = (i + 0.5) / 4 - 0.5;
    const nx = hx + t * handW * 0.82, ny = hy - handH * 0.36 + Math.abs(t) * handH * 0.18;
    p.ball(nx, ny, handW * 0.13, handH * 0.17, k(HAND, 1.04), SKIN);
    if (i > 0) p.line(nx - handW * 0.11, ny - 1, nx - handW * 0.1, ny + handH * 0.2, k(HAND, 0.62));
  }
  p.line(hx - handW * 0.15, hy + handH * 0.05, hx - handW * 0.05, hy + handH * 0.3, k(HAND, 0.8)); // tendini
  p.line(hx + handW * 0.12, hy + handH * 0.05, hx + handW * 0.08, hy + handH * 0.3, k(HAND, 0.8));
}

function thumb(p: Paint, x0: number, y0: number, x1: number, y1: number, r = 3.6): void {
  p.limb(x0, y0, x1, y1, r, r * 0.85, k(HAND, 1.02), SKIN);
  p.ball(x1, y1, r * 0.7, r * 0.6, [236, 200, 180], SKIN); // unghia
}

function weaponArt(w: number): Paint {
  const p = new Paint(WW, WH);
  const X = WW / 2, Y = WH; // origine
  const steel: RGB = [72, 76, 86], dark: RGB = [40, 42, 48];
  if (w === 0) {
    // coltello da combattimento impugnato dal basso a destra, lama verso l'alto
    p.box(X + 25, Y - 92, 13, 34, [70, 50, 36], LEATHER, 1); // manico
    for (let i = 0; i < 5; i++) p.line(X + 26, Y - 88 + i * 6, X + 36, Y - 88 + i * 6, [44, 30, 22]);
    p.box(X + 19, Y - 97, 25, 6, [128, 130, 140], METAL, 1); // guardia
    p.poly([X + 25, Y - 97, X + 38, Y - 97, X + 36, Y - 136, X + 31, Y - 148, X + 27, Y - 140], [196, 202, 212], SHINY, 'cyl'); // lama
    p.line(X + 31, Y - 146, X + 31, Y - 99, [255, 255, 255]);
    p.line(X + 27, Y - 138, X + 26, Y - 99, k([196, 202, 212], 0.55));
    fpArm(p, X + 86, X + 36, Y - 46, 15, 34, 30);
    thumb(p, X + 20, Y - 60, X + 33, Y - 66, 4); // pollice sopra le dita
  } else if (w === 1) {
    // pistola semiautomatica tenuta a due mani, vista da dietro
    fpArm(p, X - 74, X - 18, Y - 30, 13, 26, 26);
    fpArm(p, X + 54, X + 4, Y - 34, 15, 34, 30);
    p.poly([X - 12, Y - 78, X + 12, Y - 78, X + 13, Y - 58, X - 13, Y - 58], [36, 36, 40], { grain: 0.3, spec: 0.2 }, 'cyl'); // impugnatura
    p.poly([X - 10, Y - 118, X + 10, Y - 118, X + 15, Y - 76, X - 15, Y - 76], steel, METAL, 'cyl'); // carrello
    for (let i = 0; i < 5; i++) p.line(X - 13 + i, Y - 84 + i * 2, X + 13 - i, Y - 84 + i * 2, k(steel, 0.5)); // zigrinatura
    p.line(X - 9, Y - 112, X - 13, Y - 78, k(steel, 1.8)); // filo di luce
    p.box(X - 10, Y - 123, 6, 6, dark, METAL, 0); p.box(X + 4, Y - 123, 6, 6, dark, METAL, 0); // tacca di mira
    p.plot(X - 7, Y - 120, [240, 240, 240]); p.plot(X + 6, Y - 120, [240, 240, 240]);
    p.box(X - 1, Y - 126, 3, 8, [150, 154, 164], METAL, 0); // mirino
    thumb(p, X + 17, Y - 54, X + 12, Y - 64);
    thumb(p, X - 20, Y - 46, X - 13, Y - 58, 3.2);
  } else if (w === 2) {
    // pistola mitragliatrice: destra sull'impugnatura, sinistra sul caricatore
    fpArm(p, X + 62, X + 16, Y - 30, 15, 34, 30);
    p.limb(X, Y - 142, X, Y - 112, 3.4, 3.8, dark, METAL); // canna
    p.poly([X - 8, Y - 126, X + 8, Y - 126, X + 10, Y - 100, X - 10, Y - 100], [60, 62, 70], METAL, 'cyl'); // manicotto
    for (let y = Y - 122; y < Y - 102; y += 5) { p.ball(X - 4, y, 1.4, 1.4, [10, 10, 12]); p.ball(X + 4, y, 1.4, 1.4, [10, 10, 12]); }
    p.poly([X - 12, Y - 100, X + 12, Y - 100, X + 20, Y - 50, X - 20, Y - 50], steel, METAL, 'cyl'); // castello
    p.line(X - 11, Y - 98, X - 19, Y - 52, k(steel, 1.8));
    p.box(X - 2, Y - 110, 4, 8, [150, 154, 164], METAL, 0); // mirino
    for (let i = 0; i < 7; i++) p.line(X - 9, Y - 96 + i * 4, X + 9, Y - 96 + i * 4, k(steel, 0.55)); // slitta
    p.poly([X - 30, Y - 80, X - 16, Y - 82, X - 24, Y - 30, X - 40, Y - 34], [34, 34, 38], METAL, 'cyl'); // caricatore
    fpArm(p, X - 84, X - 34, Y - 44, 13, 26, 28);
    thumb(p, X - 24, Y - 64, X - 18, Y - 74, 3.4);
    thumb(p, X + 24, Y - 50, X + 18, Y - 60);
  } else {
    // mitragliatrice a canne rotanti
    fpArm(p, X + 76, X + 34, Y - 26, 16, 36, 30);
    for (const i of [-1, 1, 0]) {
      p.poly([X + i * 11 - 5, Y - 146, X + i * 11 + 5, Y - 146, X + i * 15 + 7, Y - 92, X + i * 15 - 7, Y - 92], [86, 90, 100], METAL, 'cyl');
      p.ball(X + i * 11, Y - 146, 5, 2.6, [24, 24, 28]);
    }
    p.poly([X - 24, Y - 124, X + 24, Y - 124, X + 25, Y - 116, X - 25, Y - 116], [120, 124, 134], METAL, 'vcyl'); // fascia
    p.poly([X - 26, Y - 96, X + 26, Y - 96, X + 34, Y - 36, X - 34, Y - 36], [58, 62, 70], METAL, 'cyl'); // corpo
    p.line(X - 25, Y - 94, X - 33, Y - 38, [130, 134, 144]);
    p.box(X - 8, Y - 90, 16, 40, [36, 38, 44], METAL, 1);
    p.box(X + 22, Y - 86, 30, 32, [90, 70, 42], LEATHER, 2); // cassetta
    for (let i = 0; i < 5; i++) p.limb(X + 26 + i * 5, Y - 94, X + 26 + i * 5, Y - 86, 2, 2, BRASS, SHINY);
    p.limb(X - 44, Y - 72, X - 26, Y - 72, 4, 4, [44, 44, 50], METAL); // maniglia laterale
    fpArm(p, X - 92, X - 44, Y - 52, 14, 30, 28);
    thumb(p, X - 36, Y - 64, X - 28, Y - 72, 3.6);
  }
  p.outline(0.5);
  return p;
}

/** Vampa: stella di fuoco riusata per tutte le armi. */
function flashArt(): Paint {
  const p = new Paint(64, 56);
  for (let a = 0; a < 12; a++) {
    const ang = (a / 12) * Math.PI * 2;
    const len = a % 2 ? 16 : 30;
    p.poly([32, 28, 32 + Math.cos(ang - 0.25) * 9, 28 + Math.sin(ang - 0.25) * 8, 32 + Math.cos(ang) * len, 28 + Math.sin(ang) * len * 0.85, 32 + Math.cos(ang + 0.25) * 9, 28 + Math.sin(ang + 0.25) * 8], FIRE_OUT, { amb: 1, dif: 0 });
  }
  p.ball(32, 28, 13, 11, [255, 196, 64], { amb: 1, dif: 0 });
  p.ball(32, 28, 7, 6, FIRE_IN, { amb: 1, dif: 0 });
  return p;
}

/** Arma in prima persona come indici di palette (WW x WH, per colonne); usata anche dagli script. */
export const weaponIndexed = (w: number): Uint8Array => weaponArt(w).indexed(10);
/** Vampa 64x56 come indici di palette. */
export const flashIndexed = (): Uint8Array => flashArt().indexed(6);

let weaponCanvases: HTMLCanvasElement[] | null = null;
let flashCanvas: HTMLCanvasElement | null = null;
/** quota della bocca dell'arma rispetto al fondo dell'immagine, e scala della vampa */
export const MUZZLE: readonly [number, number][] = [[0, 0], [-122, 0.8], [-142, 1], [-148, 1.35]];

/** Disegna l'arma impugnata sul canvas a bassa risoluzione. */
export function drawWeapon(ctx: CanvasRenderingContext2D, w: number, firing: boolean, W: number, H: number, bobX: number, bobY: number): void {
  if (!weaponCanvases) {
    weaponCanvases = [0, 1, 2, 3].map((i) => indexedToCanvas(weaponIndexed(i), WW, WH));
    flashCanvas = indexedToCanvas(flashIndexed(), 64, 56);
  }
  // scala rispetto all'altezza di riferimento di 270 righe, un po' ridotta per lasciare libero il centro
  const sc = (H / 270) * 0.82;
  const cx = Math.round(W / 2 + bobX);
  // un po' sopra il fondo: la barra dell'HUD copre l'ultima fascia dello schermo
  const by = Math.round(H + bobY - H * 0.05);
  let ox = 0, oy = 0;
  if (w === 0 && firing) { ox = -16; oy = -28; } // affondo
  ctx.imageSmoothingEnabled = false;
  if (w > 0 && firing) {
    const [my, s] = MUZZLE[w];
    const fw = Math.round(64 * s * sc), fh = Math.round(56 * s * sc);
    ctx.drawImage(flashCanvas!, Math.round(cx - fw / 2), Math.round(by + my * sc - fh / 2), fw, fh);
    oy = 3; // rinculo
  }
  const iw = Math.round(WW * sc), ih = Math.round(WH * sc);
  ctx.drawImage(weaponCanvases[w] ?? weaponCanvases[1], Math.round(cx - iw / 2 + ox * sc), Math.round(by - ih + oy * sc), iw, ih);
}
