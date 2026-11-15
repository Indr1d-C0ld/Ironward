// Server HTTP (file statici del client) + WebSocket di gioco sulla stessa porta.
// Avvio: node server/main.ts   (variabili: PORT, HOST)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { MAX_PLAYERS, TICK_DT, parseMode, type GameMode } from '../shared/defs.ts';
import type { ClientMsg, InputCmd, WelcomeMsg } from '../shared/protocol.ts';
import { seedFromString } from '../shared/rng.ts';
import { colorUnlocked, hatUnlocked, levelFromXp, perksFor } from '../shared/progression.ts';
import { Room, type PlayerInfo, type SPlayer } from './room.ts';
import { GameDb, type User } from './db.ts';
import { createApi } from './api.ts';

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? '0.0.0.0';
const CLIENT_DIR = resolve(fileURLToPath(new URL('../client', import.meta.url)));
const DB_PATH = process.env.DB_PATH ?? resolve(fileURLToPath(new URL('../data/ironward.db', import.meta.url)));

const db = new GameDb(DB_PATH);
/** Giocatori registrati attualmente connessi, per userId. */
const online = new Map<number, { room: Room; player: SPlayer }>();

/** Toglie un giocatore dalla partita mostrandogli un messaggio. */
function expel(r: Room, p: SPlayer, text: string): void {
  try { p.ws.send(JSON.stringify({ t: 'error', text })); } catch { /* connessione già chiusa */ }
  r.removePlayer(p.id);
  if (p.userId !== null && online.get(p.userId)?.player === p) online.delete(p.userId);
  p.ws.close();
}

const handleApi = createApi(db, {
  admin: {
    rooms: () => [...rooms.values()].map((r) => ({
      name: r.name, mode: r.mode, level: r.levelNum, timeLeft: Math.round(r.timeLeft),
      players: [...r.players.values()].map((p) => ({
        id: p.id, name: p.name, tag: p.tag, userId: p.userId, level: levelFromXp(p.xpBase + p.delta.xp), team: p.team, frags: p.frags, score: p.score,
      })),
    })),
    kick: (room, id, reason) => {
      const r = rooms.get(room), p = r?.players.get(id);
      if (!r || !p) return false;
      r.events.push({ e: 'msg', text: `${p.name} è stato espulso` });
      expel(r, p, `Espulso: ${reason}`);
      return true;
    },
    kickUser: (uid, reason) => {
      const o = online.get(uid);
      if (o) expel(o.room, o.player, reason);
    },
    flushUser: (uid) => {
      const o = online.get(uid);
      if (o) o.room.flush(o.player);
    },
    syncUsers: (ids) => {
      for (const id of ids) {
        const o = online.get(id);
        const u = db.userById(id);
        if (!o || !u) continue;
        const p = o.player;
        p.name = u.profile.name;
        p.tag = u.profile.tag;
        p.xpBase = u.profile.xp;
        p.level = levelFromXp(p.xpBase + p.delta.xp);
        p.perks = perksFor(p.level, o.room.mode === 'coop');
      }
    },
    broadcast: (text, room) => {
      let n = 0;
      for (const r of rooms.values()) {
        if (room && r.name !== room) continue;
        r.events.push({ e: 'msg', text: `[Amministrazione] ${text}` });
        n++;
      }
      return n;
    },
    closeRoom: (name, reason) => {
      const r = rooms.get(name);
      if (!r) return false;
      for (const p of [...r.players.values()]) expel(r, p, reason);
      rooms.delete(name);
      console.log(`[stanza] "${name}" chiusa da un amministratore`);
      return true;
    },
  },
  // Il profilo restituito dall'API include anche l'EXP non ancora salvata della partita in corso.
  liveProfile: (u: User) => {
    const o = online.get(u.id);
    if (!o) return u;
    const d = o.player.delta;
    const xp = u.profile.xp + d.xp;
    return { ...u, profile: { ...u.profile, xp, level: levelFromXp(xp) } };
  },
  // La nuova sigla compare subito sopra la testa; la squadra cambia dalla partita successiva.
  clanChanged: (ids) => {
    for (const id of ids) {
      const o = online.get(id);
      if (o) o.player.tag = db.userById(id)?.profile.tag ?? '';
    }
  },
});

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.map': 'application/json',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://x');
    let path = decodeURIComponent(url.pathname);
    if (path === '/') path = '/index.html';
    if (path === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(stats())); return; }
    if (path.startsWith('/api/')) { await handleApi(req, res, path, url); return; }
    const file = normalize(join(CLIENT_DIR, path));
    if (!file.startsWith(CLIENT_DIR + '/') || file.includes('/node_modules/')) { res.writeHead(403); res.end(); return; }
    const st = await stat(file).catch(() => null);
    if (!st || !st.isFile()) { res.writeHead(404); res.end('404'); return; }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(500); res.end();
  }
});

const rooms = new Map<string, Room>();
let nextId = 1;

function stats() {
  return { rooms: [...rooms.values()].map((r) => ({ name: r.name, mode: r.mode, players: r.players.size, level: r.levelNum })) };
}

function sanitizeName(s: unknown): string {
  const name = String(s ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').trim().slice(0, 16);
  return name || 'Recluta';
}

function validCmd(c: unknown): c is InputCmd {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return ['q', 'f', 's', 'a', 'b', 'w'].every((k) => typeof o[k] === 'number' && Number.isFinite(o[k]));
}

const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 });

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null;
  let player: SPlayer | null = null;
  let msgCount = 0;
  const rateTimer = setInterval(() => { msgCount = 0; }, 1000);

  ws.on('message', (data) => {
    if (++msgCount > 120) return;
    let msg: ClientMsg;
    try { msg = JSON.parse(String(data)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'join' && !room) {
      const roomName = String(msg.room ?? '').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'lobby';
      const mode: GameMode = parseMode(msg.mode);
      let r = rooms.get(roomName);
      if (r && r.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ t: 'error', text: 'Stanza piena' })); return; }

      // Account registrato (token) oppure ospite.
      let info: PlayerInfo;
      const user = msg.token ? db.userByToken(msg.token) : null;
      if (msg.token && !user) { ws.send(JSON.stringify({ t: 'error', text: 'Sessione scaduta: accedi di nuovo' })); return; }
      if (user) {
        const prof = user.profile;
        const prev = online.get(user.id);
        if (prev) {
          prev.player.ws.send(JSON.stringify({ t: 'error', text: 'Account connesso da un’altra finestra' }));
          prev.player.ws.close();
          prev.room.removePlayer(prev.player.id);
          online.delete(user.id);
        }
        info = {
          name: prof.name, tag: prof.tag, userId: user.id, xp: prof.xp,
          color: colorUnlocked(prof.color, prof.level) ? prof.color : 0,
          hat: hatUnlocked(prof.hat, prof.level) ? prof.hat : 0,
        };
      } else {
        const color = Number.isInteger(msg.color) && colorUnlocked(msg.color, 1) ? msg.color : 0;
        info = { name: sanitizeName(msg.name), color, hat: 0, tag: '', userId: null, xp: 0 };
      }

      if (!r) {
        const seedStr = String(msg.seed ?? '').trim().slice(0, 32);
        const seed = seedStr ? seedFromString(seedStr) : (Math.random() * 2 ** 32) >>> 0;
        r = new Room(roomName, mode, seed, {
          flush: (uid, delta, m) => db.applyDelta(uid, delta, m),
          clanMatch: (m, a, b, w) => db.recordClanMatch(m, a, b, w),
        });
        rooms.set(roomName, r);
        console.log(`[stanza] creata "${roomName}" ${mode} seed=${seed}`);
      }
      room = r;
      player = r.addPlayer(nextId++, ws, info);
      if (info.userId !== null) online.set(info.userId, { room: r, player });
      const welcome: WelcomeMsg = { t: 'welcome', id: player.id, reg: info.userId !== null, room: r.name, mode: r.mode, seed: r.seed, lvl: r.levelNum };
      ws.send(JSON.stringify(welcome));
      console.log(`[stanza] ${player.name} (#${player.id}${user ? '' : ', ospite'}) entra in "${r.name}"`);
      return;
    }
    if (!room || !player) return;
    if (msg.t === 'in' && Array.isArray(msg.c)) {
      room.enqueue(player, msg.c.slice(0, 30).filter(validCmd));
    } else if (msg.t === 'chat' && typeof msg.text === 'string') {
      const text = msg.text.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
      if (text) room.events.push({ e: 'msg', text: `${player.name}: ${text}` });
    }
  });

  ws.on('close', () => {
    clearInterval(rateTimer);
    if (!room || !player) return;
    if (room.players.get(player.id) === player) room.removePlayer(player.id);
    if (player.userId !== null && online.get(player.userId)?.player === player) online.delete(player.userId);
  });
});

// Ciclo di simulazione a passo fisso.
let last = performance.now();
let acc = 0;
setInterval(() => {
  const now = performance.now();
  acc += Math.min(0.25, (now - last) / 1000);
  last = now;
  while (acc >= TICK_DT) {
    acc -= TICK_DT;
    for (const [name, r] of rooms) {
      if (r.players.size === 0) {
        if ((r.emptyFor += TICK_DT) > 60) { rooms.delete(name); console.log(`[stanza] chiusa "${name}"`); }
        continue;
      }
      r.emptyFor = 0;
      r.update(TICK_DT);
    }
  }
}, 1000 / 60);

http.listen(PORT, HOST, () => console.log(`Ironward in ascolto su http://${HOST}:${PORT} (db: ${DB_PATH})`));

// Allo spegnimento salva le statistiche in sospeso di tutti i giocatori.
function shutdown(sig: string): void {
  console.log(`[server] ${sig}: salvataggio statistiche e chiusura`);
  for (const r of rooms.values()) r.flushAll();
  db.close();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
