// Una stanza di gioco: stato autoritativo, simulazione a TICK_RATE e snapshot ai client.

import type { WebSocket } from 'ws';
import {
  DOOR_HOLD, DOOR_TIME, ENEMIES, ENEMY_KINDS, ENEMY_RADIUS, ES_AIM, ES_CHASE, ES_DEAD, ES_IDLE, ES_PAIN,
  CTF_LIMIT, FLAG_RETURN_TIME, FLAG_TOUCH, FRAG_LIMIT, HIT_RADIUS, MATCH_TIME, TDM_LIMIT, TEAMS, isTeamMode, INPUT_DT, ITEM_KINDS, MAX_AMMO, MAX_HP, PLAYER_RADIUS, RESPAWN_TIME, START_AMMO, TICK_DT, WEAPONS,
  GRENADE_DAMAGE, GRENADE_FUSE, GRENADE_RADIUS, GRENADE_SPEED, MAX_ARMOR, MAX_GRENADES, VEST_ARMOR,
  type EnemyDef, type EnemyKind, type GameMode, type ItemKind,
} from '../shared/defs.ts';
import { generateLevel, MAP_H, MAP_W, TEX_EXIT, type Level } from '../shared/level.ts';
import { applyPlayerInput, castRay, distanceField, lineOfSight, moveWithCollision, newRayHit } from '../shared/physics.ts';
import {
  BTN_FIRE, BTN_THROW, BTN_USE, ENEMY_ID_BASE, ENEMY_WEAPON_BASE, MAX_REWIND_MS,
  type InputCmd, type NetEnemy, type NetEvent, type NetMe, type NetPlayer,
} from '../shared/protocol.ts';
import { hashSeed } from '../shared/rng.ts';
import {
  XP_CAPTURE, XP_CARRIER_KILL, XP_CLEAR, XP_COINS, XP_ENEMY, XP_EXIT, XP_FLAG_RETURN, XP_FLAG_TAKE, XP_FRAG, XP_GEM,
  XP_KEY, XP_SECRET, XP_STREAK, XP_TEAM_WIN, XP_WIN,
  emptyDelta, levelFromXp, perksFor, type Perks, type StatDelta,
} from '../shared/progression.ts';

export interface PlayerInfo {
  name: string;
  color: number;
  hat: number;
  tag: string;
  /** null per gli ospiti */
  userId: number | null;
  /** EXP già salvata nel database */
  xp: number;
}

export interface RoomHooks {
  /** Salva un blocco di statistiche di un giocatore registrato. */
  flush?: (userId: number, delta: StatDelta, mode: GameMode) => void;
  /** Esito di una sfida tra due clan (winner = sigla vincente, null = pareggio). */
  clanMatch?: (mode: GameMode, tagA: string, tagB: string, winner: string | null) => void;
}

export interface SPlayer {
  id: number;
  ws: WebSocket;
  name: string;
  color: number;
  hat: number;
  tag: string;
  userId: number | null;
  xpBase: number;
  level: number;
  delta: StatDelta;
  streak: number;
  perks: Perks;
  x: number;
  y: number;
  a: number;
  hp: number;
  ammo: number;
  weapons: boolean[];
  weapon: number;
  cooldown: number;
  alive: boolean;
  respawn: number;
  frags: number;
  deaths: number;
  score: number;
  queue: InputCmd[];
  lastSeq: number;
  useHeld: boolean;
  throwHeld: boolean;
  /** armatura del giubbotto: assorbe metà dei danni */
  armor: number;
  grenades: number;
  /** ultimo avviso "serve la tessera" (secondi di gioco), per non ripeterlo */
  lockMsgAt: number;
  /** squadra (0, 1) oppure -1 fuori dalle modalità a squadre */
  team: number;
}

/** Granata in volo. */
interface Grenade { x: number; y: number; vx: number; vy: number; fuse: number; owner: number; }

interface SEnemy {
  id: number;
  kind: EnemyKind;
  def: EnemyDef;
  x: number;
  y: number;
  a: number;
  hp: number;
  state: number;
  timer: number;
  cooldown: number;
  target: number;
  sees: boolean;
}

interface DynItem { id: number; kind: ItemKind; x: number; y: number; }

export const FLAG_HOME = 0;
export const FLAG_CARRIED = 1;
export const FLAG_DROPPED = 2;

/** I documenti di una squadra nella modalità cattura. */
export interface Flag { team: number; homeX: number; homeY: number; x: number; y: number; state: number; carrier: number; returnIn: number; }

const MAX_CMDS_PER_TICK = 4;
const FLUSH_EVERY = 60; // secondi
const MAX_QUEUE = 20;
const rand = Math.random;
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const r2 = (v: number) => Math.round(v * 100) / 100;

function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

export class Room {
  readonly name: string;
  readonly mode: GameMode;
  readonly baseSeed: number;
  levelNum = 1;
  level!: Level;
  doorOpen!: Float32Array;
  doorDir!: Int8Array;
  doorHold!: Float32Array;
  itemGone!: Uint8Array;
  itemRespawn!: Float32Array;
  dynItems: DynItem[] = [];
  grenades: Grenade[] = [];
  /** cooperativa: la squadra ha trovato la tessera delle porte blindate */
  hasKey = false;
  nextDynId = 10000;
  enemies: SEnemy[] = [];
  players = new Map<number, SPlayer>();
  events: NetEvent[] = [];
  tick = 0;
  /**
   * Posizioni degli ultimi ~1 s per la compensazione della latenza:
   * per tick, coppie (x, y) di giocatori (per id) e nemici (per indice).
   */
  private history = new Map<number, { players: Map<number, [number, number, boolean]>; enemies: Float32Array }>();
  pendingLevel = 0;
  emptyFor = 0;
  readonly teams: boolean;
  readonly pvp: boolean;
  teamScore = [0, 0];
  timeLeft = MATCH_TIME;
  flags: Flag[] = [];
  private flushTimer = FLUSH_EVERY;
  private hooks: RoomHooks;
  private field = new Int16Array(MAP_W * MAP_H);
  private queue = new Int32Array(MAP_W * MAP_H);
  private hit = newRayHit();

  constructor(name: string, mode: GameMode, seed: number, hooks: RoomHooks = {}) {
    this.name = name;
    this.mode = mode;
    this.baseSeed = seed;
    this.hooks = hooks;
    this.teams = isTeamMode(mode);
    this.pvp = mode !== 'coop';
    this.loadLevel(seed);
  }

  get seed(): number { return this.level.seed; }

  loadLevel(seed: number): void {
    const lvl = generateLevel(seed, this.mode);
    this.level = lvl;
    this.doorOpen = new Float32Array(lvl.doors.length);
    this.doorDir = new Int8Array(lvl.doors.length);
    this.doorHold = new Float32Array(lvl.doors.length);
    this.itemGone = new Uint8Array(lvl.items.length);
    this.itemRespawn = new Float32Array(lvl.items.length);
    this.dynItems = [];
    this.grenades = [];
    this.hasKey = false;
    this.enemies = lvl.enemies.map((e, i) => ({
      id: ENEMY_ID_BASE + i, kind: e.kind, def: ENEMIES[e.kind], x: e.x, y: e.y, a: e.a,
      hp: ENEMIES[e.kind].hp, state: ES_IDLE, timer: 0, cooldown: 0, target: -1, sees: false,
    }));
    this.pendingLevel = 0;
    this.teamScore = [0, 0];
    this.timeLeft = MATCH_TIME;
    this.flags = this.mode === 'ctf'
      ? lvl.bases.map((b, t) => ({ team: t, homeX: b.x, homeY: b.y, x: b.x, y: b.y, state: FLAG_HOME, carrier: -1, returnIn: 0 }))
      : [];
  }

  // ---------------------------------------------------------------- squadre

  private teamSize(t: number): number {
    let n = 0;
    for (const p of this.players.values()) if (p.team === t) n++;
    return n;
  }

  /** Squadra per chi entra: la meno numerosa; a parità, quella con compagni della stessa sigla. */
  private pickTeam(tag: string): number {
    const a = this.teamSize(0), b = this.teamSize(1);
    if (a !== b) return a < b ? 0 : 1;
    if (tag) for (const p of this.players.values()) if (p.tag === tag && p.team >= 0) return p.team;
    return Math.random() < 0.5 ? 0 : 1;
  }

  /**
   * A inizio partita ricompone le squadre: i membri di uno stesso clan restano
   * insieme (prima i clan più numerosi), gli altri riempiono la squadra più corta.
   * Se un clan da solo sbilancia troppo, si sposta chi è entrato per ultimo.
   */
  private formTeams(): void {
    const before = new Map([...this.players.values()].map((p) => [p, p.team]));
    const groups = new Map<string, SPlayer[]>();
    const solo: SPlayer[] = [];
    for (const p of this.players.values()) {
      if (!p.tag) { solo.push(p); continue; }
      const g = groups.get(p.tag);
      if (g) g.push(p); else groups.set(p.tag, [p]);
    }
    const ordered = [...groups.values()].filter((g) => g.length > 1).sort((a, b) => b.length - a.length);
    for (const g of groups.values()) if (g.length === 1) solo.push(g[0]);
    const size = [0, 0];
    const place = (ps: SPlayer[], prefer: number) => {
      const t = size[0] === size[1] ? prefer : size[0] < size[1] ? 0 : 1;
      for (const p of ps) p.team = t;
      size[t] += ps.length;
    };
    for (const g of ordered) {
      // a parità resta dove stava la maggior parte del clan
      const inZero = g.filter((p) => p.team === 0).length;
      place(g, inZero * 2 >= g.length ? 0 : 1);
    }
    for (const p of solo) place([p], p.team >= 0 ? p.team : 0);
    for (;;) {
      const a = this.teamSize(0), b = this.teamSize(1);
      if (Math.abs(a - b) <= 1) break;
      const from = a > b ? 0 : 1;
      const list = [...this.players.values()].reverse().filter((p) => p.team === from);
      const mover = list.find((p) => !p.tag) ?? list[0];
      mover.team = 1 - from;
    }
    for (const [p, t] of before) {
      if (t >= 0 && p.team !== t) this.events.push({ e: 'msg', text: `${p.name} passa alla squadra ${TEAMS[p.team].name}` });
    }
    const war = this.clanWar();
    if (war) this.events.push({ e: 'msg', text: `Sfida tra clan: [${war[0]}] contro [${war[1]}]` });
  }

  /** Sigle dei due clan se ogni squadra è composta (giocatori registrati) da un solo clan, diverso dall'altro. */
  private clanWar(): [string, string] | null {
    const tags: string[] = [];
    for (let t = 0; t < 2; t++) {
      const regs = [...this.players.values()].filter((p) => p.team === t && p.userId !== null);
      if (regs.length < 2 || !regs[0].tag || regs.some((p) => p.tag !== regs[0].tag)) return null;
      tags.push(regs[0].tag);
    }
    return tags[0] !== tags[1] ? [tags[0], tags[1]] : null;
  }

  private isFoe(a: SPlayer, b: SPlayer): boolean {
    return a !== b && (!this.teams || a.team !== b.team);
  }

  // ---------------------------------------------------------------- giocatori

  addPlayer(id: number, ws: WebSocket, info: PlayerInfo): SPlayer {
    const level = levelFromXp(info.xp);
    const p: SPlayer = {
      id, ws, name: info.name, color: info.color, hat: info.hat, tag: info.tag, userId: info.userId,
      xpBase: info.xp, level, delta: emptyDelta(), streak: 0, perks: perksFor(level, this.mode === 'coop'),
      x: 0, y: 0, a: 0, hp: MAX_HP, ammo: START_AMMO, weapons: [true, true, false, false],
      weapon: 1, cooldown: 0, alive: true, respawn: 0, frags: 0, deaths: 0, score: 0, queue: [], lastSeq: 0, useHeld: false,
      throwHeld: false, armor: 0, grenades: 0, lockMsgAt: -99,
      team: -1,
    };
    if (this.teams) p.team = this.pickTeam(info.tag);
    this.players.set(id, p);
    this.spawn(p, true);
    this.events.push({ e: 'msg', text: this.teams ? `${p.name} entra nella squadra ${TEAMS[p.team].name}` : `${p.name} è entrato` });
    return p;
  }

  removePlayer(id: number): void {
    const p = this.players.get(id);
    if (!p) return;
    this.dropFlag(p);
    this.flush(p);
    this.players.delete(id);
    this.events.push({ e: 'msg', text: `${p.name} è uscito` });
  }

  /** Salva le statistiche accumulate e le azzera. */
  flush(p: SPlayer): void {
    const d = p.delta;
    d.bestScore = Math.max(d.bestScore, p.score);
    d.playtime = Math.round(d.playtime);
    if (p.userId !== null && this.hooks.flush) this.hooks.flush(p.userId, d, this.mode);
    p.xpBase += d.xp;
    p.delta = emptyDelta();
  }

  flushAll(): void {
    for (const p of this.players.values()) this.flush(p);
  }

  /** EXP totale (salvata + in sospeso) di un giocatore. */
  xpOf(p: SPlayer): number {
    return p.xpBase + p.delta.xp;
  }

  private award(p: SPlayer, xp: number, why: string): void {
    if (xp <= 0) return;
    p.delta.xp += xp;
    this.events.push({ e: 'xp', id: p.id, n: xp, why });
    const lvl = levelFromXp(this.xpOf(p));
    if (lvl > p.level) {
      p.level = lvl;
      p.perks = perksFor(lvl, this.mode === 'coop');
      this.events.push({ e: 'lvlup', id: p.id, lvl });
      this.events.push({ e: 'msg', text: `${p.name} sale al livello ${lvl}` });
    }
  }

  private spawn(p: SPlayer, fullReset: boolean): void {
    const spawns = this.teams && this.level.teamSpawns[p.team]?.length ? this.level.teamSpawns[p.team] : this.level.spawns;
    let best = spawns[0];
    if (this.pvp) {
      // Lo spawn più lontano dagli avversari vivi.
      let bestScore = -1;
      for (const s of spawns) {
        let minD = 1e9;
        for (const o of this.players.values()) if (this.isFoe(p, o) && o.alive) minD = Math.min(minD, Math.hypot(o.x - s.x, o.y - s.y));
        const score = minD + rand() * 4;
        if (score > bestScore) { bestScore = score; best = s; }
      }
    } else {
      const idx = [...this.players.keys()].indexOf(p.id);
      best = spawns[Math.max(0, idx) % spawns.length];
    }
    p.x = best.x; p.y = best.y; p.a = best.a;
    p.hp = p.perks.maxHp; p.alive = true; p.respawn = 0; p.cooldown = 0;
    if (fullReset) {
      p.ammo = p.perks.startAmmo; p.weapons = [true, true, false, false]; p.weapon = 1;
      p.armor = 0; p.grenades = this.pvp ? 1 : 0;
    }
  }

  enqueue(p: SPlayer, cmds: InputCmd[]): void {
    for (const c of cmds) {
      if (c.q <= p.lastSeq) continue;
      p.queue.push(c);
    }
    if (p.queue.length > MAX_QUEUE) p.queue.splice(0, p.queue.length - MAX_QUEUE);
  }

  private runCommands(p: SPlayer): void {
    let n = 0;
    while (p.queue.length && n < MAX_CMDS_PER_TICK) {
      const cmd = p.queue.shift()!;
      n++;
      p.lastSeq = cmd.q;
      if (!p.alive) continue;
      applyPlayerInput(this.level, this.doorOpen, p, cmd);
      if (cmd.w >= 0 && cmd.w < WEAPONS.length && p.weapons[cmd.w]) p.weapon = cmd.w;
      p.cooldown = Math.max(0, p.cooldown - INPUT_DT);
      if ((cmd.b & BTN_FIRE) && p.cooldown <= 0) this.playerFire(p, cmd.v);
      const use = (cmd.b & BTN_USE) !== 0;
      if (use && !p.useHeld) this.playerUse(p);
      p.useHeld = use;
      const thr = (cmd.b & BTN_THROW) !== 0;
      if (thr && !p.throwHeld) this.throwGrenade(p);
      p.throwHeld = thr;
    }
  }

  private bestWeapon(p: SPlayer): number {
    if (p.ammo > 0) for (let w = WEAPONS.length - 1; w >= 1; w--) if (p.weapons[w]) return w;
    return 0;
  }

  /** Registra le posizioni del tick appena simulato. */
  private recordHistory(): void {
    const players = new Map<number, [number, number, boolean]>();
    for (const o of this.players.values()) players.set(o.id, [o.x, o.y, o.alive]);
    const enemies = new Float32Array(this.enemies.length * 2);
    this.enemies.forEach((e, i) => { enemies[i * 2] = e.x; enemies[i * 2 + 1] = e.y; });
    this.history.set(this.tick, { players, enemies });
    this.history.delete(this.tick - Math.ceil(1000 / (TICK_DT * 1000)) - 2);
  }

  /**
   * Tick a cui riavvolgere un colpo: quello che il client vedeva, entro MAX_REWIND_MS;
   * null se non serve (nessuna indicazione o già presente).
   */
  private rewindTick(v: number | undefined): number | null {
    if (v === undefined) return null;
    const min = this.tick - MAX_REWIND_MS / (TICK_DT * 1000);
    const t = Math.max(min, Math.min(this.tick, v));
    return t >= this.tick - 0.01 ? null : t;
  }

  /** Posizione di un bersaglio al tick (frazionario) t, interpolando lo storico. */
  private pastPos(t: number | null, cur: { x: number; y: number }, get: (h: { players: Map<number, [number, number, boolean]>; enemies: Float32Array }) => [number, number] | null): [number, number] {
    if (t === null) return [cur.x, cur.y];
    const t0 = Math.floor(t), f = t - t0;
    const a = this.history.get(t0), b = this.history.get(t0 + 1) ?? a;
    const pa = a && get(a), pb = b && get(b);
    if (!pa || !pb) return [cur.x, cur.y];
    return [pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f];
  }

  private playerFire(p: SPlayer, view?: number): void {
    let def = WEAPONS[p.weapon];
    if (def.ammo > p.ammo) {
      p.weapon = this.bestWeapon(p);
      def = WEAPONS[p.weapon];
      if (def.ammo > p.ammo) return;
    }
    p.ammo -= def.ammo;
    p.cooldown = def.cooldown;
    p.delta.shots++;
    this.events.push({ e: 'shot', id: p.id, w: p.weapon, x: r2(p.x), y: r2(p.y) });

    const ang = p.a + (rand() - 0.5) * 2 * def.spread;
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const wallDist = castRay(this.level, this.doorOpen, p.x, p.y, dx, dy, def.range, this.hit) ? this.hit.dist : def.range;
    let bestT = wallDist;
    let bestEnemy: SEnemy | null = null;
    let bestPlayer: SPlayer | null = null;
    // i bersagli si controllano dove il tiratore li vedeva (compensazione della latenza);
    // muri e porte restano quelli attuali
    const rt = this.rewindTick(view);
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.state === ES_DEAD) continue;
      const [ex, ey] = this.pastPos(rt, e, (h) => (i * 2 + 1 < h.enemies.length ? [h.enemies[i * 2], h.enemies[i * 2 + 1]] : null));
      const t = this.rayHitsCircle(p.x, p.y, dx, dy, ex, ey, bestT);
      if (t >= 0) { bestT = t; bestEnemy = e; bestPlayer = null; }
    }
    if (this.pvp) {
      for (const o of this.players.values()) {
        if (!this.isFoe(p, o) || !o.alive) continue;
        const [ox, oy] = this.pastPos(rt, o, (h) => { const q = h.players.get(o.id); return q && q[2] ? [q[0], q[1]] : null; });
        const t = this.rayHitsCircle(p.x, p.y, dx, dy, ox, oy, bestT);
        if (t >= 0) { bestT = t; bestPlayer = o; bestEnemy = null; }
      }
    }
    const melee = p.weapon === 0;
    const falloff = melee ? 1 : Math.max(0.4, Math.min(1, 1.25 - bestT / 14));
    const dmg = Math.round(randInt(def.dmgMin, def.dmgMax) * falloff);
    if (bestEnemy || bestPlayer) {
      p.delta.hits++;
      p.delta.damage += Math.min(dmg, Math.max(0, bestEnemy ? bestEnemy.hp : bestPlayer!.hp));
    }
    if (bestEnemy) this.damageEnemy(bestEnemy, dmg, p);
    else if (bestPlayer) this.damagePlayer(bestPlayer, dmg, p, null);
    if (!melee) this.noise(p);
  }

  private rayHitsCircle(ox: number, oy: number, dx: number, dy: number, cx: number, cy: number, maxT: number): number {
    const rx = cx - ox, ry = cy - oy;
    const t = rx * dx + ry * dy;
    if (t <= 0 || t >= maxT) return -1;
    const perp = Math.abs(rx * dy - ry * dx);
    return perp < HIT_RADIUS ? t : -1;
  }

  private throwGrenade(p: SPlayer): void {
    if (p.grenades <= 0 || !p.alive) return;
    p.grenades--;
    const dx = Math.cos(p.a), dy = Math.sin(p.a);
    this.grenades.push({ x: p.x + dx * 0.4, y: p.y + dy * 0.4, vx: dx * GRENADE_SPEED, vy: dy * GRENADE_SPEED, fuse: GRENADE_FUSE, owner: p.id });
    this.events.push({ e: 'throw', id: p.id, x: r2(p.x), y: r2(p.y) });
  }

  /** Granate: rimbalzano sui muri, rallentano e alla fine della miccia esplodono. */
  private updateGrenades(dt: number): void {
    const solid = (x: number, y: number) => {
      const i = Math.floor(y) * this.level.w + Math.floor(x);
      const d = this.level.doorAt[i];
      return this.level.walls[i] !== 0 || (d >= 0 && this.doorOpen[d] < 0.9);
    };
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const g = this.grenades[i];
      const nx = g.x + g.vx * dt, ny = g.y + g.vy * dt;
      if (solid(nx, g.y)) g.vx *= -0.45; else g.x = nx;
      if (solid(g.x, ny)) g.vy *= -0.45; else g.y = ny;
      const drag = Math.pow(0.35, dt);
      g.vx *= drag; g.vy *= drag;
      if ((g.fuse -= dt) <= 0) {
        this.grenades.splice(i, 1);
        this.explode(g);
      }
    }
  }

  private explode(g: Grenade): void {
    this.events.push({ e: 'boom', x: r2(g.x), y: r2(g.y) });
    const owner = this.players.get(g.owner) ?? null;
    const dmgAt = (x: number, y: number) => {
      const d = Math.hypot(x - g.x, y - g.y);
      if (d > GRENADE_RADIUS || !lineOfSight(this.level, this.doorOpen, g.x, g.y, x, y)) return 0;
      return Math.round(GRENADE_DAMAGE * (1 - (d / GRENADE_RADIUS) * 0.75));
    };
    for (const e of this.enemies) {
      if (e.state === ES_DEAD) continue;
      const dmg = dmgAt(e.x, e.y);
      if (dmg > 0 && owner) this.damageEnemy(e, dmg, owner);
    }
    for (const v of this.players.values()) {
      if (!v.alive) continue;
      // il lanciatore si ferisce a metà; i compagni di squadra e i giocatori in cooperativa no
      const self = v.id === g.owner;
      if (!self && (!this.pvp || (owner && !this.isFoe(owner, v)))) continue;
      const dmg = dmgAt(v.x, v.y);
      if (dmg > 0) this.damagePlayer(v, self ? Math.round(dmg / 2) : dmg, owner, null);
    }
    if (owner) this.noise(owner);
  }

  private playerUse(p: SPlayer): void {
    const dx = Math.cos(p.a), dy = Math.sin(p.a);
    const W = this.level.w;
    for (const d of [0.5, 0.9, 1.3]) {
      const cx = Math.floor(p.x + dx * d), cy = Math.floor(p.y + dy * d);
      const i = cy * W + cx;
      const di = this.level.doorAt[i];
      if (di >= 0) {
        const door = this.level.doors[di];
        if (door.secret) {
          if (this.doorOpen[di] === 0 && this.doorDir[di] === 0) {
            p.delta.secrets++;
            this.award(p, XP_SECRET, 'passaggio segreto');
          }
          this.openDoor(di);
          return;
        }
        if (door.locked && !this.hasKey) {
          const now = this.tick * TICK_DT;
          if (now - p.lockMsgAt > 2) {
            p.lockMsgAt = now;
            this.events.push({ e: 'msg', text: `Porta blindata: serve la tessera` });
          }
          return;
        }
        if (this.doorOpen[di] >= 1 || this.doorDir[di] > 0) this.closeDoor(di);
        else this.openDoor(di);
        return;
      }
      if (this.level.walls[i] === TEX_EXIT) { this.reachExit(p); return; }
      if (this.level.walls[i] !== 0) return;
    }
  }

  private reachExit(p: SPlayer): void {
    if (this.mode !== 'coop' || this.pendingLevel > 0) return;
    this.events.push({ e: 'msg', text: `${p.name} ha raggiunto l'uscita! Livello ${this.levelNum} completato` });
    const cleared = this.enemies.every((e) => e.state === ES_DEAD);
    for (const o of this.players.values()) {
      o.score += 1000;
      o.delta.exits++;
      o.delta.matches++;
      this.award(o, XP_EXIT, 'livello completato');
      if (cleared) this.award(o, XP_CLEAR, 'livello ripulito');
    }
    this.pendingLevel = 3;
  }

  // ---------------------------------------------------------------- porte

  openDoor(i: number): void {
    const door = this.level.doors[i];
    if (this.doorOpen[i] >= 1 || this.doorDir[i] > 0) { this.doorHold[i] = DOOR_HOLD; return; }
    this.doorDir[i] = 1;
    if (door.secret) this.events.push({ e: 'secret', x: door.x, y: door.y });
    else this.events.push({ e: 'door', x: door.x, y: door.y, open: 1 });
  }

  private closeDoor(i: number): void {
    if (this.doorOccupied(i)) return;
    this.doorDir[i] = -1;
    const door = this.level.doors[i];
    this.events.push({ e: 'door', x: door.x, y: door.y, open: 0 });
  }

  private doorOccupied(i: number): boolean {
    const door = this.level.doors[i];
    const inCell = (x: number, y: number, r: number) =>
      x + r > door.x && x - r < door.x + 1 && y + r > door.y && y - r < door.y + 1;
    for (const p of this.players.values()) if (p.alive && inCell(p.x, p.y, PLAYER_RADIUS)) return true;
    for (const e of this.enemies) if (e.state !== ES_DEAD && inCell(e.x, e.y, ENEMY_RADIUS)) return true;
    return false;
  }

  private updateDoors(dt: number): void {
    const doors = this.level.doors;
    for (let i = 0; i < doors.length; i++) {
      const dir = this.doorDir[i];
      if (doors[i].secret) {
        if (dir > 0) {
          this.doorOpen[i] = Math.min(1, this.doorOpen[i] + dt / (DOOR_TIME * 1.5));
          if (this.doorOpen[i] >= 1) this.doorDir[i] = 0;
        }
        continue;
      }
      if (dir > 0) {
        this.doorOpen[i] += dt / DOOR_TIME;
        if (this.doorOpen[i] >= 1) { this.doorOpen[i] = 1; this.doorDir[i] = 0; this.doorHold[i] = DOOR_HOLD; }
      } else if (dir < 0) {
        if (this.doorOccupied(i)) { this.doorDir[i] = 1; continue; }
        this.doorOpen[i] -= dt / DOOR_TIME;
        if (this.doorOpen[i] <= 0) { this.doorOpen[i] = 0; this.doorDir[i] = 0; }
      } else if (this.doorOpen[i] >= 1) {
        this.doorHold[i] -= dt;
        if (this.doorHold[i] <= 0) {
          if (this.doorOccupied(i)) this.doorHold[i] = 1;
          else this.closeDoor(i);
        }
      }
    }
  }

  // ---------------------------------------------------------------- danni

  private damageEnemy(e: SEnemy, dmg: number, by: SPlayer): void {
    e.hp -= dmg;
    this.events.push({ e: 'hurt', id: e.id, by: by.id });
    if (e.hp <= 0) {
      e.state = ES_DEAD;
      by.score += e.def.score;
      by.delta.kills++;
      this.award(by, XP_ENEMY[e.kind], e.def.name);
      this.events.push({ e: 'die', id: e.id, x: r2(e.x), y: r2(e.y) });
      if (e.kind !== 'hound') this.dynItems.push({ id: this.nextDynId++, kind: e.kind === 'officer' ? 'grenade' : 'clip', x: e.x, y: e.y });
      return;
    }
    if (e.state === ES_IDLE) this.wake(e, by);
    else e.target = by.id;
    if (rand() < 0.6) { e.state = ES_PAIN; e.timer = 0.25; }
  }

  private damagePlayer(v: SPlayer, dmg: number, by: SPlayer | null, enemy: SEnemy | null): void {
    if (!v.alive) return;
    if (v.armor > 0) {
      const absorbed = Math.min(v.armor, Math.round(dmg / 2));
      v.armor -= absorbed;
      dmg -= absorbed;
    }
    v.hp -= dmg;
    this.events.push({ e: 'hurt', id: v.id, by: by ? by.id : enemy ? enemy.id : 0 });
    if (v.hp > 0) return;
    v.hp = 0;
    v.alive = false;
    v.deaths++;
    v.delta.deaths++;
    v.streak = 0;
    v.respawn = RESPAWN_TIME;
    v.queue.length = 0;
    const carried = this.flags.some((f) => f.carrier === v.id);
    this.dropFlag(v);
    this.events.push({ e: 'die', id: v.id, x: r2(v.x), y: r2(v.y) });
    const killer = by ? by.name : enemy ? enemy.def.name : '?';
    this.events.push({ e: 'kill', by: killer, vic: v.name });
    if (by && by !== v) {
      by.frags++;
      by.score += 100;
      by.delta.frags++;
      by.streak++;
      by.delta.bestStreak = Math.max(by.delta.bestStreak, by.streak);
      this.award(by, XP_FRAG, `frag su ${v.name}`);
      if (carried) this.award(by, XP_CARRIER_KILL, 'portatore fermato');
      if (this.mode === 'tdm') {
        this.teamScore[by.team]++;
        if (this.teamScore[by.team] >= TDM_LIMIT) this.endMatch(by.team);
      }
      const bonus = XP_STREAK[Math.min(by.streak, XP_STREAK.length - 1)];
      if (bonus && by.streak < XP_STREAK.length) {
        this.award(by, bonus, `serie di ${by.streak}`);
        this.events.push({ e: 'msg', text: `${by.name}: serie di ${by.streak} eliminazioni!` });
      }
      if (this.mode === 'dm' && by.frags >= FRAG_LIMIT && this.pendingLevel <= 0) {
        this.events.push({ e: 'msg', text: `${by.name} vince la partita con ${by.frags} frag!` });
        by.delta.wins++;
        this.award(by, XP_WIN, 'vittoria');
        for (const o of this.players.values()) o.delta.matches++;
        this.pendingLevel = 5;
      }
    }
  }

  // ---------------------------------------------------------------- nemici

  private wake(e: SEnemy, p: SPlayer): void {
    e.state = ES_CHASE;
    e.target = p.id;
    e.cooldown = e.def.reaction + rand() * 0.4;
    this.events.push({ e: 'alert', id: e.id, x: r2(e.x), y: r2(e.y) });
  }

  private noise(p: SPlayer): void {
    for (const e of this.enemies) {
      if (e.state !== ES_IDLE) continue;
      const d = Math.hypot(e.x - p.x, e.y - p.y);
      if (d < 6 || (d < 14 && lineOfSight(this.level, this.doorOpen, e.x, e.y, p.x, p.y))) this.wake(e, p);
    }
  }

  private updateEnemies(dt: number): void {
    if (!this.enemies.length) return;
    const alive = [...this.players.values()].filter((p) => p.alive);
    const W = this.level.w;
    distanceField(this.level, this.doorOpen, alive.map((p) => Math.floor(p.y) * W + Math.floor(p.x)), this.field, this.queue);

    for (const e of this.enemies) {
      if (e.state === ES_DEAD) continue;
      e.cooldown -= dt;
      e.timer -= dt;
      if (e.state === ES_IDLE) {
        if ((this.tick + e.id) % 3 !== 0) continue;
        for (const p of alive) {
          const d = Math.hypot(p.x - e.x, p.y - e.y);
          if (d > 22) continue;
          const facing = Math.abs(angleDiff(Math.atan2(p.y - e.y, p.x - e.x), e.a)) < 1.3;
          if ((facing || d < 1.6) && lineOfSight(this.level, this.doorOpen, e.x, e.y, p.x, p.y)) { this.wake(e, p); break; }
        }
        continue;
      }
      if (e.state === ES_PAIN) {
        if (e.timer <= 0) e.state = ES_CHASE;
        continue;
      }
      let t = this.players.get(e.target);
      if (!t || !t.alive) {
        t = undefined;
        let best = 1e9;
        for (const p of alive) {
          const d = Math.hypot(p.x - e.x, p.y - e.y);
          if (d < best) { best = d; t = p; }
        }
        if (!t) { e.state = ES_IDLE; continue; }
        e.target = t.id;
      }
      const dx = t.x - e.x, dy = t.y - e.y;
      const dist = Math.hypot(dx, dy);
      if ((this.tick + e.id) % 2 === 0) e.sees = lineOfSight(this.level, this.doorOpen, e.x, e.y, t.x, t.y);

      if (e.state === ES_AIM) {
        e.a = Math.atan2(dy, dx);
        if (e.timer > 0) continue;
        this.enemyAttack(e, t, dist);
        e.state = ES_CHASE;
        continue;
      }

      // ES_CHASE
      if (e.def.melee) {
        if (dist < e.def.range + PLAYER_RADIUS && e.cooldown <= 0) {
          e.a = Math.atan2(dy, dx);
          this.enemyAttack(e, t, dist);
          continue;
        }
      } else if (e.sees && dist < e.def.range && e.cooldown <= 0) {
        e.state = ES_AIM;
        e.timer = e.def.reaction;
        e.a = Math.atan2(dy, dx);
        continue;
      }
      // Gli sparatori si fermano se hanno il bersaglio vicino e in vista.
      if (!e.def.melee && e.sees && dist < 2.5) { e.a = Math.atan2(dy, dx); continue; }
      this.enemyMove(e, t, dist, dt);
    }
  }

  private enemyAttack(e: SEnemy, t: SPlayer, dist: number): void {
    const kindIdx = ENEMY_KINDS.indexOf(e.kind);
    this.events.push({ e: 'shot', id: e.id, w: ENEMY_WEAPON_BASE + kindIdx, x: r2(e.x), y: r2(e.y) });
    e.cooldown = e.def.cooldown * (0.7 + rand() * 0.6);
    if (e.def.melee) {
      if (dist < e.def.range + PLAYER_RADIUS + 0.2) this.damagePlayer(t, randInt(e.def.dmgMin, e.def.dmgMax), null, e);
      return;
    }
    if (!lineOfSight(this.level, this.doorOpen, e.x, e.y, t.x, t.y)) return;
    const chance = Math.max(0.15, Math.min(0.9, 1.1 - dist / 12));
    if (rand() < chance) {
      const falloff = Math.max(0.5, Math.min(1, 1.3 - dist / 12));
      this.damagePlayer(t, Math.round(randInt(e.def.dmgMin, e.def.dmgMax) * falloff), null, e);
    }
  }

  private enemyMove(e: SEnemy, t: SPlayer, dist: number, dt: number): void {
    const W = this.level.w;
    const cx = Math.floor(e.x), cy = Math.floor(e.y);
    const cur = this.field[cy * W + cx];
    let tx = t.x, ty = t.y;
    if (cur > 1) {
      let best = cur, bx = -1, by = -1;
      for (const [ox, oy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const v = this.field[(cy + oy) * W + cx + ox];
        if (v >= 0 && v < best) { best = v; bx = cx + ox; by = cy + oy; }
      }
      if (bx < 0) return;
      const di = this.level.doorAt[by * W + bx];
      if (di >= 0 && this.doorOpen[di] < 0.9) {
        this.openDoor(di);
        e.a = Math.atan2(by + 0.5 - e.y, bx + 0.5 - e.x);
        return;
      }
      tx = bx + 0.5; ty = by + 0.5;
    } else if (cur < 0) {
      return;
    } else if (dist < (e.def.melee ? 0.55 : 1.2)) {
      return;
    }
    const mx = tx - e.x, my = ty - e.y;
    const ml = Math.hypot(mx, my);
    if (ml < 1e-4) return;
    e.a = Math.atan2(my, mx);
    const step = Math.min(ml, e.def.speed * dt);
    moveWithCollision(this.level, this.doorOpen, e, (mx / ml) * step, (my / ml) * step, ENEMY_RADIUS);
  }

  // ---------------------------------------------------------------- oggetti

  private tryPickup(p: SPlayer, kind: ItemKind): boolean {
    const maxHp = p.perks.maxHp;
    const ammo = (n: number) => Math.min(MAX_AMMO, p.ammo + Math.round(n * p.perks.ammoMul));
    switch (kind) {
      case 'medkit': if (p.hp >= maxHp) return false; p.hp = Math.min(maxHp, p.hp + 25); return true;
      case 'food': if (p.hp >= maxHp) return false; p.hp = Math.min(maxHp, p.hp + 10); return true;
      case 'ammo': if (p.ammo >= MAX_AMMO) return false; p.ammo = ammo(8); return true;
      case 'clip': if (p.ammo >= MAX_AMMO) return false; p.ammo = ammo(4); return true;
      case 'smg':
        p.ammo = Math.min(MAX_AMMO, p.ammo + 6);
        if (!p.weapons[2]) { p.weapons[2] = true; if (p.weapon < 2) p.weapon = 2; }
        return true;
      case 'chaingun':
        p.ammo = Math.min(MAX_AMMO, p.ammo + 20);
        if (!p.weapons[3]) { p.weapons[3] = true; p.weapon = 3; }
        return true;
      case 'coins': p.score += 100; p.delta.treasure++; this.award(p, XP_COINS, 'monete'); return true;
      case 'gem': p.score += 500; p.delta.treasure++; this.award(p, XP_GEM, 'gemma'); return true;
      case 'vest': if (p.armor >= MAX_ARMOR) return false; p.armor = Math.min(MAX_ARMOR, p.armor + VEST_ARMOR); return true;
      case 'grenade': if (p.grenades >= MAX_GRENADES) return false; p.grenades = Math.min(MAX_GRENADES, p.grenades + 2); return true;
      case 'key':
        this.hasKey = true;
        this.award(p, XP_KEY, 'tessera');
        this.events.push({ e: 'msg', text: `${p.name} ha trovato la tessera: le porte blindate si aprono` });
        return true;
    }
    return false;
  }

  private updateItems(dt: number): void {
    const items = this.level.items;
    if (this.pvp) {
      for (let i = 0; i < items.length; i++) {
        if (this.itemGone[i] && (this.itemRespawn[i] -= dt) <= 0) this.itemGone[i] = 0;
      }
    }
    for (const p of this.players.values()) {
      if (!p.alive) continue;
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (this.itemGone[i] || Math.abs(it.x - p.x) > 0.55 || Math.abs(it.y - p.y) > 0.55) continue;
        if (this.tryPickup(p, it.kind)) {
          this.itemGone[i] = 1;
          this.itemRespawn[i] = 20;
          this.events.push({ e: 'pick', id: p.id, k: ITEM_KINDS.indexOf(it.kind) });
        }
      }
      for (let i = this.dynItems.length - 1; i >= 0; i--) {
        const it = this.dynItems[i];
        if (Math.abs(it.x - p.x) > 0.55 || Math.abs(it.y - p.y) > 0.55) continue;
        if (this.tryPickup(p, it.kind)) {
          this.dynItems.splice(i, 1);
          this.events.push({ e: 'pick', id: p.id, k: ITEM_KINDS.indexOf(it.kind) });
        }
      }
    }
  }

  // ---------------------------------------------------------------- documenti (cattura)

  private dropFlag(p: SPlayer): void {
    for (const f of this.flags) {
      if (f.carrier !== p.id) continue;
      f.carrier = -1;
      f.state = FLAG_DROPPED;
      f.x = p.x; f.y = p.y;
      f.returnIn = FLAG_RETURN_TIME;
      this.events.push({ e: 'flag', k: 'drop', team: f.team, by: p.id });
      this.events.push({ e: 'msg', text: `${p.name} perde i documenti ${TEAMS[f.team].name}` });
    }
  }

  private returnFlag(f: Flag): void {
    f.state = FLAG_HOME;
    f.carrier = -1;
    f.x = f.homeX; f.y = f.homeY;
  }

  private updateFlags(dt: number): void {
    for (const f of this.flags) {
      if (f.state === FLAG_CARRIED) {
        const c = this.players.get(f.carrier);
        if (c) { f.x = c.x; f.y = c.y; }
      } else if (f.state === FLAG_DROPPED && (f.returnIn -= dt) <= 0) {
        this.returnFlag(f);
        this.events.push({ e: 'flag', k: 'return', team: f.team, by: -1 });
        this.events.push({ e: 'msg', text: `I documenti ${TEAMS[f.team].name} tornano alla base` });
      }
    }
    if (this.pendingLevel > 0) return;
    for (const p of this.players.values()) {
      if (!p.alive || p.team < 0) continue;
      for (const f of this.flags) {
        if (f.state === FLAG_CARRIED || Math.abs(f.x - p.x) > FLAG_TOUCH || Math.abs(f.y - p.y) > FLAG_TOUCH) continue;
        if (f.team !== p.team) {
          // documenti avversari: si prendono, alla base o da terra
          f.state = FLAG_CARRIED;
          f.carrier = p.id;
          this.award(p, XP_FLAG_TAKE, 'documenti presi');
          this.events.push({ e: 'flag', k: 'take', team: f.team, by: p.id });
          this.events.push({ e: 'msg', text: `${p.name} ha preso i documenti ${TEAMS[f.team].name}!` });
        } else if (f.state === FLAG_DROPPED) {
          // propri documenti a terra: si riportano subito alla base
          this.returnFlag(f);
          this.award(p, XP_FLAG_RETURN, 'documenti recuperati');
          this.events.push({ e: 'flag', k: 'return', team: f.team, by: p.id });
          this.events.push({ e: 'msg', text: `${p.name} riporta i documenti ${TEAMS[f.team].name} alla base` });
        } else {
          // alla propria base con i documenti nemici, e i propri al loro posto: cattura
          const enemyFlag = this.flags.find((g) => g.team !== p.team && g.carrier === p.id);
          if (!enemyFlag) continue;
          this.returnFlag(enemyFlag);
          this.teamScore[p.team]++;
          p.score += 500;
          p.delta.captures++;
          this.award(p, XP_CAPTURE, 'cattura');
          this.events.push({ e: 'flag', k: 'cap', team: enemyFlag.team, by: p.id });
          this.events.push({ e: 'msg', text: `${p.name} cattura i documenti! ${TEAMS[0].name} ${this.teamScore[0]} – ${this.teamScore[1]} ${TEAMS[1].name}` });
          if (this.teamScore[p.team] >= CTF_LIMIT) this.endMatch(p.team);
        }
      }
    }
  }

  /** Fine partita a squadre: winner = squadra vincente, -1 = pareggio. */
  private endMatch(winner: number): void {
    if (this.pendingLevel > 0) return;
    const [a, b] = this.teamScore;
    this.events.push({
      e: 'msg',
      text: winner < 0 ? `Pareggio ${a} – ${b}` : `Vince la squadra ${TEAMS[winner].name}! ${TEAMS[0].name} ${a} – ${b} ${TEAMS[1].name}`,
    });
    for (const p of this.players.values()) {
      p.delta.matches++;
      if (p.team === winner) {
        p.delta.wins++;
        this.award(p, XP_TEAM_WIN, 'vittoria di squadra');
      }
    }
    const war = this.clanWar();
    if (war) {
      this.hooks.clanMatch?.(this.mode, war[0], war[1], winner < 0 ? null : war[winner]);
      this.events.push({ e: 'msg', text: winner < 0 ? `Sfida tra clan [${war[0]}] e [${war[1]}]: pareggio` : `Il clan [${war[winner]}] vince la sfida contro [${war[1 - winner]}]` });
    }
    this.pendingLevel = 6;
  }

  // ---------------------------------------------------------------- ciclo

  update(dt: number): void {
    this.tick++;
    for (const p of this.players.values()) this.runCommands(p);
    this.updateDoors(dt);
    if (this.mode === 'coop') this.updateEnemies(dt);
    this.updateItems(dt);
    this.updateGrenades(dt);
    if (this.mode === 'ctf') this.updateFlags(dt);
    if (this.teams && this.pendingLevel <= 0 && (this.timeLeft -= dt) <= 0) {
      this.timeLeft = 0;
      const [a, b] = this.teamScore;
      this.endMatch(a === b ? -1 : a > b ? 0 : 1);
    }

    for (const p of this.players.values()) {
      p.delta.playtime += dt;
      if (!p.alive && (p.respawn -= dt) <= 0) this.spawn(p, true);
    }

    if (this.pendingLevel > 0 && (this.pendingLevel -= dt) <= 0) this.nextLevel();
    if ((this.flushTimer -= dt) <= 0) { this.flushTimer = FLUSH_EVERY; this.flushAll(); }
    this.recordHistory();
    this.broadcast();
    this.events = [];
  }

  private nextLevel(): void {
    this.flushAll();
    this.levelNum++;
    this.loadLevel(hashSeed(this.baseSeed, this.levelNum));
    const msg = JSON.stringify({ t: 'level', seed: this.level.seed, lvl: this.levelNum });
    for (const p of this.players.values()) {
      if (this.pvp) { p.frags = 0; p.deaths = 0; p.score = 0; p.streak = 0; }
    }
    if (this.teams) this.formTeams();
    for (const p of this.players.values()) {
      // In cooperativa si tengono armi e munizioni tra un livello e l'altro.
      this.spawn(p, this.pvp || !p.alive);
      p.queue.length = 0;
      p.ws.send(msg);
    }
  }

  private broadcast(): void {
    const p: NetPlayer[] = [];
    for (const s of this.players.values()) {
      p.push({
        id: s.id, n: s.name, c: s.color, x: r2(s.x), y: r2(s.y), a: r2(s.a), al: s.alive ? 1 : 0, w: s.weapon, k: s.frags, sc: s.score, d: s.deaths,
        lv: s.level, h: s.hat, tg: s.tag, reg: s.userId !== null ? 1 : 0, tm: s.team,
      });
    }
    const en: NetEnemy[] = this.enemies.map((e) => ({ id: e.id, k: ENEMY_KINDS.indexOf(e.kind), x: r2(e.x), y: r2(e.y), a: r2(e.a), s: e.state }));
    const d: number[] = [];
    for (let i = 0; i < this.doorOpen.length; i++) if (this.doorOpen[i] > 0) d.push(i, Math.round(this.doorOpen[i] * 100));
    const gone: number[] = [];
    for (let i = 0; i < this.itemGone.length; i++) if (this.itemGone[i]) gone.push(i);
    const di: number[] = [];
    for (const it of this.dynItems) di.push(it.id, ITEM_KINDS.indexOf(it.kind), Math.round(it.x * 100), Math.round(it.y * 100));
    const extra = this.teams ? {
      ts: this.teamScore,
      tl: Math.ceil(this.timeLeft),
      fl: this.flags.length ? this.flags.flatMap((f) => [f.state, Math.round(f.x * 100), Math.round(f.y * 100), f.carrier]) : undefined,
    } : {};
    const pj = this.grenades.length ? this.grenades.flatMap((g) => [Math.round(g.x * 100), Math.round(g.y * 100)]) : undefined;
    const body = JSON.stringify({ tk: this.tick, p, en, d, gone, di, pj, ev: this.events, ...extra });
    for (const s of this.players.values()) {
      if (s.ws.readyState !== 1) continue;
      const me: NetMe = {
        hp: s.hp, am: s.ammo, w: s.weapon, rs: r2(Math.max(0, s.respawn)), xp: this.xpOf(s), lv: s.level, mhp: s.perks.maxHp,
        ar: s.armor, gr: s.grenades, key: this.hasKey ? 1 : 0,
        wp: s.weapons.reduce((m, has, i) => (has ? m | (1 << i) : m), 0),
      };
      s.ws.send(`{"t":"snap","ack":${s.lastSeq},"me":${JSON.stringify(me)},${body.slice(1)}`);
    }
  }
}
