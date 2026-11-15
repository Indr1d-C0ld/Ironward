// Genera le immagini del README direttamente dal motore, senza browser:
// scene di gioco renderizzate dal raycaster e tavole di sprite, armi, texture e palette.
// Uso: node tools/screenshots.ts [cartella]   (default docs/images)

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readPng } from './png.ts';
import { wallTextures } from '../client/atlas.ts';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { generateLevel, type Level, type Room } from '../shared/level.ts';
import { PLAYER_COLORS, TEAMS, type GameMode } from '../shared/defs.ts';
import {
  buildTextures, enemySpriteKey, flashIndexed, HAT_STYLES, MUZZLE, playerSpriteKey, POSES, SpriteBank, SS, TS,
  viewIndex, VIEWS, weaponIndexed, WH, WW, type Pose,
} from '../client/art.ts';
import { PALETTE } from '../client/palette.ts';
import { seedFromString } from '../shared/rng.ts';

// Il renderer usa solo createImageData/putImageData: basta una tela finta.
(globalThis as unknown as { document: unknown }).document = {
  createElement: () => ({
    width: 0, height: 0,
    getContext: () => ({
      createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
      putImageData: () => undefined,
    }),
  }),
};
const { Renderer } = await import('../client/render.ts');

const OUT = resolve(process.argv[2] ?? fileURLToPath(new URL('../docs/images', import.meta.url)));
mkdirSync(OUT, { recursive: true });

// ------------------------------------------------------------------ PNG

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** RGBA -> PNG, ingrandito di `scale` volte senza smussare. */
function png(rgba: Uint8Array, w: number, h: number, scale = 1): Buffer {
  const W = w * scale, H = h * scale;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 4 + 1);
    raw[row] = 0;
    const sy = Math.floor(y / scale);
    for (let x = 0; x < W; x++) {
      const si = (sy * w + Math.floor(x / scale)) * 4, di = row + 1 + x * 4;
      raw[di] = rgba[si]; raw[di + 1] = rgba[si + 1]; raw[di + 2] = rgba[si + 2]; raw[di + 3] = rgba[si + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())]);
}
function save(name: string, rgba: Uint8Array, w: number, h: number, scale: number): void {
  const file = join(OUT, name);
  const data = png(rgba, w, h, scale);
  writeFileSync(file, data);
  console.log(`${name}: ${w * scale}x${h * scale}, ${(data.length / 1024).toFixed(0)} KB`);
}

// ------------------------------------------------------------------ tavole

const BG: [number, number, number] = [58, 63, 71];
class Sheet {
  readonly w: number;
  readonly h: number;
  readonly px: Uint8Array;
  constructor(w: number, h: number, bg = BG) {
    this.w = w; this.h = h;
    this.px = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) { this.px[i * 4] = bg[0]; this.px[i * 4 + 1] = bg[1]; this.px[i * 4 + 2] = bg[2]; this.px[i * 4 + 3] = 255; }
  }
  /** Disegna un'immagine indicizzata per colonne (alto `ih`). */
  blit(idx: Uint8Array | Uint32Array, iw: number, ih: number, ox: number, oy: number): void {
    ox = Math.round(ox); oy = Math.round(oy);
    for (let x = 0; x < iw; x++) {
      for (let y = 0; y < ih; y++) {
        const v = idx[x * ih + y];
        const X = ox + x, Y = oy + y;
        if (!v || X < 0 || Y < 0 || X >= this.w || Y >= this.h) continue;
        const i = (Y * this.w + X) * 4;
        if (idx instanceof Uint32Array) { this.px[i] = v & 255; this.px[i + 1] = (v >>> 8) & 255; this.px[i + 2] = (v >>> 16) & 255; continue; }
        this.px[i] = PALETTE[v * 3]; this.px[i + 1] = PALETTE[v * 3 + 1]; this.px[i + 2] = PALETTE[v * 3 + 2];
      }
    }
  }
}

const bank = new SpriteBank();
// sprite e armi PixelLab, se l'atlante è stato costruito (npm run sprites)
const SPR = fileURLToPath(new URL('../client/sprites/', import.meta.url));
let meta: { muzzle: number[]; muzzleX?: number[]; weapons: string[] } | null = null;
let pixWalls = new Map<number, Uint32Array>();
if (existsSync(join(SPR, 'atlas.json'))) {
  const m = JSON.parse(readFileSync(join(SPR, 'atlas.json'), 'utf8'));
  const img = readPng(join(SPR, 'atlas.png'));
  bank.setAtlas({ ...m, rgba: img.px, width: img.w });
  meta = m;
  if (m.walls?.length) {
    const w = readPng(join(SPR, 'walls.png'));
    pixWalls = wallTextures(m, w.px, w.w);
  }
}
/** Arma in prima persona per colonne: PixelLab (ABGR) o procedurale (indici). */
function weaponTex(w: number): Uint8Array | Uint32Array {
  if (!meta || meta.weapons.length < 4) return weaponIndexed(w);
  const img = readPng(join(SPR, meta.weapons[w]));
  const out = new Uint32Array(WW * WH);
  for (let x = 0; x < Math.min(WW, img.w); x++) for (let y = 0; y < Math.min(WH, img.h); y++) {
    const i = (y * img.w + x) * 4;
    if (img.px[i + 3] >= 128) out[x * WH + y] = (0xff000000 | (img.px[i + 2] << 16) | (img.px[i + 1] << 8) | img.px[i]) >>> 0;
  }
  return out;
}
const muzzleOf = (w: number) => meta?.muzzle[w] ?? MUZZLE[w][0];
const muzzleXOf = (w: number) => meta?.muzzleX?.[w] ?? 0;
const sheetOf = (keys: (string | null)[][], cell = SS, gap = 4): Sheet => {
  const cols = Math.max(...keys.map((r) => r.length));
  const sh = new Sheet(cols * (cell + gap) + gap, keys.length * (cell + gap) + gap);
  keys.forEach((row, r) => row.forEach((k, c) => { if (k) sh.blit(bank.get(k)!, SS, SS, gap + c * (cell + gap) + (cell - SS) / 2, gap + r * (cell + gap) + (cell - SS)); }));
  return sh;
};

// 8 viste: soldato che cammina, assaltatore in mira, mastino, giocatore con il basco
{
  const rows = [
    Array.from({ length: VIEWS }, (_, v) => enemySpriteKey('guard', 'walk1', v)),
    Array.from({ length: VIEWS }, (_, v) => enemySpriteKey('trooper', 'aim', v)),
    Array.from({ length: VIEWS }, (_, v) => enemySpriteKey('hound', 'walk2', v)),
    Array.from({ length: VIEWS }, (_, v) => playerSpriteKey(1, 1, 'stand', v)),
  ];
  const sh = sheetOf(rows);
  save('sprite-8-viste.png', sh.px, sh.w, sh.h, 2);
}
// pose
{
  const rows = (['guard', 'trooper', 'officer', 'hound'] as const).map((k) => POSES.map((p) => enemySpriteKey(k, p, 1)));
  const sh = sheetOf(rows);
  save('sprite-pose.png', sh.px, sh.w, sh.h, 2);
}
// giocatori: 8 colori e 5 copricapi
{
  const rows = [
    PLAYER_COLORS.map((_, c) => playerSpriteKey(c, 0, 'stand', 0)),
    HAT_STYLES.map((_, h) => playerSpriteKey([0, 2, 4, 5, 6][h], h, 'walk1', 1)),
  ];
  const sh = sheetOf(rows);
  save('giocatori.png', sh.px, sh.w, sh.h, 2);
}
// oggetti e squadre
{
  const rows = [
    ['medkit', 'food', 'ammo', 'clip', 'smg', 'chaingun', 'coins', 'gem'].map((k) => `item:${k}`),
    ['base0', 'flag0', 'flagc0', 'base1', 'flag1', 'flagc1', 'item:vest', 'item:key'],
    ['item:grenade', 'proj:grenade', 'fx:boom0', 'fx:boom1', 'fx:boom2', 'fx:boom3'],
  ];
  const sh = sheetOf(rows);
  save('oggetti.png', sh.px, sh.w, sh.h, 2);
}
// armi in prima persona, ferme e mentre sparano
{
  const gap = 6;
  const sh = new Sheet(4 * (WW + gap) + gap, 2 * (WH + 40 + gap) + gap);
  const flash = flashIndexed();
  for (let w = 0; w < 4; w++) {
    const img = weaponTex(w);
    for (let f = 0; f < 2; f++) {
      const ox = gap + w * (WW + gap), oy = gap + f * (WH + 40 + gap) + 40;
      sh.blit(img, WW, WH, ox + (f && w === 0 ? -16 : 0), oy + (f && w === 0 ? -28 : f ? 3 : 0));
      if (f && w > 0) {
        // vampa più piccola e ridimensionata come in gioco
        const s = MUZZLE[w][1], my = muzzleOf(w);
        const fw = Math.round(64 * s), fh = Math.round(56 * s);
        const scaled = new Uint8Array(fw * fh);
        for (let x = 0; x < fw; x++) for (let y = 0; y < fh; y++) scaled[x * fh + y] = flash[Math.floor((x * 64) / fw) * 56 + Math.floor((y * 56) / fh)];
        sh.blit(scaled, fw, fh, ox + WW / 2 + muzzleXOf(w) - fw / 2, oy + WH + my - fh * 0.45);
      }
    }
  }
  save('armi.png', sh.px, sh.w, sh.h, 2);
}
// texture delle pareti
{
  const tex: (Uint8Array | Uint32Array)[] = buildTextures();
  for (const [t, w] of pixWalls) tex[t] = w;
  const gap = 4, cols = 8;
  const n = tex.length - 1;
  const sh = new Sheet(cols * (TS + gap) + gap, Math.ceil(n / cols) * (TS + gap) + gap, [13, 15, 18]);
  for (let i = 1; i < tex.length; i++) sh.blit(tex[i], TS, TS, gap + ((i - 1) % cols) * (TS + gap), gap + Math.floor((i - 1) / cols) * (TS + gap));
  save('texture.png', sh.px, sh.w, sh.h, 3);
}
// palette: 16 rampe da 16 colori
{
  const sh = new Sheet(16, 16);
  for (let i = 0; i < 256; i++) { sh.px[i * 4] = PALETTE[i * 3]; sh.px[i * 4 + 1] = PALETTE[i * 3 + 1]; sh.px[i * 4 + 2] = PALETTE[i * 3 + 2]; }
  save('palette.png', sh.px, 16, 16, 20);
}

// ------------------------------------------------------------------ scene di gioco

const textures: (Uint8Array | Uint32Array)[] = buildTextures();
for (const [t, tex] of pixWalls) textures[t] = tex;
interface Spr { x: number; y: number; key: string; }
interface Scene { file: string; mode: GameMode; seed: string; cam: (lvl: Level) => { x: number; y: number; a: number }; sprites: (lvl: Level, cam: { x: number; y: number }) => Spr[]; weapon: number; firing?: boolean; }

const center = (r: Room) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const inRoom = (r: Room, x: number, y: number) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
/** La stanza con più nemici, con la telecamera in un angolo che guarda verso il centro. */
function busiestRoom(lvl: Level): Room {
  return [...lvl.rooms].filter((r) => r.w >= 7 && r.h >= 7)
    .sort((a, b) => lvl.enemies.filter((e) => inRoom(b, e.x, e.y)).length - lvl.enemies.filter((e) => inRoom(a, e.x, e.y)).length)[0];
}
const look = (x: number, y: number, tx: number, ty: number) => ({ x, y, a: Math.atan2(ty - y, tx - x) });
const poses: Pose[] = ['stand', 'aim', 'walk1', 'fire', 'walk2', 'stand', 'aim'];

const scenes: Scene[] = [
  {
    file: 'gioco-cooperativa.png', mode: 'coop', seed: 'readme-1', weapon: 2, firing: true,
    cam: (lvl) => { const r = busiestRoom(lvl); const c = center(r); return look(r.x + 0.7, r.y + r.h - 0.7, c.x + 1, c.y - 1); },
    sprites: (lvl, cam) => [
      ...lvl.items.map((i) => ({ x: i.x, y: i.y, key: `item:${i.kind}` })),
      ...lvl.enemies.map((e, i) => {
        // i nemici guardano la telecamera, come quando danno l'allarme
        const a = Math.atan2(cam.y - e.y, cam.x - e.x) + (i % 3 - 1) * 0.6;
        return { x: e.x, y: e.y, key: enemySpriteKey(e.kind, poses[i % poses.length], viewIndex(a, e.x, e.y, cam.x, cam.y)) };
      }),
    ],
  },
  {
    file: 'gioco-cattura.png', mode: 'ctf', seed: 'readme-2', weapon: 1,
    cam: (lvl) => {
      const b = lvl.bases[1];
      const r = lvl.rooms.find((q) => inRoom(q, b.x, b.y))!;
      const corners = [[r.x + 0.7, r.y + 0.7], [r.x + r.w - 0.7, r.y + 0.7], [r.x + 0.7, r.y + r.h - 0.7], [r.x + r.w - 0.7, r.y + r.h - 0.7]];
      const [x, y] = corners.sort((p, q) => Math.hypot(q[0] - b.x, q[1] - b.y) - Math.hypot(p[0] - b.x, p[1] - b.y))[0];
      const c = look(x, y, b.x, b.y);
      return { ...c, a: c.a + 0.3 }; // la base un po' di lato, non dietro l'arma
    },
    sprites: (lvl, cam) => {
      const b = lvl.bases[1];
      const out: Spr[] = [
        { x: b.x, y: b.y, key: 'base1' }, { x: b.x + 0.01, y: b.y + 0.01, key: 'flag1' },
        ...lvl.items.map((i) => ({ x: i.x, y: i.y, key: `item:${i.kind}` })),
      ];
      // difensori Cobalto attorno alla base
      const def: [number, number, Pose, number][] = [[-1.6, 1.2, 'aim', 1], [1.4, -1.5, 'walk1', 4], [1.8, 1.4, 'fire', 0]];
      for (const [dx, dy, pose, hat] of def) {
        const x = b.x + dx, y = b.y + dy;
        if (lvl.walls[Math.floor(y) * lvl.w + Math.floor(x)]) continue;
        const a = Math.atan2(cam.y - y, cam.x - x) + (pose === 'walk1' ? 1.4 : 0);
        out.push({ x, y, key: playerSpriteKey(TEAMS[1].color, hat, pose, viewIndex(a, x, y, cam.x, cam.y)) });
      }
      return out;
    },
  },
  {
    file: 'gioco-deathmatch.png', mode: 'dm', seed: 'readme-3', weapon: 3, firing: true,
    cam: (lvl) => { const r = [...lvl.rooms].sort((a, b) => b.w * b.h - a.w * a.h)[0]; const c = center(r); return look(r.x + 0.7, r.y + 0.7, c.x + 2, c.y + 1); },
    sprites: (lvl, cam) => {
      const r = [...lvl.rooms].sort((a, b) => b.w * b.h - a.w * a.h)[0];
      const c = center(r);
      const out: Spr[] = lvl.items.map((i) => ({ x: i.x, y: i.y, key: `item:${i.kind}` }));
      const ps: [number, number, number, number, Pose, number][] = [[2, -1.5, 0, 2, 'walk1', 1.6], [3.5, 1.4, 6, 3, 'aim', 0], [5.5, -0.4, 4, 4, 'fire', 0.3], [1.2, 2.2, 2, 1, 'dead', 0]];
      for (const [dx, dy, color, hat, pose, turn] of ps) {
        const x = c.x + dx, y = c.y + dy;
        const a = Math.atan2(cam.y - y, cam.x - x) + turn;
        out.push({ x, y, key: playerSpriteKey(color, hat, pose, viewIndex(a, x, y, cam.x, cam.y)) });
      }
      return out;
    },
  },
];

const W = 480, H = 270;
for (const sc of scenes) {
  const lvl = generateLevel(seedFromString(sc.seed), sc.mode);
  const r = new Renderer(W, H, 2 * Math.atan(Math.tan((52 * Math.PI) / 360) * (W / H)) * 180 / Math.PI, textures, bank);
  const cam = sc.cam(lvl);
  const doorOpen = new Float32Array(lvl.doors.length);
  r.render(cam, lvl, doorOpen, sc.sprites(lvl, cam), sc.firing ? 1 : 0);
  const rgba = new Uint8Array((r as unknown as { img: { data: Uint8ClampedArray } }).img.data.buffer.slice(0));
  // arma in prima persona, scalata come in drawWeapon
  const sheet = { w: W, h: H, px: rgba };
  const s = (H / 270) * 0.82;
  const iw = Math.round(WW * s), ih = Math.round(WH * s);
  const cx = W / 2, by = H + 2; // senza HUD l'arma poggia sul bordo inferiore
  const put = (idx: Uint8Array | Uint32Array, sw: number, sh: number, ox: number, oy: number, dw: number, dh: number) => {
    for (let x = 0; x < dw; x++) {
      for (let y = 0; y < dh; y++) {
        const v = idx[Math.floor((x * sw) / dw) * sh + Math.floor((y * sh) / dh)];
        const X = ox + x, Y = oy + y;
        if (!v || X < 0 || Y < 0 || X >= W || Y >= H) continue;
        const i = (Y * W + X) * 4;
        if (idx instanceof Uint32Array) { sheet.px[i] = v & 255; sheet.px[i + 1] = (v >>> 8) & 255; sheet.px[i + 2] = (v >>> 16) & 255; sheet.px[i + 3] = 255; continue; }
        sheet.px[i] = PALETTE[v * 3]; sheet.px[i + 1] = PALETTE[v * 3 + 1]; sheet.px[i + 2] = PALETTE[v * 3 + 2]; sheet.px[i + 3] = 255;
      }
    }
  };
  put(weaponTex(sc.weapon), WW, WH, Math.round(cx - iw / 2), Math.round(by - ih + (sc.firing ? 3 * s : 0)), iw, ih);
  if (sc.firing) {
    const fs = MUZZLE[sc.weapon][1], my = muzzleOf(sc.weapon);
    const fw = Math.round(64 * fs * s), fh = Math.round(56 * fs * s);
    put(flashIndexed(), 64, 56, Math.round(cx + muzzleXOf(sc.weapon) * s - fw / 2), Math.round(by + my * s - fh * 0.45), fw, fh);
  }
  save(sc.file, rgba, W, H, 3);
}
