// Raycaster software su ImageData a bassa risoluzione, poi scalato senza smoothing.
// Texture e sprite sono indici di palette: la luce passa dalle colormap, a scalini
// come nei giochi VGA.

import { THEMES, type Level } from '../shared/level.ts';
import { castRay, newRayHit } from '../shared/physics.ts';
import { SS, TS } from './art.ts';
import { COLORMAP, LIGHT_MUL, lightLevel, nearest } from './palette.ts';

/** Sprite: indici di palette (procedurali) oppure ABGR a colori pieni (PixelLab). */
export type SpriteTex = Uint8Array | Uint32Array;

export interface Camera { x: number; y: number; a: number; }
export interface SpriteInst { x: number; y: number; key: string; dist?: number; }

const FOG_DIST = 15;

export class Renderer {
  readonly W: number;
  readonly H: number;
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  private img: ImageData;
  private buf: Uint32Array;
  readonly zbuf: Float32Array;
  readonly proj: number;
  readonly planeLen: number;
  private rowColor = new Uint32Array(0);
  private rowTheme = -1;
  private hit = newRayHit();
  private textures: (Uint8Array | Uint32Array)[];
  private sprites: { get(key: string): SpriteTex | undefined };

  constructor(W: number, H: number, fovDeg: number, textures: (Uint8Array | Uint32Array)[], sprites: { get(key: string): SpriteTex | undefined }) {
    this.W = W;
    this.H = H;
    this.canvas = document.createElement('canvas');
    this.canvas.width = W;
    this.canvas.height = H;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(W, H);
    this.buf = new Uint32Array(this.img.data.buffer);
    this.zbuf = new Float32Array(W);
    this.planeLen = Math.tan((fovDeg * Math.PI) / 360);
    this.proj = W / 2 / this.planeLen;
    this.textures = textures;
    this.sprites = sprites;
  }

  private fog(d: number): number {
    return Math.max(0.18, Math.min(1, 1.15 - d / FOG_DIST));
  }

  private buildRows(themeIdx: number): void {
    const th = THEMES[themeIdx];
    const H = this.H;
    this.rowColor = new Uint32Array(H);
    const half = H / 2;
    for (let y = 0; y < H; y++) {
      const isCeil = y < half;
      const dy = isCeil ? half - y : y - half + 1;
      const dist = (this.proj * 0.5) / Math.max(0.5, dy);
      const c = isCeil ? th.ceil : th.floor;
      const k = this.fog(dist) * (isCeil ? 0.9 : 1);
      this.rowColor[y] = COLORMAP[lightLevel(k) * 256 + nearest(c[0], c[1], c[2])];
    }
    this.rowTheme = themeIdx;
  }

  render(cam: Camera, level: Level, doorOpen: Float32Array, sprites: SpriteInst[], flash: number): void {
    const { W, H, buf, zbuf } = this;
    if (this.rowTheme !== level.theme || this.rowColor.length !== H) this.buildRows(level.theme);
    for (let y = 0; y < H; y++) buf.fill(this.rowColor[y], y * W, (y + 1) * W);

    const dirX = Math.cos(cam.a), dirY = Math.sin(cam.a);
    const planeX = -dirY * this.planeLen, planeY = dirX * this.planeLen;
    const hit = this.hit;
    const half = H / 2;
    const bright = 1 + flash * 0.35;

    // Pareti
    for (let x = 0; x < W; x++) {
      const camX = (2 * (x + 0.5)) / W - 1;
      const rdx = dirX + planeX * camX, rdy = dirY + planeY * camX;
      if (!castRay(level, doorOpen, cam.x, cam.y, rdx, rdy, 64, hit)) { zbuf[x] = 1e9; continue; }
      const perp = Math.max(0.01, hit.dist);
      zbuf[x] = perp;
      const lineH = this.proj / perp;
      const top = half - lineH / 2;
      const tex = this.textures[hit.tex] ?? this.textures[1];
      const fullWall = tex instanceof Uint32Array;
      const tx = Math.min(TS - 1, (hit.u * TS) | 0) * TS;
      const cm = lightLevel(this.fog(perp) * (hit.side ? 0.78 : 1) * bright) * 256;
      const y0 = Math.max(0, Math.ceil(top)), y1 = Math.min(H, Math.ceil(top + lineH));
      const step = TS / lineH;
      let ty = (y0 - top) * step;
      for (let y = y0; y < y1; y++) {
        const c = tex[tx + ((ty | 0) & (TS - 1))];
        ty += step;
        buf[y * W + x] = fullWall
          ? (0xff000000 | (LIGHT_MUL[cm + ((c >>> 16) & 255)] << 16) | (LIGHT_MUL[cm + ((c >>> 8) & 255)] << 8) | LIGHT_MUL[cm + (c & 255)]) >>> 0
          : COLORMAP[cm + c];
      }
    }

    // Sprite, dal più lontano al più vicino
    const invDet = 1 / (planeX * dirY - dirX * planeY);
    for (const s of sprites) s.dist = (s.x - cam.x) ** 2 + (s.y - cam.y) ** 2;
    sprites.sort((a, b) => b.dist! - a.dist!);
    for (const s of sprites) {
      const tex = this.sprites.get(s.key);
      if (!tex) continue;
      const rx = s.x - cam.x, ry = s.y - cam.y;
      const tX = invDet * (dirY * rx - dirX * ry);
      const tY = invDet * (-planeY * rx + planeX * ry);
      if (tY < 0.15) continue;
      const screenX = (W / 2) * (1 + tX / tY);
      const size = this.proj / tY;
      const left = screenX - size / 2;
      const top = half - size / 2;
      const x0 = Math.max(0, Math.ceil(left)), x1 = Math.min(W, Math.ceil(left + size));
      const y0 = Math.max(0, Math.ceil(top)), y1 = Math.min(H, Math.ceil(top + size));
      if (x0 >= x1) continue;
      const step = SS / size;
      const cm = lightLevel(this.fog(tY) * bright) * 256;
      const full = tex instanceof Uint32Array;
      for (let x = x0; x < x1; x++) {
        if (tY >= zbuf[x]) continue;
        const col = Math.min(SS - 1, ((x - left) * step) | 0) * SS;
        let ty = (y0 - top) * step;
        for (let y = y0; y < y1; y++) {
          const c = tex[col + Math.min(SS - 1, ty | 0)];
          ty += step;
          if (!c) continue;
          buf[y * W + x] = full
            ? (0xff000000 | (LIGHT_MUL[cm + ((c >>> 16) & 255)] << 16) | (LIGHT_MUL[cm + ((c >>> 8) & 255)] << 8) | LIGHT_MUL[cm + (c & 255)]) >>> 0
            : COLORMAP[cm + c];
        }
      }
    }
    this.ctx.putImageData(this.img, 0, 0);
  }
}
