// Client: input, rete con predizione/riconciliazione, interpolazione e rendering.

import {
  ENEMY_KINDS, ES_AIM, ES_CHASE, ES_DEAD, ES_PAIN, INPUT_DT, ITEM_KINDS, PLAYER_COLORS, TEAMS, TICK_DT, WEAPONS, isTeamMode, type GameMode,
} from '../shared/defs.ts';
import { generateLevel, type Level } from '../shared/level.ts';
import { applyPlayerInput } from '../shared/physics.ts';
import {
  BTN_FIRE, BTN_THROW, BTN_USE, ENEMY_ID_BASE, ENEMY_WEAPON_BASE,
  type InputCmd, type NetEnemy, type NetEvent, type NetMe, type NetPlayer, type ServerMsg, type SnapMsg,
} from '../shared/protocol.ts';
import { buildTextures, drawWeapon, enemySpriteKey, playerSpriteKey, setWeaponImages, SpriteBank, viewIndex, type Pose } from './art.ts';
import { loadAtlas } from './atlas.ts';
import { clearToken, initMenu, type PlayOptions } from './menu.ts';
import { unlocksAt } from '../shared/progression.ts';
import { Sfx, type SfxName } from './audio.ts';
import { drawHud } from './hud.ts';
import { Renderer, type SpriteInst } from './render.ts';

const INTERP_MS = 110;
const MOUSE_SENS = 0.0026;
const TURN_SPEED = 2.8;
const LOW_RES_H = 270;

interface Snap { time: number; players: Map<number, NetPlayer>; enemies: Map<number, NetEnemy>; doors: Float32Array; }

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const screen = $<HTMLCanvasElement>('screen');
const sctx = screen.getContext('2d')!;
const menu = $<HTMLDivElement>('menu');
const chatInput = $<HTMLInputElement>('chat');
const textures: (Uint8Array | Uint32Array)[] = buildTextures();
const spriteTex = new SpriteBank();
// Sprite e armi disegnati con PixelLab, caricati in parallelo senza bloccare il menu;
// finché non arrivano (o se mancano) si usa la grafica procedurale.
void loadAtlas().then((pixellab) => {
  if (pixellab) {
    spriteTex.setAtlas(pixellab.atlas);
    for (const [t, tex] of pixellab.walls) textures[t] = tex;
    setWeaponImages(pixellab.weapons, pixellab.atlas.muzzle, pixellab.atlas.muzzleX);
    return;
  }
  // le figure procedurali dei nemici si preparano a pezzi nei momenti liberi
  const todo: string[] = [];
  for (const kind of ['guard', 'trooper', 'hound', 'officer']) for (const pose of ['stand', 'walk1', 'walk2', 'aim', 'fire', 'pain', 'dead'] as Pose[]) for (let v = 0; v < 8; v++) todo.push(enemySpriteKey(kind, pose, v));
  const step = () => { const t0 = performance.now(); while (todo.length && performance.now() - t0 < 6) spriteTex.get(todo.pop()!); if (todo.length) setTimeout(step, 16); };
  setTimeout(step, 50);
});
const sfx = new Sfx();

let renderer: Renderer;
function resize(): void {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  screen.width = Math.round(window.innerWidth * dpr);
  screen.height = Math.round(window.innerHeight * dpr);
  const aspect = window.innerWidth > 0 && window.innerHeight > 0 ? window.innerWidth / window.innerHeight : 16 / 9;
  const lowW = Math.max(240, Math.min(720, Math.round(LOW_RES_H * aspect)));
  const vfov = 52 * Math.PI / 180;
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * (lowW / LOW_RES_H)) * 180 / Math.PI;
  renderer = new Renderer(lowW, LOW_RES_H, Math.min(100, hfov), textures, spriteTex);
}
window.addEventListener('resize', resize);
resize();

// ------------------------------------------------------------------ stato

let ws: WebSocket | null = null;
let myId = -1;
let mode: GameMode = 'coop';
let roomName = '';
let level: Level | null = null;
let levelNum = 1;
let doorOpen = new Float32Array(0);
let snaps: Snap[] = [];
let clockOffset: number | null = null;
let me: NetMe = { hp: 100, am: 8, wp: 3, w: 1, rs: 0, xp: 0, lv: 1, mhp: 100, ar: 0, gr: 0, key: 0 };
/** granate in volo e esplosioni in corso */
let proj: { x: number; y: number }[] = [];
const booms: { x: number; y: number; t: number }[] = [];
let registered = false;
const xpPopups: { text: string; t: number }[] = [];
let levelBanner: { lvl: number; unlocks: string[]; t: number } | null = null;
let teamScore = [0, 0];
let timeLeft = 0;
/** per squadra: stato (0 base, 1 preso, 2 a terra), posizione, id del portatore */
let flags: { state: number; x: number; y: number; carrier: number }[] = [];
let alive = true;
let hardSnap = true;
let players: NetPlayer[] = [];
let gone = new Set<number>();
let dyn: { id: number; k: number; x: number; y: number }[] = [];
const feed: { text: string; t: number }[] = [];
const lastShot = new Map<number, number>();

const local = { x: 0, y: 0, a: 0 };
const prev = { x: 0, y: 0 };
const smooth = { x: 0, y: 0 };
let angle = 0;
let seq = 0;
let pending: InputCmd[] = [];
let outbox: InputCmd[] = [];
let acc = 0;
let cdLocal = 0;
let fireAnim = 0;
let localWeapon = 1;
let localAmmo = 8;
let wantWeapon = -1;
let hurt = 0, pickupFlash = 0, hitMarker = -1e9;
let bobPhase = 0, moving = 0;

// ------------------------------------------------------------------ input

const keys = new Set<string>();
let mouseDown = false;
let showMap = false;

function locked(): boolean { return document.pointerLockElement === screen; }

window.addEventListener('keydown', (e) => {
  if (document.activeElement === chatInput) return;
  if (menu.style.display !== 'none') return;
  sfx.unlock();
  if (e.code === 'Tab') e.preventDefault();
  if (e.code === 'KeyT' || e.code === 'Enter') {
    e.preventDefault();
    chatInput.style.display = 'block';
    chatInput.focus();
    document.exitPointerLock();
    keys.clear();
    return;
  }
  if (e.code === 'KeyM' && !e.repeat) showMap = !showMap;
  if (e.code === 'KeyQ' && !locked()) { location.reload(); return; }
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5)) - 1;
    if (n >= 0 && n < WEAPONS.length) wantWeapon = n;
  }
  keys.add(e.code);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => { keys.clear(); mouseDown = false; });

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const text = chatInput.value.trim();
    if (text && ws?.readyState === 1) ws.send(JSON.stringify({ t: 'chat', text }));
    chatInput.value = '';
    chatInput.blur();
    chatInput.style.display = 'none';
    void screen.requestPointerLock();
  } else if (e.key === 'Escape') {
    chatInput.value = '';
    chatInput.blur();
    chatInput.style.display = 'none';
  }
  e.stopPropagation();
});

screen.addEventListener('mousedown', (e) => {
  sfx.unlock();
  if (!locked()) { void screen.requestPointerLock(); return; }
  if (e.button === 0) mouseDown = true;
});
window.addEventListener('mouseup', (e) => { if (e.button === 0) mouseDown = false; });
window.addEventListener('mousemove', (e) => { if (locked()) angle += e.movementX * MOUSE_SENS; });
window.addEventListener('wheel', (e) => {
  if (!locked()) return;
  const dir = e.deltaY > 0 ? 1 : -1;
  let w = wantWeapon >= 0 ? wantWeapon : localWeapon;
  for (let i = 0; i < WEAPONS.length; i++) {
    w = (w + dir + WEAPONS.length) % WEAPONS.length;
    if ((me.wp >> w) & 1) break;
  }
  wantWeapon = w;
});

// ------------------------------------------------------------------ rete

function connect(o: PlayOptions): void {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => ws!.send(JSON.stringify({ t: 'join', name: o.name, color: o.color, room: o.room, mode: o.mode, seed: o.seed, token: o.token ?? undefined }));
  ws.onmessage = (ev) => onMessage(JSON.parse(ev.data as string) as ServerMsg);
  ws.onclose = () => {
    feed.push({ text: 'Connessione chiusa — premi Esc e poi Q per tornare al menu', t: performance.now() + 1e9 });
  };
}

function loadLevel(seed: number, n: number): void {
  level = generateLevel(seed, mode);
  levelNum = n;
  doorOpen = new Float32Array(level.doors.length);
  snaps = [];
  gone = new Set();
  dyn = [];
  pending = [];
  hardSnap = true;
}

function onMessage(msg: ServerMsg): void {
  if (msg.t === 'welcome') {
    myId = msg.id;
    registered = msg.reg;
    mode = msg.mode;
    roomName = msg.room;
    loadLevel(msg.seed, msg.lvl);
    history.replaceState(null, '', `?room=${encodeURIComponent(msg.room)}`);
  } else if (msg.t === 'level') {
    loadLevel(msg.seed, msg.lvl);
    sfx.play('exit');
    feed.push({ text: `Livello ${msg.lvl}`, t: performance.now() });
  } else if (msg.t === 'error') {
    if (msg.text.startsWith('Sessione scaduta')) clearToken();
    feed.push({ text: msg.text, t: performance.now() + 1e9 });
  } else if (msg.t === 'snap' && level) {
    onSnap(msg);
  }
}

function onSnap(s: SnapMsg): void {
  const now = performance.now();
  const serverMs = s.tk * TICK_DT * 1000;
  const off = now - serverMs;
  clockOffset = clockOffset === null ? off : Math.min(off, clockOffset + 0.5);

  const doors = new Float32Array(level!.doors.length);
  for (let i = 0; i < s.d.length; i += 2) doors[s.d[i]] = s.d[i + 1] / 100;
  doorOpen = doors;
  snaps.push({ time: serverMs, players: new Map(s.p.map((p) => [p.id, p])), enemies: new Map(s.en.map((e) => [e.id, e])), doors });
  if (snaps.length > 30) snaps.shift();
  players = s.p;
  gone = new Set(s.gone);
  dyn = [];
  for (let i = 0; i < s.di.length; i += 4) dyn.push({ id: s.di[i], k: s.di[i + 1], x: s.di[i + 2] / 100, y: s.di[i + 3] / 100 });
  proj = [];
  if (s.pj) for (let i = 0; i < s.pj.length; i += 2) proj.push({ x: s.pj[i] / 100, y: s.pj[i + 1] / 100 });

  me = s.me;
  if (s.ts) teamScore = s.ts;
  if (s.tl !== undefined) timeLeft = s.tl;
  flags = [];
  if (s.fl) for (let i = 0; i < s.fl.length; i += 4) flags.push({ state: s.fl[i], x: s.fl[i + 1] / 100, y: s.fl[i + 2] / 100, carrier: s.fl[i + 3] });
  localAmmo = me.am;
  pending = pending.filter((c) => c.q > s.ack);
  if (!pending.some((c) => c.w >= 0) && wantWeapon < 0) localWeapon = me.w;

  const sp = s.p.find((p) => p.id === myId);
  if (sp) {
    const wasAlive = alive;
    alive = sp.al === 1;
    if (!alive || !wasAlive || hardSnap) {
      local.x = prev.x = sp.x;
      local.y = prev.y = sp.y;
      if (hardSnap || !wasAlive) angle = sp.a;
      smooth.x = smooth.y = 0;
      hardSnap = false;
      if (!alive) pending = [];
    } else {
      const r = { x: sp.x, y: sp.y, a: angle };
      for (const c of pending) applyPlayerInput(level!, doorOpen, r, c);
      const ex = local.x - r.x, ey = local.y - r.y;
      if (Math.hypot(ex, ey) > 1.5) { smooth.x = smooth.y = 0; }
      else { smooth.x += ex; smooth.y += ey; }
      prev.x += r.x - local.x; prev.y += r.y - local.y;
      local.x = r.x; local.y = r.y;
    }
  }
  for (const ev of s.ev) onEvent(ev, now);
}

function volAt(x: number, y: number): number {
  const d = Math.hypot(x - local.x, y - local.y);
  return Math.max(0, 1 - d / 22);
}

function onEvent(ev: NetEvent, now: number): void {
  switch (ev.e) {
    case 'shot': {
      lastShot.set(ev.id, now);
      if (ev.id === myId) return;
      let name: SfxName;
      if (ev.w >= ENEMY_WEAPON_BASE) name = ENEMY_KINDS[ev.w - ENEMY_WEAPON_BASE] === 'hound' ? 'bite' : 'enemyShot';
      else name = (['knife', 'pistol', 'smg', 'chaingun'] as const)[ev.w] ?? 'pistol';
      sfx.play(name, volAt(ev.x, ev.y));
      break;
    }
    case 'hurt':
      if (ev.id === myId) { hurt = 1; sfx.play('hurt'); }
      if (ev.by === myId && ev.id !== myId) { hitMarker = now; sfx.play('hit'); }
      if (ev.id >= ENEMY_ID_BASE) {
        const e = snaps[snaps.length - 1]?.enemies.get(ev.id);
        if (e) sfx.play('pain', volAt(e.x, e.y) * 0.8);
      }
      break;
    case 'die': sfx.play('die', volAt(ev.x, ev.y)); break;
    case 'throw': sfx.play('throw', volAt(ev.x, ev.y)); break;
    case 'boom': {
      booms.push({ x: ev.x, y: ev.y, t: now });
      sfx.play('boom', volAt(ev.x, ev.y));
      const d = Math.hypot(ev.x - local.x, ev.y - local.y);
      if (d < 6) hurt = Math.max(hurt, 0.5 * (1 - d / 6));
      break;
    }
    case 'kill': feed.push({ text: `${ev.by} ✖ ${ev.vic}`, t: now }); break;
    case 'pick':
      if (ev.id === myId) {
        const k = ITEM_KINDS[ev.k];
        sfx.play(k === 'smg' || k === 'chaingun' ? 'weapon' : 'pick');
        pickupFlash = 1;
      }
      break;
    case 'door': sfx.play('door', volAt(ev.x + 0.5, ev.y + 0.5)); break;
    case 'secret':
      sfx.play('secret', volAt(ev.x + 0.5, ev.y + 0.5));
      if (volAt(ev.x, ev.y) > 0.85) feed.push({ text: 'Passaggio segreto!', t: now });
      break;
    case 'alert': sfx.play('alert', volAt(ev.x, ev.y)); break;
    case 'msg': feed.push({ text: ev.text, t: now }); break;
    case 'xp':
      if (ev.id === myId) {
        xpPopups.push({ text: `+${ev.n} EXP · ${ev.why}`, t: now });
        if (xpPopups.length > 5) xpPopups.shift();
      }
      break;
    case 'flag': {
      const mine = players.find((p) => p.id === myId)?.tm ?? -1;
      if (ev.k === 'take') sfx.play(ev.team === mine ? 'flagLost' : 'flagTake');
      else if (ev.k === 'return') sfx.play('flagReturn', 0.8);
      else if (ev.k === 'cap') sfx.play(ev.team === mine ? 'flagLost' : 'exit');
      break;
    }
    case 'lvlup':
      if (ev.id === myId) {
        levelBanner = { lvl: ev.lvl, unlocks: unlocksAt(ev.lvl, PLAYER_COLORS.map((c) => c.name)), t: now };
        sfx.play('exit');
      }
      break;
  }
}

// ------------------------------------------------------------------ simulazione locale

function inputStep(): void {
  const k = (c: string) => (keys.has(c) ? 1 : 0);
  const f = Math.max(k('KeyW'), k('ArrowUp')) - Math.max(k('KeyS'), k('ArrowDown'));
  const s = k('KeyD') - k('KeyA');
  angle += (k('ArrowRight') - k('ArrowLeft')) * TURN_SPEED * INPUT_DT;
  angle = Math.atan2(Math.sin(angle), Math.cos(angle));
  const fire = mouseDown || keys.has('ControlLeft') || keys.has('ControlRight');
  const use = keys.has('KeyE') || keys.has('Space');
  const thr = keys.has('KeyG');
  const cmd: InputCmd = { q: ++seq, f, s, a: Math.round(angle * 10000) / 10000, b: (fire ? BTN_FIRE : 0) | (use ? BTN_USE : 0) | (thr ? BTN_THROW : 0), w: wantWeapon };
  // compensazione della latenza: il tick del server che si sta guardando (gli altri sono interpolati)
  if (fire && clockOffset !== null) cmd.v = Math.round(((performance.now() - clockOffset - INTERP_MS) / (TICK_DT * 1000)) * 100) / 100;
  wantWeapon = -1;
  if (cmd.w >= 0 && (me.wp >> cmd.w) & 1) localWeapon = cmd.w;

  prev.x = local.x; prev.y = local.y;
  if (alive && level) {
    applyPlayerInput(level, doorOpen, local, cmd);
    cdLocal = Math.max(0, cdLocal - INPUT_DT);
    if (fire && cdLocal <= 0) {
      let def = WEAPONS[localWeapon];
      if (def.ammo > localAmmo) {
        localWeapon = 0;
        for (let w = WEAPONS.length - 1; w >= 1; w--) if ((me.wp >> w) & 1 && localAmmo > 0) { localWeapon = w; break; }
        def = WEAPONS[localWeapon];
      }
      if (def.ammo <= localAmmo) {
        localAmmo -= def.ammo;
        cdLocal = def.cooldown;
        fireAnim = Math.min(0.1, def.cooldown * 0.8);
        sfx.play((['knife', 'pistol', 'smg', 'chaingun'] as const)[localWeapon]);
      }
    }
  }
  moving = f !== 0 || s !== 0 ? 1 : 0;
  pending.push(cmd);
  outbox.push(cmd);
}

// ------------------------------------------------------------------ rendering

function interpolated(now: number) {
  const rt = now - (clockOffset ?? 0) - INTERP_MS;
  let a = snaps[snaps.length - 1], b = a, t = 0;
  for (let i = snaps.length - 1; i > 0; i--) {
    if (snaps[i - 1].time <= rt) {
      a = snaps[i - 1]; b = snaps[i];
      t = Math.max(0, Math.min(1, (rt - a.time) / Math.max(1, b.time - a.time)));
      break;
    }
  }
  return { a, b, t };
}

/** Differenza tra due angoli ridotta a (-pi, pi]. */
function angDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d <= -Math.PI) d += 2 * Math.PI;
  return d;
}

function poseFor(state: number, id: number, movingNow: boolean, now: number): Pose {
  if (state === ES_DEAD) return 'dead';
  if (now - (lastShot.get(id) ?? -1e9) < 140) return 'fire';
  if (state === ES_PAIN) return 'pain';
  if (state === ES_AIM) return 'aim';
  if (movingNow || state === ES_CHASE) return ((now / 220 + id) | 0) % 2 ? 'walk1' : 'walk2';
  return 'stand';
}

let last = performance.now();
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (!level || !ws) return;

  acc = Math.min(acc + dt, 0.25);
  while (acc >= INPUT_DT) { acc -= INPUT_DT; inputStep(); }
  if (outbox.length && ws.readyState === 1) { ws.send(JSON.stringify({ t: 'in', c: outbox })); outbox = []; }

  hurt = Math.max(0, hurt - dt * 2);
  pickupFlash = Math.max(0, pickupFlash - dt * 3);
  fireAnim = Math.max(0, fireAnim - dt);
  smooth.x *= Math.pow(0.001, dt);
  smooth.y *= Math.pow(0.001, dt);
  if (moving && alive) bobPhase += dt * 9;

  const alpha = acc / INPUT_DT;
  const cam = camOverride ?? { x: prev.x + (local.x - prev.x) * alpha + smooth.x, y: prev.y + (local.y - prev.y) * alpha + smooth.y, a: angle };

  const sprites: SpriteInst[] = [];
  for (const it of level.items) if (!gone.has(it.id)) sprites.push({ x: it.x, y: it.y, key: `item:${it.kind}` });
  for (const it of dyn) sprites.push({ x: it.x, y: it.y, key: `item:${ITEM_KINDS[it.k]}` });
  for (const g of proj) sprites.push({ x: g.x, y: g.y, key: 'proj:grenade' });
  // esplosioni: 4 fotogrammi in mezzo secondo
  for (let i = booms.length - 1; i >= 0; i--) {
    const f = Math.floor((now - booms[i].t) / 120);
    if (f > 3) { booms.splice(i, 1); continue; }
    sprites.push({ x: booms[i].x, y: booms[i].y, key: `fx:boom${f}` });
  }

  const others: { x: number; y: number; c: number }[] = [];
  const teams = isTeamMode(mode);
  const myTeam = players.find((p) => p.id === myId)?.tm ?? -1;
  // colore del corpo: quello della squadra nelle modalità a squadre
  const bodyColor = (p: NetPlayer) => (teams && p.tm >= 0 ? TEAMS[p.tm].color : p.c);
  level.bases.forEach((b, t) => { if (mode === 'ctf') sprites.push({ x: b.x, y: b.y, key: `base${t}` }); });
  let enemiesLeft = 0;
  if (snaps.length) {
    const { a, b, t } = interpolated(now);
    for (const e of b.enemies.values()) {
      const e0 = a.enemies.get(e.id) ?? e;
      const x = e0.x + (e.x - e0.x) * t, y = e0.y + (e.y - e0.y) * t;
      const mv = Math.abs(e.x - e0.x) + Math.abs(e.y - e0.y) > 0.001;
      if (e.s !== ES_DEAD) enemiesLeft++;
      const ea = e0.a + angDiff(e.a, e0.a) * t;
      sprites.push({ x, y, key: enemySpriteKey(ENEMY_KINDS[e.k], poseFor(e.s, e.id, mv, now), viewIndex(ea, x, y, cam.x, cam.y)) });
    }
    for (const p of b.players.values()) {
      if (p.id === myId) continue;
      const p0 = a.players.get(p.id) ?? p;
      const x = p0.x + (p.x - p0.x) * t, y = p0.y + (p.y - p0.y) * t;
      const mv = Math.abs(p.x - p0.x) + Math.abs(p.y - p0.y) > 0.001;
      const pose: Pose = p.al ? poseFor(0, p.id, mv, now) : 'dead';
      const pa = p0.a + angDiff(p.a, p0.a) * t;
      sprites.push({ x, y, key: playerSpriteKey(bodyColor(p), p.h, pose, viewIndex(pa, x, y, cam.x, cam.y)) });
      // minimappa: tutti in cooperativa, solo i compagni nelle modalità a squadre, nessuno in deathmatch
      if (p.al && (mode === 'coop' || (teams && p.tm === myTeam))) others.push({ x, y, c: bodyColor(p) });
      flags.forEach((f, t) => { if (f.state === 1 && f.carrier === p.id) sprites.push({ x, y, key: `flagc${t}` }); });
    }
  }

  const flash = fireAnim > 0 && localWeapon > 0 ? 1 : 0;
  // valigette alla base o a terra (quelle portate seguono il portatore)
  flags.forEach((f, t) => { if (f.state !== 1) sprites.push({ x: f.x, y: f.y, key: `flag${t}` }); });
  renderer.render(cam, level, doorOpen, sprites, flash);
  if (alive) {
    const bobX = Math.sin(bobPhase) * 6 * moving;
    const bobY = Math.abs(Math.cos(bobPhase)) * 5 * moving + 2;
    drawWeapon(renderer.ctx, localWeapon, fireAnim > 0, renderer.W, renderer.H, bobX, bobY);
  }

  sctx.imageSmoothingEnabled = false;
  sctx.drawImage(renderer.canvas, 0, 0, screen.width, screen.height);
  drawHud(sctx, screen.width, screen.height, {
    me: { ...me, w: localWeapon, am: localAmmo }, alive, myId, mode, room: roomName, levelNum, level, doorOpen, players,
    feed, hurt, pickup: pickupFlash, hitMarker, showScores: keys.has('Tab'), showMap, cam, others, enemiesLeft, now,
    registered, xpPopups, levelBanner, teamScore, timeLeft, flags, myTeam,
  });
  if (!locked() && chatInput.style.display !== 'block') {
    sctx.fillStyle = 'rgba(0,0,0,0.5)';
    sctx.fillRect(0, screen.height / 2 - 30, screen.width, 60);
    sctx.fillStyle = '#fff';
    sctx.textAlign = 'center';
    sctx.font = `bold ${Math.round(screen.height / 30)}px "Courier New", monospace`;
    sctx.fillText('Clicca per giocare', screen.width / 2, screen.height / 2 + 6);
  }
}
requestAnimationFrame(frame);

// Hook di sviluppo, attivo solo con ?debug nell'URL.
let camOverride: { x: number; y: number; a: number } | null = null;
if (new URLSearchParams(location.search).has('debug')) {
  Object.assign(window, {
    __iw: {
      state: () => ({ myId, alive, local: { ...local }, angle, me, players, pending: pending.length, enemies: [...(snaps[snaps.length - 1]?.enemies.values() ?? [])] }),
      lookAt: (x: number, y: number) => { angle = Math.atan2(y - local.y, x - local.x); },
      level: () => level,
      event: (ev: NetEvent) => onEvent(ev, performance.now()),
      /** sposta solo la telecamera (null per tornare al giocatore) */
      peek: (c: { x: number; y: number; a: number } | null) => { camOverride = c; },
    },
  });
}

// ------------------------------------------------------------------ menu

initMenu((o) => {
  sfx.unlock();
  menu.style.display = 'none';
  connect(o);
  void screen.requestPointerLock();
});
