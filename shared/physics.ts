// Collisioni, movimento e raycast DDA condivisi: il server li usa come autorità,
// il client per la predizione del movimento e per il rendering.

import { type Level, TEX_DOOR, TEX_DOOR_JAMB } from './level.ts';
import { INPUT_DT, PLAYER_RADIUS, PLAYER_SPEED, clamp } from './defs.ts';
import type { InputCmd } from './protocol.ts';

export function cellBlocks(level: Level, doorOpen: Float32Array, cx: number, cy: number): boolean {
  if (cx < 0 || cy < 0 || cx >= level.w || cy >= level.h) return true;
  const i = cy * level.w + cx;
  if (level.walls[i] !== 0) return true;
  const d = level.doorAt[i];
  if (d >= 0) return doorOpen[d] < (level.doors[d].secret ? 1 : 0.9);
  return false;
}

export function collides(level: Level, doorOpen: Float32Array, x: number, y: number, r: number): boolean {
  const x0 = Math.floor(x - r), x1 = Math.floor(x + r);
  const y0 = Math.floor(y - r), y1 = Math.floor(y + r);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (cellBlocks(level, doorOpen, cx, cy)) return true;
    }
  }
  return false;
}

export interface Pos { x: number; y: number; }

/** Movimento con collisione separata sugli assi: si scivola lungo le pareti. */
export function moveWithCollision(level: Level, doorOpen: Float32Array, p: Pos, dx: number, dy: number, r: number): void {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 0.2));
  const sx = dx / steps, sy = dy / steps;
  for (let i = 0; i < steps; i++) {
    const nx = p.x + sx;
    if (!collides(level, doorOpen, nx, p.y, r)) p.x = nx;
    const ny = p.y + sy;
    if (!collides(level, doorOpen, p.x, ny, r)) p.y = ny;
  }
}

/** Applica un comando di input a un giocatore. Identico su client e server. */
export function applyPlayerInput(level: Level, doorOpen: Float32Array, p: Pos & { a: number }, cmd: InputCmd): void {
  p.a = cmd.a;
  let f = clamp(cmd.f, -1, 1), s = clamp(cmd.s, -1, 1);
  const len = Math.hypot(f, s);
  if (len > 1) { f /= len; s /= len; }
  if (f === 0 && s === 0) return;
  const c = Math.cos(p.a), sn = Math.sin(p.a);
  const k = PLAYER_SPEED * INPUT_DT;
  moveWithCollision(level, doorOpen, p, (c * f - sn * s) * k, (sn * f + c * s) * k, PLAYER_RADIUS);
}

export interface RayHit {
  /** distanza in unità della lunghezza di (dx, dy); con raggi non normalizzati è la distanza perpendicolare */
  dist: number;
  tex: number;
  /** coordinata orizzontale nella texture, 0..1 */
  u: number;
  side: number;
  door: number;
  cx: number;
  cy: number;
}

export function newRayHit(): RayHit {
  return { dist: 0, tex: 0, u: 0, side: 0, door: -1, cx: 0, cy: 0 };
}

/**
 * Raycast DDA sulla griglia. Le porte normali sono un piano a metà cella che
 * scorre lateralmente; le pareti segrete sono celle piene finché non sono aperte.
 * Restituisce true se colpisce qualcosa entro maxDist.
 */
export function castRay(level: Level, doorOpen: Float32Array, ox: number, oy: number, dx: number, dy: number, maxDist: number, out: RayHit): boolean {
  const W = level.w, H = level.h;
  let mapX = Math.floor(ox), mapY = Math.floor(oy);
  const ddx = dx === 0 ? 1e30 : Math.abs(1 / dx);
  const ddy = dy === 0 ? 1e30 : Math.abs(1 / dy);
  let stepX: number, stepY: number, sideX: number, sideY: number;
  if (dx < 0) { stepX = -1; sideX = (ox - mapX) * ddx; } else { stepX = 1; sideX = (mapX + 1 - ox) * ddx; }
  if (dy < 0) { stepY = -1; sideY = (oy - mapY) * ddy; } else { stepY = 1; sideY = (mapY + 1 - oy) * ddy; }
  let t = 0;
  for (let i = 0; i < 256; i++) {
    // Porta nella cella corrente: intersezione con il piano centrale.
    if (mapX >= 0 && mapY >= 0 && mapX < W && mapY < H) {
      const di = level.doorAt[mapY * W + mapX];
      if (di >= 0 && !level.doors[di].secret) {
        const door = level.doors[di];
        const open = doorOpen[di];
        const tExit = Math.min(sideX, sideY);
        let tp = -1, along = 0;
        if (door.ew) { if (dx !== 0) { tp = (mapX + 0.5 - ox) / dx; along = oy + tp * dy - mapY; } }
        else if (dy !== 0) { tp = (mapY + 0.5 - oy) / dy; along = ox + tp * dx - mapX; }
        if (tp >= t && tp <= tExit && along >= open && along <= 1) {
          if (tp > maxDist) { out.dist = maxDist; return false; }
          out.dist = tp; out.tex = TEX_DOOR; out.u = along - open; out.side = door.ew ? 0 : 1;
          out.door = di; out.cx = mapX; out.cy = mapY;
          return true;
        }
      }
    }
    let side: number;
    if (sideX < sideY) { t = sideX; sideX += ddx; mapX += stepX; side = 0; }
    else { t = sideY; sideY += ddy; mapY += stepY; side = 1; }
    if (t > maxDist) { out.dist = maxDist; return false; }
    if (mapX < 0 || mapY < 0 || mapX >= W || mapY >= H) {
      out.dist = t; out.tex = 1; out.u = 0; out.side = side; out.door = -1; out.cx = mapX; out.cy = mapY;
      return true;
    }
    const ni = mapY * W + mapX;
    let tex = level.walls[ni];
    const nd = level.doorAt[ni];
    if (tex === 0 && nd >= 0 && level.doors[nd].secret && doorOpen[nd] < 1) tex = level.doors[nd].tex;
    if (tex !== 0) {
      let u = side === 0 ? oy + t * dy : ox + t * dx;
      u -= Math.floor(u);
      if ((side === 0 && dx > 0) || (side === 1 && dy < 0)) u = 1 - u;
      const pi = side === 0 ? mapY * W + (mapX - stepX) : (mapY - stepY) * W + mapX;
      const pd = level.doorAt[pi];
      if (pd >= 0 && !level.doors[pd].secret) tex = TEX_DOOR_JAMB;
      out.dist = t; out.tex = tex; out.u = u; out.side = side; out.door = nd; out.cx = mapX; out.cy = mapY;
      return true;
    }
  }
  out.dist = maxDist;
  return false;
}

const losHit = newRayHit();
export function lineOfSight(level: Level, doorOpen: Float32Array, x0: number, y0: number, x1: number, y1: number): boolean {
  const dx = x1 - x0, dy = y1 - y0;
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return true;
  return !castRay(level, doorOpen, x0, y0, dx / d, dy / d, d, losHit);
}

/** Celle percorribili dai nemici: le porte chiuse sì (le aprono), i passaggi segreti no. */
export function walkable(level: Level, doorOpen: Float32Array, i: number): boolean {
  if (level.walls[i] !== 0) return false;
  const d = level.doorAt[i];
  return d < 0 || !level.doors[d].secret || doorOpen[d] >= 1;
}

/** Campo di distanze BFS multi-sorgente (sorgenti = celle dei giocatori). */
export function distanceField(level: Level, doorOpen: Float32Array, sources: number[], out: Int16Array, queue: Int32Array): void {
  out.fill(-1);
  let head = 0, tail = 0;
  for (const s of sources) {
    if (out[s] !== 0) { out[s] = 0; queue[tail++] = s; }
  }
  const W = level.w;
  while (head < tail) {
    const c = queue[head++];
    const d = out[c] + 1;
    const n0 = c + 1, n1 = c - 1, n2 = c + W, n3 = c - W;
    if (out[n0] < 0 && walkable(level, doorOpen, n0)) { out[n0] = d; queue[tail++] = n0; }
    if (out[n1] < 0 && walkable(level, doorOpen, n1)) { out[n1] = d; queue[tail++] = n1; }
    if (out[n2] < 0 && walkable(level, doorOpen, n2)) { out[n2] = d; queue[tail++] = n2; }
    if (out[n3] < 0 && walkable(level, doorOpen, n3)) { out[n3] = d; queue[tail++] = n3; }
  }
}
