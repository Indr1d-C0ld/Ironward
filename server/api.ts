// API HTTP JSON: account, profilo, classifiche.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PLAYER_COLORS } from '../shared/defs.ts';
import { colorUnlocked, hatUnlocked, sanitizeClanName, sanitizeTag } from '../shared/progression.ts';
import { CLAN_BY, LEADER_BY, UserError, type ClanBy, type GameDb, type LeaderBy, type User } from './db.ts';

const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;
const MAX_BODY = 4096;
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

/** Limite di tentativi per IP sulle rotte di autenticazione. */
class RateLimit {
  private hits = new Map<string, { n: number; reset: number }>();
  private readonly max: number;
  private readonly windowMs: number;
  constructor(max: number, windowMs: number) { this.max = max; this.windowMs = windowMs; }
  allow(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 10000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
      return true;
    }
    return ++h.n <= this.max;
  }
}

export function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    const xf = req.headers['x-forwarded-for'];
    if (typeof xf === 'string' && xf) return xf.split(',')[0].trim();
  }
  return req.socket.remoteAddress ?? '?';
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        resolve(v && typeof v === 'object' ? v : {});
      } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? h.slice(7) : null;
}

export interface ApiHooks {
  /** Profilo aggiornato con le statistiche non ancora salvate, se l'utente è in partita. */
  liveProfile?: (u: User) => User;
  /** Il clan di questi utenti è cambiato: aggiorna la sigla di chi è in partita. */
  clanChanged?: (userIds: number[]) => void;
  /** Comandi sulle stanze per la pagina di amministrazione. */
  admin?: AdminHooks;
}

export interface LivePlayer { id: number; name: string; tag: string; userId: number | null; level: number; team: number; frags: number; score: number; }
export interface LiveRoom { name: string; mode: string; level: number; timeLeft: number; players: LivePlayer[]; }

export interface AdminHooks {
  rooms(): LiveRoom[];
  /** Espelle un giocatore da una stanza; false se non c'è. */
  kick(room: string, playerId: number, reason: string): boolean;
  /** Espelle l'account, se è in partita. */
  kickUser(userId: number, reason: string): void;
  /** Salva subito le statistiche in sospeso dell'account, prima di modificarle. */
  flushUser(userId: number): void;
  /** Ricarica dal database nome, sigla ed EXP di chi è in partita. */
  syncUsers(userIds: number[]): void;
  /** Messaggio a tutte le stanze (o a una); restituisce quante stanze lo ricevono. */
  broadcast(text: string, room?: string): number;
  closeRoom(name: string, reason: string): boolean;
}

export function createApi(db: GameDb, hooks: ApiHooks = {}) {
  const authLimit = new RateLimit(12, 10 * 60e3);
  const clanLimit = new RateLimit(30, 10 * 60e3);
  const live = (u: User) => (hooks.liveProfile ? hooks.liveProfile(u) : u);

  /** Rotte /api/admin/*: solo per gli account con ruolo admin. Ogni modifica finisce nel registro. */
  async function handleAdmin(req: IncomingMessage, res: ServerResponse, method: string, action: string, url: URL): Promise<void> {
    const me = db.userByToken(bearer(req));
    if (!me) { send(res, 401, { error: 'Sessione scaduta' }); return; }
    if (!me.profile.admin) { send(res, 403, { error: 'Riservato agli amministratori' }); return; }
    const A = hooks.admin;
    const log = (act: string, target: string, detail = '') => db.logAdmin(me.id, me.profile.name, act, target, detail);
    const target = (name: unknown): User => {
      const u = db.userByName(String(name ?? ''));
      if (!u) throw new UserError('Giocatore non trovato');
      return u;
    };

    if (method === 'GET') {
      if (action === 'overview') { send(res, 200, { rooms: A?.rooms() ?? [], counts: db.counts(), me: me.profile.name }); return; }
      if (action === 'users') { send(res, 200, { rows: db.searchUsers(String(url.searchParams.get('q') ?? '').slice(0, 32)) }); return; }
      if (action === 'clans') { send(res, 200, { rows: db.listClans(String(url.searchParams.get('q') ?? '').slice(0, 32)) }); return; }
      if (action === 'log') { send(res, 200, { rows: db.adminLog() }); return; }
      send(res, 404, { error: 'Rotta sconosciuta' });
      return;
    }
    if (method !== 'POST') { send(res, 405, { error: 'Metodo non ammesso' }); return; }
    const body = await readJson(req);
    const reason = String(body.reason ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
    switch (action) {
      case 'kick': {
        const room = String(body.room ?? ''), id = Number(body.id);
        const who = A?.rooms().find((r) => r.name === room)?.players.find((p) => p.id === id);
        if (!who || !A?.kick(room, id, reason || 'espulso da un amministratore')) throw new UserError('Giocatore non più in partita');
        log('espulsione', who.name, `stanza ${room}${reason ? ` · ${reason}` : ''}`);
        break;
      }
      case 'ban': {
        const u = target(body.name);
        if (u.id === me.id) throw new UserError('Non puoi sospendere te stesso');
        db.ban(u.id, reason || 'violazione delle regole');
        A?.kickUser(u.id, `Account sospeso: ${reason || 'violazione delle regole'}`);
        log('sospensione', u.profile.name, reason);
        break;
      }
      case 'unban': {
        const u = target(body.name);
        db.unban(u.id);
        log('riattivazione', u.profile.name);
        break;
      }
      case 'rename': {
        const u = target(body.name);
        const newName = String(body.newName ?? '').trim();
        if (!NAME_RE.test(newName)) throw new UserError('Nome: 3–16 caratteri tra lettere, cifre, _ e -');
        db.renameUser(u.id, newName);
        A?.syncUsers([u.id]);
        log('cambio nome', u.profile.name, `→ ${newName}`);
        break;
      }
      case 'stats': {
        const u = target(body.name);
        A?.flushUser(u.id);
        if (body.op === 'reset') {
          db.resetStats(u.id);
          log('azzeramento statistiche', u.profile.name, `EXP prima: ${u.profile.xp}`);
        } else if (body.op === 'xp') {
          const xp = Number(body.xp);
          if (!Number.isFinite(xp) || xp < 0 || xp > 10_000_000) throw new UserError('EXP non valida');
          db.setXp(u.id, xp);
          log('correzione EXP', u.profile.name, `${u.profile.xp} → ${Math.round(xp)}`);
        } else throw new UserError('Operazione sconosciuta');
        A?.syncUsers([u.id]);
        break;
      }
      case 'clan': {
        const tag = String(body.tag ?? '');
        if (body.op === 'disband') {
          const ids = db.disbandClan(tag);
          A?.syncUsers(ids);
          log('scioglimento clan', `[${tag}]`, reason);
        } else if (body.op === 'rename') {
          const newTag = sanitizeTag(body.newTag), newName = sanitizeClanName(body.newName);
          const ids = db.renameClan(tag, newTag, newName);
          A?.syncUsers(ids);
          log('modifica clan', `[${tag}]`, `→ [${newTag}] ${newName}`);
        } else throw new UserError('Operazione sconosciuta');
        break;
      }
      case 'broadcast': {
        const text = String(body.text ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 120);
        if (!text) throw new UserError('Messaggio vuoto');
        const room = body.room ? String(body.room) : undefined;
        const n = A?.broadcast(text, room) ?? 0;
        log('messaggio', room ?? 'tutte le stanze', text);
        send(res, 200, { ok: true, rooms: n });
        return;
      }
      case 'close': {
        const room = String(body.room ?? '');
        if (!A?.closeRoom(room, reason || 'stanza chiusa da un amministratore')) throw new UserError('Stanza non trovata');
        log('chiusura stanza', room, reason);
        break;
      }
      default:
        send(res, 404, { error: 'Rotta sconosciuta' });
        return;
    }
    send(res, 200, { ok: true });
  }

  return async function handleApi(req: IncomingMessage, res: ServerResponse, path: string, url: URL): Promise<void> {
    try {
      const method = req.method ?? 'GET';
      if (method === 'POST' && (path === '/api/register' || path === '/api/login')) {
        if (!authLimit.allow(clientIp(req))) { send(res, 429, { error: 'Troppi tentativi, riprova tra qualche minuto' }); return; }
        const body = await readJson(req);
        const name = String(body.name ?? '').trim();
        const password = String(body.password ?? '');
        if (!NAME_RE.test(name)) { send(res, 400, { error: 'Nome: 3–16 caratteri tra lettere, cifre, _ e -' }); return; }
        if (password.length < 6 || password.length > 128) { send(res, 400, { error: 'Password: almeno 6 caratteri' }); return; }
        let user: User | null;
        if (path === '/api/register') {
          const color = Number(body.color);
          user = await db.register(name, password, colorUnlocked(color, 1) ? color : 0);
          if (!user) { send(res, 409, { error: 'Nome già in uso' }); return; }
        } else {
          user = await db.login(name, password);
          if (!user) { send(res, 401, { error: 'Nome o password errati' }); return; }
          if (user.banned) { send(res, 403, { error: `Account sospeso: ${user.banned}` }); return; }
        }
        send(res, 200, { token: db.createSession(user.id), profile: live(user).profile });
        return;
      }

      if (method === 'POST' && path === '/api/logout') {
        const t = bearer(req);
        if (t) db.deleteSession(t);
        send(res, 200, { ok: true });
        return;
      }

      if (path === '/api/me' || (method === 'POST' && path === '/api/profile')) {
        const user = db.userByToken(bearer(req));
        if (!user) { send(res, 401, { error: 'Sessione scaduta' }); return; }
        if (method === 'POST') {
          const body = await readJson(req);
          const lvl = live(user).profile.level;
          const color = Number(body.color), hat = Number(body.hat);
          if (!colorUnlocked(color, lvl) || color >= PLAYER_COLORS.length) { send(res, 400, { error: 'Colore non ancora sbloccato' }); return; }
          if (!hatUnlocked(hat, lvl)) { send(res, 400, { error: 'Copricapo non ancora sbloccato' }); return; }
          db.setCosmetics(user.id, color, hat);
          send(res, 200, { profile: live(db.userById(user.id)!).profile });
          return;
        }
        send(res, 200, { profile: live(user).profile });
        return;
      }

      if (path === '/api/leaderboard') {
        const byParam = url.searchParams.get('by') as LeaderBy;
        const by: LeaderBy = LEADER_BY.includes(byParam) ? byParam : 'xp';
        const period = url.searchParams.get('period') === 'week' ? 'week' : 'all';
        send(res, 200, { by, period, rows: db.leaderboard(by, period) });
        return;
      }

      // --- clan
      if (method === 'POST' && path.startsWith('/api/clan/')) {
        const user = db.userByToken(bearer(req));
        if (!user) { send(res, 401, { error: 'Sessione scaduta' }); return; }
        if (!clanLimit.allow(clientIp(req))) { send(res, 429, { error: 'Troppe richieste, riprova tra qualche minuto' }); return; }
        const body = await readJson(req);
        const action = path.slice('/api/clan/'.length);
        let changed = [user.id];
        let extra: Record<string, unknown> = {};
        if (action === 'create') {
          // livello comprensivo dell'EXP della partita in corso non ancora salvata
          db.createClan(user.id, live(user).profile.level, sanitizeTag(body.tag), sanitizeClanName(body.name));
        } else if (action === 'join') db.joinClan(user.id, String(body.code ?? ''));
        else if (action === 'leave') db.leaveClan(user.id);
        else if (action === 'kick') changed = [db.kickMember(user.id, String(body.name ?? ''))];
        else if (action === 'transfer') { db.transferClan(user.id, String(body.name ?? '')); changed = []; }
        else if (action === 'code') { extra = { code: db.newClanCode(user.id) }; changed = []; }
        else { send(res, 404, { error: 'Rotta sconosciuta' }); return; }
        if (changed.length) hooks.clanChanged?.(changed);
        const prof = live(db.userById(user.id)!).profile;
        send(res, 200, { profile: prof, clan: prof.clan ? db.clanInfo(prof.clan.tag, user.id) : null, ...extra });
        return;
      }

      if (path.startsWith('/api/clan/')) {
        const viewer = db.userByToken(bearer(req));
        const info = db.clanInfo(decodeURIComponent(path.slice('/api/clan/'.length)), viewer?.id ?? null);
        if (!info) { send(res, 404, { error: 'Clan non trovato' }); return; }
        send(res, 200, { clan: info });
        return;
      }

      if (path === '/api/clans') {
        const byParam = url.searchParams.get('by') as ClanBy;
        const by: ClanBy = CLAN_BY.includes(byParam) ? byParam : 'xp';
        const period = url.searchParams.get('period') === 'week' ? 'week' : 'all';
        send(res, 200, { by, period, rows: db.clanLeaderboard(by, period) });
        return;
      }

      if (path.startsWith('/api/admin/')) { await handleAdmin(req, res, method, path.slice('/api/admin/'.length), url); return; }

      if (path.startsWith('/api/player/')) {
        const u = db.userByName(decodeURIComponent(path.slice('/api/player/'.length)));
        if (!u) { send(res, 404, { error: 'Giocatore non trovato' }); return; }
        send(res, 200, { profile: live(u).profile });
        return;
      }

      send(res, 404, { error: 'Rotta sconosciuta' });
    } catch (e) {
      send(res, 400, { error: e instanceof UserError ? e.message : 'Richiesta non valida' });
    }
  };
}
