// Generatore procedurale di livelli su griglia 64x64.
// Deterministico: stesso seed e stessa modalità producono la stessa mappa
// sul server e su ogni client, quindi in rete viaggia solo il seed.

import { mulberry32, randInt, pick, weighted, type Rng } from './rng.ts';
import type { EnemyKind, GameMode, ItemKind } from './defs.ts';

export const MAP_W = 64;
export const MAP_H = 64;

// Indici delle texture di parete (0 = cella vuota).
export const TEX_STONE = 1;
export const TEX_STONE_MOSS = 2;
export const TEX_CONCRETE = 3;
export const TEX_CONCRETE_STRIPE = 4;
export const TEX_WOOD = 5;
export const TEX_WOOD_PANEL = 6;
export const TEX_METAL = 7;
export const TEX_METAL_RIVET = 8;
export const TEX_BRICK = 9;
export const TEX_BRICK_DARK = 10;
export const TEX_TILE = 11;
export const TEX_TILE_GRIME = 12;
export const TEX_EXIT = 13;
export const TEX_DOOR = 14;
export const TEX_DOOR_JAMB = 15;
/** porta blindata della stanza d'uscita, si apre con la tessera */
export const TEX_LOCKED = 16;
export const TEX_COUNT = 17;

export interface Theme {
  name: string;
  base: number;
  walls: readonly number[];
  ceil: readonly [number, number, number];
  floor: readonly [number, number, number];
}

export const THEMES: readonly Theme[] = [
  { name: 'Fortezza', base: TEX_STONE, walls: [TEX_STONE, TEX_STONE_MOSS, TEX_BRICK], ceil: [56, 54, 62], floor: [96, 90, 80] },
  { name: 'Bunker', base: TEX_CONCRETE, walls: [TEX_CONCRETE, TEX_CONCRETE_STRIPE, TEX_METAL], ceil: [42, 46, 44], floor: [74, 78, 70] },
  { name: 'Archivio', base: TEX_BRICK_DARK, walls: [TEX_WOOD, TEX_WOOD_PANEL, TEX_BRICK_DARK], ceil: [60, 50, 42], floor: [88, 66, 50] },
  { name: 'Laboratorio', base: TEX_METAL_RIVET, walls: [TEX_TILE, TEX_TILE_GRIME, TEX_METAL_RIVET], ceil: [70, 76, 80], floor: [64, 70, 76] },
];

export interface Door {
  id: number;
  x: number;
  y: number;
  /** true: si attraversa in direzione est-ovest, il battente sta sul piano x = cella + 0.5 */
  ew: boolean;
  secret: boolean;
  /** texture mostrata dalle pareti segrete */
  tex: number;
  /** porta blindata: serve la tessera (cooperativa) */
  locked?: boolean;
}

export interface Room { x: number; y: number; w: number; h: number; tex: number; }
export interface ItemSpawn { id: number; kind: ItemKind; x: number; y: number; }
export interface EnemySpawn { kind: EnemyKind; x: number; y: number; a: number; }
export interface Spawn { x: number; y: number; a: number; }

export interface Level {
  seed: number;
  mode: GameMode;
  theme: number;
  w: number;
  h: number;
  walls: Uint8Array;
  doorAt: Int16Array;
  doors: Door[];
  rooms: Room[];
  items: ItemSpawn[];
  enemies: EnemySpawn[];
  spawns: Spawn[];
  exit: { x: number; y: number } | null;
  /** modalità a squadre: centro della base di ciascuna squadra (dove stanno i documenti) */
  bases: { x: number; y: number }[];
  /** modalità a squadre: punti di spawn di ciascuna squadra, vicini alla propria base */
  teamSpawns: Spawn[][];
}

interface BspNode { x: number; y: number; w: number; h: number; a?: BspNode; b?: BspNode; room?: number; }

const MIN_LEAF = 9;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

export function generateLevel(seed: number, mode: GameMode): Level {
  const r = mulberry32(seed);
  const W = MAP_W, H = MAP_H;
  const themeIdx = Math.floor(r() * THEMES.length);
  const theme = THEMES[themeIdx];
  const walls = new Uint8Array(W * H).fill(theme.base);
  const doorAt = new Int16Array(W * H).fill(-1);
  const doors: Door[] = [];
  const rooms: Room[] = [];
  const at = (x: number, y: number) => y * W + x;
  const isFloor = (x: number, y: number) => walls[at(x, y)] === 0 && doorAt[at(x, y)] < 0;
  const isSolid = (x: number, y: number) => walls[at(x, y)] !== 0;

  // Modalità a squadre: mappa a simmetria centrale. Si genera la metà sinistra
  // (colonne 1–30) e ogni modifica viene ripetuta nella cella ruotata di 180°,
  // così le due basi hanno esattamente la stessa geometria, porte e oggetti.
  const sym = mode === 'tdm' || mode === 'ctf';
  const rx_ = (x: number) => W - 1 - x;
  const ry_ = (y: number) => H - 1 - y;

  // 1. Partizione BSP dello spazio (solo la metà sinistra se simmetrica).
  const root: BspNode = sym ? { x: 1, y: 1, w: (W >> 1) - 2, h: H - 2 } : { x: 1, y: 1, w: W - 2, h: H - 2 };
  const split = (n: BspNode, depth: number): void => {
    const canV = n.w >= MIN_LEAF * 2;
    const canH = n.h >= MIN_LEAF * 2;
    if (!canV && !canH) return;
    if (depth >= 3 && n.w < 22 && n.h < 22 && r() < 0.3) return;
    let vertical: boolean;
    if (canV && canH) {
      if (n.w > n.h * 1.25) vertical = true;
      else if (n.h > n.w * 1.25) vertical = false;
      else vertical = r() < 0.5;
    } else vertical = canV;
    if (vertical) {
      const s = randInt(r, MIN_LEAF, n.w - MIN_LEAF);
      n.a = { x: n.x, y: n.y, w: s, h: n.h };
      n.b = { x: n.x + s, y: n.y, w: n.w - s, h: n.h };
    } else {
      const s = randInt(r, MIN_LEAF, n.h - MIN_LEAF);
      n.a = { x: n.x, y: n.y, w: n.w, h: s };
      n.b = { x: n.x, y: n.y + s, w: n.w, h: n.h - s };
    }
    split(n.a, depth + 1);
    split(n.b, depth + 1);
  };
  split(root, 0);

  // 2. Una stanza per foglia. La cornice di muro di ogni stanza resta dentro
  //    la sua foglia, così due stanze sono separate da almeno due celle piene.
  const paintRoom = (rm: Room) => {
    for (let y = rm.y - 1; y <= rm.y + rm.h; y++) {
      for (let x = rm.x - 1; x <= rm.x + rm.w; x++) {
        const inside = x >= rm.x && x < rm.x + rm.w && y >= rm.y && y < rm.y + rm.h;
        walls[at(x, y)] = inside ? 0 : rm.tex;
      }
    }
  };
  const makeRooms = (n: BspNode): void => {
    if (n.a && n.b) { makeRooms(n.a); makeRooms(n.b); return; }
    const rw = randInt(r, 4, Math.min(n.w - 2, 14));
    const rh = randInt(r, 4, Math.min(n.h - 2, 14));
    const rx = n.x + 1 + randInt(r, 0, n.w - 2 - rw);
    const ry = n.y + 1 + randInt(r, 0, n.h - 2 - rh);
    const tex = pick(r, theme.walls);
    n.room = rooms.length;
    rooms.push({ x: rx, y: ry, w: rw, h: rh, tex });
    paintRoom(rooms[n.room]);
  };
  makeRooms(root);
  /** stanze generate direttamente; in modalità simmetrica la stanza i+half è la copia ruotata di i */
  const half = rooms.length;
  if (sym) {
    for (let i = 0; i < half; i++) {
      const rm = rooms[i];
      rooms.push({ x: W - rm.x - rm.w, y: H - rm.y - rm.h, w: rm.w, h: rm.h, tex: rm.tex });
      paintRoom(rooms[half + i]);
    }
  }

  // 3. Corridoi a L tra stanze sorelle nell'albero BSP (grafo sempre connesso).
  const center = (rm: Room) => [rm.x + (rm.w >> 1), rm.y + (rm.h >> 1)] as const;
  const carve = (x: number, y: number) => {
    walls[at(x, y)] = 0;
    if (sym) walls[at(rx_(x), ry_(y))] = 0;
  };
  const corridor = (a: Room, b: Room) => {
    const [ax, ay] = center(a);
    const [bx, by] = center(b);
    const horizFirst = r() < 0.5;
    if (horizFirst) {
      for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) carve(x, ay);
      for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) carve(bx, y);
    } else {
      for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) carve(ax, y);
      for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) carve(x, by);
    }
  };
  const roomsOf = (n: BspNode): number[] => (n.a && n.b ? [...roomsOf(n.a), ...roomsOf(n.b)] : [n.room!]);
  const connect = (n: BspNode): void => {
    if (!n.a || !n.b) return;
    connect(n.a);
    connect(n.b);
    const A = roomsOf(n.a), B = roomsOf(n.b);
    let best: [number, number] = [A[0], B[0]];
    let bestD = Infinity;
    for (const i of A) for (const j of B) {
      const [ax, ay] = center(rooms[i]);
      const [bx, by] = center(rooms[j]);
      const d = Math.abs(ax - bx) + Math.abs(ay - by);
      if (d < bestD) { bestD = d; best = [i, j]; }
    }
    corridor(rooms[best[0]], rooms[best[1]]);
  };
  connect(root);

  // Passaggi tra le due metà: corridoi da una stanza sinistra verso la copia
  // ruotata di un'altra stanza sinistra (e, per simmetria, il loro gemello).
  if (sym) {
    const mid = rooms.slice(0, half).map((_, i) => i).sort((a, b) => (rooms[b].x + rooms[b].w) - (rooms[a].x + rooms[a].w));
    const cross = Math.min(half, 2 + Math.floor(half / 5));
    const used = new Set<string>();
    for (let k = 0; k < cross; k++) {
      const i = mid[Math.min(mid.length - 1, Math.floor(r() * Math.min(4, mid.length)))];
      const [ix, iy] = center(rooms[i]);
      let j = -1, bestD = Infinity;
      for (let q = 0; q < half; q++) {
        if (used.has(`${Math.min(i, q)},${Math.max(i, q)}`)) continue;
        const [qx, qy] = center(rooms[half + q]);
        const d = Math.abs(ix - qx) + Math.abs(iy - qy) + r() * 16;
        if (d < bestD) { bestD = d; j = q; }
      }
      if (j < 0) continue;
      used.add(`${Math.min(i, j)},${Math.max(i, j)}`);
      corridor(rooms[i], rooms[half + j]);
    }
  }

  // Anelli extra: più vie di fuga, soprattutto in deathmatch.
  const genRooms = sym ? half : rooms.length;
  const extra = Math.floor(genRooms / (mode !== 'coop' ? 3 : 6));
  for (let k = 0; k < extra; k++) {
    const i = Math.floor(r() * genRooms);
    let j = -1, bestD = Infinity;
    const [ix, iy] = center(rooms[i]);
    for (let q = 0; q < genRooms; q++) {
      if (q === i) continue;
      const [qx, qy] = center(rooms[q]);
      const d = Math.abs(ix - qx) + Math.abs(iy - qy) + r() * 12;
      if (d < bestD && d > 6) { bestD = d; j = q; }
    }
    if (j >= 0) corridor(rooms[i], rooms[j]);
  }

  const hasDoorNear = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (doorAt[at(x + dx, y + dy)] >= 0) return true;
    return false;
  };
  const addOneDoor = (x: number, y: number, ew: boolean, secret: boolean, tex: number) => {
    const id = doors.length;
    doors.push({ id, x, y, ew, secret, tex });
    walls[at(x, y)] = 0;
    doorAt[at(x, y)] = id;
  };
  const addDoor = (x: number, y: number, ew: boolean, secret: boolean, tex: number) => {
    addOneDoor(x, y, ew, secret, tex);
    if (sym) addOneDoor(rx_(x), ry_(y), ew, secret, tex);
  };

  // 4. Porte dove un corridoio attraversa perpendicolarmente la cornice di una stanza.
  const doorChance = mode === 'coop' ? 0.85 : 0.5;
  for (const rm of rooms.slice(0, genRooms)) {
    const ring: [number, number, boolean][] = [];
    for (let x = rm.x; x < rm.x + rm.w; x++) { ring.push([x, rm.y - 1, false]); ring.push([x, rm.y + rm.h, false]); }
    for (let y = rm.y; y < rm.y + rm.h; y++) { ring.push([rm.x - 1, y, true]); ring.push([rm.x + rm.w, y, true]); }
    for (const [x, y, ew] of ring) {
      if (!isFloor(x, y) || hasDoorNear(x, y)) continue;
      const ok = ew
        ? isSolid(x, y - 1) && isSolid(x, y + 1) && isFloor(x - 1, y) && isFloor(x + 1, y)
        : isSolid(x - 1, y) && isSolid(x + 1, y) && isFloor(x, y - 1) && isFloor(x, y + 1);
      if (ok && r() < doorChance) addDoor(x, y, ew, false, 0);
    }
  }

  // 5. Stanza di partenza e distanze BFS da essa.
  const startRoom = Math.floor(r() * rooms.length);
  const dist = new Int32Array(W * H).fill(-1);
  {
    const [sx, sy] = center(rooms[startRoom]);
    const q = [at(sx, sy)];
    dist[q[0]] = 0;
    for (let h = 0; h < q.length; h++) {
      const c = q[h], cx = c % W, cy = (c / W) | 0;
      for (const [dx, dy] of DIRS) {
        const n = at(cx + dx, cy + dy);
        if (walls[n] === 0 && dist[n] < 0) { dist[n] = dist[c] + 1; q.push(n); }
      }
    }
  }
  const roomDist = rooms.map((rm) => dist[at(...center(rm))]);
  const order = rooms.map((_, i) => i).sort((a, b) => roomDist[a] - roomDist[b]);

  // 6. Ripostigli segreti dietro una parete scorrevole, con un premio dentro.
  const occupied = new Set<number>();
  const items: ItemSpawn[] = [];
  const addOneItem = (kind: ItemKind, x: number, y: number) => {
    occupied.add(at(x, y));
    items.push({ id: items.length, kind, x: x + 0.5, y: y + 0.5 });
  };
  const addItem = (kind: ItemKind, x: number, y: number) => {
    addOneItem(kind, x, y);
    if (sym) addOneItem(kind, rx_(x), ry_(y));
  };
  for (let ri = 0; ri < genRooms; ri++) {
    if (ri === startRoom || r() > 0.4) continue;
    const rm = rooms[ri];
    for (let attempt = 0; attempt < 8; attempt++) {
      const side = Math.floor(r() * 4);
      let px: number, py: number, dx: number, dy: number;
      if (side === 0) { px = rm.x + randInt(r, 0, rm.w - 1); py = rm.y - 1; dx = 0; dy = -1; }
      else if (side === 1) { px = rm.x + randInt(r, 0, rm.w - 1); py = rm.y + rm.h; dx = 0; dy = 1; }
      else if (side === 2) { px = rm.x - 1; py = rm.y + randInt(r, 0, rm.h - 1); dx = -1; dy = 0; }
      else { px = rm.x + rm.w; py = rm.y + randInt(r, 0, rm.h - 1); dx = 1; dy = 0; }
      const lx = dy, ly = dx; // asse laterale
      let ok = isSolid(px, py) && doorAt[at(px, py)] < 0 && isSolid(px + lx, py + ly) && isSolid(px - lx, py - ly);
      for (let k = 1; k <= 3 && ok; k++) {
        for (let l = -1; l <= 1 && ok; l++) {
          const cx = px + dx * k + lx * l, cy = py + dy * k + ly * l;
          if (cx < 1 || cy < 1 || cx > (sym ? (W >> 1) - 2 : W - 2) || cy > H - 2 || !isSolid(cx, cy)) ok = false;
        }
      }
      if (!ok) continue;
      carve(px + dx, py + dy);
      carve(px + dx * 2, py + dy * 2);
      addDoor(px, py, dx !== 0, true, rm.tex);
      addItem(r() < 0.5 ? 'gem' : 'coins', px + dx * 2, py + dy * 2);
      addItem(pick(r, ['ammo', 'medkit', 'coins'] as const), px + dx, py + dy);
      break;
    }
  }

  // 7. Uscita (solo cooperativa): interruttore sulla parete della stanza più lontana.
  let exit: { x: number; y: number } | null = null;
  let exitRoom = -1;
  if (mode === 'coop') {
    for (let oi = order.length - 1; oi >= 0 && !exit; oi--) {
      const rm = rooms[order[oi]];
      exitRoom = order[oi];
      // [x, y, dx, dy]: cella della cornice e direzione verso l'esterno della stanza
      const cands: [number, number, number, number][] = [];
      for (let x = rm.x; x < rm.x + rm.w; x++) { cands.push([x, rm.y - 1, 0, -1]); cands.push([x, rm.y + rm.h, 0, 1]); }
      for (let y = rm.y; y < rm.y + rm.h; y++) { cands.push([rm.x - 1, y, -1, 0]); cands.push([rm.x + rm.w, y, 1, 0]); }
      // alle spalle dell'interruttore serve muro pieno: si deve azionare solo da dentro la stanza
      const inMap = (x: number, y: number) => x >= 0 && y >= 0 && x < W && y < H;
      const good = cands
        .filter(([x, y, dx, dy]) => isSolid(x, y) && doorAt[at(x, y)] < 0 && !hasDoorNear(x, y) && (!inMap(x + dx, y + dy) || isSolid(x + dx, y + dy)))
        .map(([x, y]) => [x, y] as [number, number]);
      if (good.length) {
        const [x, y] = pick(r, good);
        walls[at(x, y)] = TEX_EXIT;
        exit = { x, y };
      }
    }
  }

  // 8. Punti di spawn, nemici e oggetti.
  const freeCell = (rm: Room): [number, number] | null => {
    for (let k = 0; k < 30; k++) {
      const x = rm.x + randInt(r, 0, rm.w - 1), y = rm.y + randInt(r, 0, rm.h - 1);
      if (isFloor(x, y) && !occupied.has(at(x, y)) && !(sym && occupied.has(at(rx_(x), ry_(y))))) return [x, y];
    }
    return null;
  };
  const faces = [0, Math.PI / 2, Math.PI, -Math.PI / 2];
  const spawnAt = (ri: number): Spawn | null => {
    const c = freeCell(rooms[ri]);
    if (!c) return null;
    occupied.add(at(c[0], c[1]));
    if (sym) occupied.add(at(rx_(c[0]), ry_(c[1])));
    const [cx, cy] = center(rooms[ri]);
    return { x: c[0] + 0.5, y: c[1] + 0.5, a: Math.atan2(cy - c[1], cx - c[0] || 0.001) };
  };
  /** punto ruotato di 180° attorno al centro della mappa */
  const mirrorSpawn = (s: Spawn): Spawn => ({ x: W - s.x, y: H - s.y, a: s.a > 0 ? s.a - Math.PI : s.a + Math.PI });

  // Modalità a squadre: la base della squadra 0 è la stanza sinistra più lontana
  // dalla propria copia ruotata, che diventa la base della squadra 1.
  const bases: { x: number; y: number }[] = [];
  const teamSpawns: Spawn[][] = [];
  if (sym) {
    const bfs = (start: number): Int32Array => {
      const d = new Int32Array(W * H).fill(-1);
      const q = [start];
      d[start] = 0;
      for (let h = 0; h < q.length; h++) {
        const c = q[h], cx = c % W, cy = (c / W) | 0;
        for (const [dx, dy] of DIRS) {
          const n = at(cx + dx, cy + dy);
          if (walls[n] === 0 && d[n] < 0 && (doorAt[n] < 0 || !doors[doorAt[n]].secret)) { d[n] = d[c] + 1; q.push(n); }
        }
      }
      return d;
    };
    let bi = 0, best = -1, field: Int32Array | null = null;
    for (let i = 0; i < half; i++) {
      // lontana dalla gemella sia a piedi sia in linea d'aria
      const [ix, iy] = center(rooms[i]);
      const f = bfs(at(ix, iy));
      const d = f[at(rx_(ix), ry_(iy))] + 1.5 * Math.hypot(rx_(ix) - ix, ry_(iy) - iy);
      if (d > best) { best = d; bi = i; field = f; }
    }
    const [cx, cy] = center(rooms[bi]);
    occupied.add(at(cx, cy));
    occupied.add(at(rx_(cx), ry_(cy)));
    bases.push({ x: cx + 0.5, y: cy + 0.5 }, { x: W - cx - 0.5, y: H - cy - 0.5 });
    // Spawn nelle tre stanze più vicine alla base (a piedi), copiati per l'altra squadra.
    const near = rooms.map((_, k) => k).sort((a, b) => field![at(...center(rooms[a]))] - field![at(...center(rooms[b]))]);
    const list: Spawn[] = [];
    for (const k of near.slice(0, 3)) for (let n = 0; n < 2; n++) { const sp = spawnAt(k); if (sp) list.push(sp); }
    teamSpawns.push(list, list.map(mirrorSpawn));
  }

  const spawns: Spawn[] = [];
  const spawnRooms = mode === 'coop' ? [startRoom, startRoom, startRoom, startRoom] : rooms.slice(0, genRooms).flatMap((_, i) => [i, i]);
  for (const ri of spawnRooms) {
    const sp = spawnAt(ri);
    if (sp) { spawns.push(sp); if (sym) spawns.push(mirrorSpawn(sp)); }
  }

  const enemies: EnemySpawn[] = [];
  if (mode === 'coop') {
    for (let ri = 0; ri < rooms.length; ri++) {
      if (ri === startRoom) continue;
      const rm = rooms[ri];
      const depth = order.indexOf(ri) / rooms.length;
      const n = Math.min(6, randInt(r, 1, 1 + Math.floor((rm.w * rm.h) / 14)));
      for (let k = 0; k < n; k++) {
        const c = freeCell(rm);
        if (!c) break;
        occupied.add(at(c[0], c[1]));
        const kind = weighted<EnemyKind>(r, [['guard', 0.6 - depth * 0.25], ['trooper', 0.15 + depth * 0.3], ['hound', 0.2]]);
        enemies.push({ kind, x: c[0] + 0.5, y: c[1] + 0.5, a: pick(r, faces) });
      }
    }
  }

  // Cooperativa: porte blindate attorno alla stanza dell'uscita e tessera custodita dal Comandante.
  if (mode === 'coop' && exitRoom >= 0) {
    const ex = rooms[exitRoom];
    const onRing = (x: number, y: number) =>
      x >= ex.x - 1 && x <= ex.x + ex.w && y >= ex.y - 1 && y <= ex.y + ex.h && !(x >= ex.x && x < ex.x + ex.w && y >= ex.y && y < ex.y + ex.h);
    const ring = doors.filter((d) => !d.secret && onRing(d.x, d.y));
    // raggiungibilità dall'inizio senza attraversare le porte dell'uscita
    const reach = new Uint8Array(W * H);
    {
      const [sx, sy] = center(rooms[startRoom]);
      const q = [at(sx, sy)];
      reach[q[0]] = 1;
      const blocked = new Set(ring.map((d) => at(d.x, d.y)));
      for (let h = 0; h < q.length; h++) {
        const c = q[h], cx = c % W, cy = (c / W) | 0;
        for (const [dx, dy] of DIRS) {
          const n = at(cx + dx, cy + dy);
          if (walls[n] === 0 && !reach[n] && !blocked.has(n)) { reach[n] = 1; q.push(n); }
        }
      }
    }
    const sealed = ring.length > 0 && !reach[at(...center(ex))];
    // stanza della tessera: a metà percorso, raggiungibile senza tessera
    const cands = order.filter((ri) => ri !== startRoom && ri !== exitRoom && reach[at(...center(rooms[ri]))]);
    const keyRoom = cands.length ? cands[Math.min(cands.length - 1, Math.floor(cands.length * (0.5 + r() * 0.25)))] : -1;
    if (keyRoom >= 0) {
      const kr = rooms[keyRoom];
      if (sealed) {
        for (const d of ring) d.locked = true;
        const c = freeCell(kr);
        if (c) addItem('key', c[0], c[1]);
      }
      const o = freeCell(kr);
      if (o) { occupied.add(at(o[0], o[1])); enemies.push({ kind: 'officer', x: o[0] + 0.5, y: o[1] + 0.5, a: pick(r, faces) }); }
    }
  }

  const loot: readonly (readonly [ItemKind, number])[] = mode === 'coop'
    ? [['ammo', 0.33], ['food', 0.18], ['medkit', 0.14], ['coins', 0.18], ['gem', 0.08], ['vest', 0.04], ['grenade', 0.05]]
    : [['ammo', 0.4], ['medkit', 0.26], ['food', 0.2], ['vest', 0.07], ['grenade', 0.07]];
  for (const rm of rooms.slice(0, genRooms)) {
    const n = randInt(r, mode === 'coop' ? 0 : 1, 2);
    for (let k = 0; k < n; k++) {
      const c = freeCell(rm);
      if (c) addItem(weighted(r, loot), c[0], c[1]);
    }
  }
  const placeWeapon = (kind: ItemKind, ri: number) => {
    const c = freeCell(rooms[ri]);
    if (c) addItem(kind, c[0], c[1]);
  };
  if (mode === 'coop') {
    placeWeapon('smg', order[Math.min(order.length - 1, 1 + Math.floor(r() * 3))]);
    placeWeapon('chaingun', order[Math.floor(order.length * (0.55 + r() * 0.3))]);
  } else if (sym) {
    // una per metà, in posizioni speculari
    placeWeapon('smg', Math.floor(r() * half));
    placeWeapon('chaingun', Math.floor(r() * half));
  } else {
    placeWeapon('smg', Math.floor(r() * rooms.length));
    placeWeapon('smg', Math.floor(r() * rooms.length));
    placeWeapon('chaingun', Math.floor(r() * rooms.length));
  }

  return { seed, mode, theme: themeIdx, w: W, h: H, walls, doorAt, doors, rooms, items, enemies, spawns, exit, bases, teamSpawns };
}

export type { Rng };
