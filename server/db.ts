// Persistenza su SQLite (modulo integrato node:sqlite): account, sessioni, statistiche.

import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  CLAN_FOUND_LEVEL, CLAN_MAX_MEMBERS, CLAN_NAME_RE, CLAN_TAG_RE, levelFromXp, type Profile, type StatDelta,
} from '../shared/progression.ts';

const SESSION_DAYS = 30;
const SCRYPT_N = 16384;

function scryptAsync(pw: string, salt: Buffer, len: number): Promise<Buffer> {
  return new Promise((res, rej) => scrypt(pw, salt, len, { N: SCRYPT_N, r: 8, p: 1 }, (err, key) => (err ? rej(err) : res(key))));
}

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(pw, salt, 64);
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, , saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(pw, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(key, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

interface UserRow {
  id: number; name: string; pass: string; created: number; xp: number; color: number; hat: number;
  clan_id: number | null; ctag: string | null; cname: string | null; cowner: number | null;
  role: string; banned: number; ban_reason: string;
  kills: number; frags: number; deaths: number; shots: number; hits: number; damage: number; exits: number;
  secrets: number; treasure: number; wins: number; captures: number; matches: number; playtime: number; best_streak: number; best_score: number;
}

export interface User {
  id: number;
  profile: Profile;
  /** motivo della sospensione, null se l'account è attivo */
  banned: string | null;
}

/** Errore mostrabile all'utente (es. nome già in uso). */
export class UserError extends Error {}

export interface AdminUserRow {
  id: number; name: string; level: number; xp: number; tag: string; role: string;
  banned: string | null; created: number; frags: number; kills: number; captures: number; playtime: number;
}
export interface AdminLogRow { ts: number; admin: string; action: string; target: string; detail: string; }

export type LeaderBy = 'xp' | 'frags' | 'kills' | 'captures';
export const LEADER_BY: readonly LeaderBy[] = ['xp', 'frags', 'kills', 'captures'];
export interface LeaderRow { name: string; tag: string; level: number; color: number; value: number; }

export type ClanBy = 'xp' | 'frags' | 'captures' | 'wars';
export const CLAN_BY: readonly ClanBy[] = ['xp', 'frags', 'captures', 'wars'];
export interface ClanRow { tag: string; name: string; members: number; value: number; }
export interface ClanMember { name: string; level: number; color: number; owner: boolean; joined: number; }
export interface ClanInfo {
  tag: string; name: string; created: number; owner: string;
  members: ClanMember[];
  /** contributi dei membri da quando sono nel clan */
  stats: { xp: number; kills: number; frags: number; captures: number; wins: number };
  wars: { won: number; lost: number; drawn: number };
  recent: { ts: number; mode: string; vs: string; result: 'won' | 'lost' | 'drawn' }[];
  /** codice d'invito, solo per i membri */
  code?: string;
}

/** Errore mostrabile all'utente sui clan (es. sigla già in uso). */
export class ClanError extends UserError {}

/** Selezione comune: utente con i dati del suo clan. */
const USER_SELECT = 'SELECT u.*, c.tag AS ctag, c.name AS cname, c.owner_id AS cowner FROM users u LEFT JOIN clans c ON c.id = u.clan_id';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newInviteCode(): string {
  const b = randomBytes(8);
  let s = '';
  for (const x of b) s += CODE_CHARS[x % CODE_CHARS.length];
  return s;
}

const STAT_COLS = ['kills', 'frags', 'deaths', 'shots', 'hits', 'damage', 'exits', 'secrets', 'treasure', 'wins', 'captures', 'matches', 'playtime'] as const;

export class GameDb {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
    this.migrate();
  }

  private migrate(): void {
    const v = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (v < 1) {
      this.db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          pass TEXT NOT NULL,
          created INTEGER NOT NULL,
          xp INTEGER NOT NULL DEFAULT 0,
          color INTEGER NOT NULL DEFAULT 0,
          hat INTEGER NOT NULL DEFAULT 0,
          tag TEXT NOT NULL DEFAULT '',
          kills INTEGER NOT NULL DEFAULT 0, frags INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0,
          shots INTEGER NOT NULL DEFAULT 0, hits INTEGER NOT NULL DEFAULT 0, damage INTEGER NOT NULL DEFAULT 0,
          exits INTEGER NOT NULL DEFAULT 0, secrets INTEGER NOT NULL DEFAULT 0, treasure INTEGER NOT NULL DEFAULT 0,
          wins INTEGER NOT NULL DEFAULT 0, matches INTEGER NOT NULL DEFAULT 0, playtime INTEGER NOT NULL DEFAULT 0,
          best_streak INTEGER NOT NULL DEFAULT 0, best_score INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires INTEGER NOT NULL
        );
        CREATE TABLE stat_log (
          id INTEGER PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          ts INTEGER NOT NULL,
          mode TEXT NOT NULL,
          xp INTEGER NOT NULL, kills INTEGER NOT NULL, frags INTEGER NOT NULL, deaths INTEGER NOT NULL
        );
        CREATE INDEX stat_log_ts ON stat_log(ts);
        CREATE INDEX stat_log_user ON stat_log(user_id);
        PRAGMA user_version = 1;
      `);
    }
    if (v < 2) {
      this.db.exec(`
        ALTER TABLE users ADD COLUMN captures INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE stat_log ADD COLUMN captures INTEGER NOT NULL DEFAULT 0;
        PRAGMA user_version = 2;
      `);
    }
    if (v < 3) {
      // Clan: la sigla libera del profilo viene sostituita da quella del clan.
      this.db.exec(`
        CREATE TABLE clans (
          id INTEGER PRIMARY KEY,
          tag TEXT NOT NULL UNIQUE COLLATE NOCASE,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          owner_id INTEGER NOT NULL REFERENCES users(id),
          code TEXT NOT NULL UNIQUE,
          created INTEGER NOT NULL
        );
        CREATE TABLE clan_matches (
          id INTEGER PRIMARY KEY,
          ts INTEGER NOT NULL,
          mode TEXT NOT NULL,
          clan_a INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
          clan_b INTEGER NOT NULL REFERENCES clans(id) ON DELETE CASCADE,
          winner INTEGER
        );
        ALTER TABLE users ADD COLUMN clan_id INTEGER REFERENCES clans(id) ON DELETE SET NULL;
        ALTER TABLE users ADD COLUMN clan_joined INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE stat_log ADD COLUMN clan_id INTEGER;
        ALTER TABLE stat_log ADD COLUMN wins INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX users_clan ON users(clan_id);
        CREATE INDEX stat_log_clan ON stat_log(clan_id, ts);
        CREATE INDEX clan_matches_a ON clan_matches(clan_a);
        CREATE INDEX clan_matches_b ON clan_matches(clan_b);
        UPDATE users SET tag = '';
        PRAGMA user_version = 3;
      `);
    }
    if (v < 4) {
      // Amministrazione: ruolo, sospensione degli account, registro delle azioni.
      this.db.exec(`
        ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT '';
        ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN ban_reason TEXT NOT NULL DEFAULT '';
        CREATE TABLE admin_log (
          id INTEGER PRIMARY KEY,
          ts INTEGER NOT NULL,
          admin_id INTEGER,
          admin TEXT NOT NULL,
          action TEXT NOT NULL,
          target TEXT NOT NULL,
          detail TEXT NOT NULL DEFAULT ''
        );
        CREATE INDEX admin_log_ts ON admin_log(ts);
        PRAGMA user_version = 4;
      `);
    }
  }

  close(): void { this.db.close(); }

  private toUser(r: UserRow): User {
    return { id: r.id, profile: this.toProfile(r), banned: r.banned ? r.ban_reason || 'nessun motivo indicato' : null };
  }

  private toProfile(r: UserRow): Profile {
    return {
      name: r.name, xp: r.xp, level: levelFromXp(r.xp), color: r.color, hat: r.hat, created: r.created,
      tag: r.ctag ?? '',
      clan: r.ctag ? { tag: r.ctag, name: r.cname!, owner: r.cowner === r.id } : null,
      ...(r.role === 'admin' ? { admin: true } : {}),
      stats: {
        kills: r.kills, frags: r.frags, deaths: r.deaths, shots: r.shots, hits: r.hits, damage: r.damage, exits: r.exits,
        secrets: r.secrets, treasure: r.treasure, wins: r.wins, captures: r.captures, matches: r.matches, playtime: r.playtime,
        bestStreak: r.best_streak, bestScore: r.best_score,
      },
    };
  }

  private row(id: number): UserRow | undefined {
    return this.db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id) as UserRow | undefined;
  }

  userById(id: number): User | null {
    const r = this.row(id);
    return r ? this.toUser(r) : null;
  }

  userByName(name: string): User | null {
    const r = this.db.prepare(`${USER_SELECT} WHERE u.name = ?`).get(name) as UserRow | undefined;
    return r ? this.toUser(r) : null;
  }

  async register(name: string, password: string, color: number): Promise<User | null> {
    const pass = await hashPassword(password);
    try {
      const res = this.db.prepare('INSERT INTO users (name, pass, created, color) VALUES (?, ?, ?, ?)').run(name, pass, Date.now(), color);
      return this.userById(Number(res.lastInsertRowid));
    } catch {
      return null; // nome già preso
    }
  }

  async login(name: string, password: string): Promise<User | null> {
    const r = this.db.prepare(`${USER_SELECT} WHERE u.name = ?`).get(name) as UserRow | undefined;
    // Con un utente inesistente si calcola comunque un hash, per non rivelarlo dai tempi di risposta.
    const ok = await verifyPassword(password, r?.pass ?? 'scrypt$16384$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==');
    return r && ok ? this.toUser(r) : null;
  }

  createSession(userId: number): string {
    const token = randomBytes(32).toString('base64url');
    const now = Date.now();
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
    this.db.prepare('INSERT INTO sessions (token_hash, user_id, expires) VALUES (?, ?, ?)').run(sha256(token), userId, now + SESSION_DAYS * 86400e3);
    return token;
  }

  userByToken(token: unknown): User | null {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const s = this.db.prepare('SELECT user_id, expires FROM sessions WHERE token_hash = ?').get(sha256(token)) as { user_id: number; expires: number } | undefined;
    if (!s || s.expires < Date.now()) return null;
    const u = this.userById(s.user_id);
    return u && !u.banned ? u : null;
  }

  deleteSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  setCosmetics(userId: number, color: number, hat: number): void {
    this.db.prepare('UPDATE users SET color = ?, hat = ? WHERE id = ?').run(color, hat, userId);
  }

  /** Somma un blocco di statistiche al profilo e lo registra nello storico (per le classifiche settimanali). */
  applyDelta(userId: number, d: StatDelta, mode: string): void {
    const sets = STAT_COLS.map((c) => `${c} = ${c} + ?`).join(', ');
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`UPDATE users SET xp = xp + ?, ${sets}, best_streak = MAX(best_streak, ?), best_score = MAX(best_score, ?) WHERE id = ?`)
        .run(d.xp, ...STAT_COLS.map((c) => Math.round(d[c])), d.bestStreak, d.bestScore, userId);
      if (d.xp || d.kills || d.frags || d.deaths || d.captures || d.wins) {
        this.db.prepare(`INSERT INTO stat_log (user_id, clan_id, ts, mode, xp, kills, frags, deaths, captures, wins)
          VALUES (?, (SELECT clan_id FROM users WHERE id = ?), ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(userId, userId, Date.now(), mode, d.xp, d.kills, d.frags, d.deaths, d.captures, d.wins);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  leaderboard(by: LeaderBy, period: 'all' | 'week', limit = 20): LeaderRow[] {
    if (!LEADER_BY.includes(by)) throw new Error('classifica non valida');
    type R = { name: string; tag: string; xp: number; color: number; value: number };
    let rows: R[];
    if (period === 'all') {
      rows = this.db.prepare(`
        SELECT u.name, COALESCE(c.tag, '') AS tag, u.xp, u.color, u.${by} AS value
        FROM users u LEFT JOIN clans c ON c.id = u.clan_id
        WHERE u.${by} > 0 ORDER BY u.${by} DESC, u.id ASC LIMIT ?`).all(limit) as R[];
    } else {
      rows = this.db.prepare(`
        SELECT u.name, COALESCE(c.tag, '') AS tag, u.xp, u.color, SUM(l.${by}) AS value
        FROM stat_log l JOIN users u ON u.id = l.user_id LEFT JOIN clans c ON c.id = u.clan_id
        WHERE l.ts > ? GROUP BY u.id HAVING value > 0 ORDER BY value DESC, u.id ASC LIMIT ?`).all(Date.now() - 7 * 86400e3, limit) as R[];
    }
    return rows.map((r) => ({ name: r.name, tag: r.tag, level: levelFromXp(r.xp), color: r.color, value: Number(r.value) }));
  }
  // ---------------------------------------------------------------- clan

  private clanOf(userId: number): { id: number; tag: string; owner_id: number } | null {
    return (this.db.prepare('SELECT c.id, c.tag, c.owner_id FROM clans c JOIN users u ON u.clan_id = c.id WHERE u.id = ?').get(userId) as
      { id: number; tag: string; owner_id: number } | undefined) ?? null;
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const v = fn();
      this.db.exec('COMMIT');
      return v;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** Fonda un clan: chi lo crea ne diventa il capo. */
  createClan(userId: number, level: number, tag: string, name: string): void {
    const u = this.userById(userId);
    if (!u) throw new ClanError('Utente sconosciuto');
    if (level < CLAN_FOUND_LEVEL) throw new ClanError(`Serve il livello ${CLAN_FOUND_LEVEL} per fondare un clan`);
    if (u.profile.clan) throw new ClanError('Sei già in un clan');
    if (!CLAN_TAG_RE.test(tag)) throw new ClanError('Sigla: 2–4 lettere o cifre');
    if (!CLAN_NAME_RE.test(name)) throw new ClanError('Nome del clan: 3–24 caratteri tra lettere, cifre, spazi, _ e -');
    this.tx(() => {
      const dup = this.db.prepare('SELECT 1 FROM clans WHERE tag = ? OR name = ?').get(tag, name);
      if (dup) throw new ClanError('Sigla o nome già in uso');
      const now = Date.now();
      const res = this.db.prepare('INSERT INTO clans (tag, name, owner_id, code, created) VALUES (?, ?, ?, ?, ?)').run(tag, name, userId, newInviteCode(), now);
      this.db.prepare('UPDATE users SET clan_id = ?, clan_joined = ? WHERE id = ?').run(Number(res.lastInsertRowid), now, userId);
    });
  }

  /** Entra in un clan con il codice d'invito. */
  joinClan(userId: number, code: string): void {
    const c = String(code).toUpperCase().replace(/[^A-Z0-9]/g, '');
    this.tx(() => {
      if (this.clanOf(userId)) throw new ClanError('Sei già in un clan: prima esci da quello attuale');
      const clan = this.db.prepare('SELECT id FROM clans WHERE code = ?').get(c) as { id: number } | undefined;
      if (!clan) throw new ClanError('Codice d’invito non valido');
      const n = (this.db.prepare('SELECT COUNT(*) AS n FROM users WHERE clan_id = ?').get(clan.id) as { n: number }).n;
      if (n >= CLAN_MAX_MEMBERS) throw new ClanError(`Il clan è al completo (${CLAN_MAX_MEMBERS} membri)`);
      this.db.prepare('UPDATE users SET clan_id = ?, clan_joined = ? WHERE id = ?').run(clan.id, Date.now(), userId);
    });
  }

  /** Esce dal clan. Se esce il capo, passa il comando al membro con più EXP; l'ultimo a uscire scioglie il clan. */
  leaveClan(userId: number): void {
    this.tx(() => {
      const clan = this.clanOf(userId);
      if (!clan) throw new ClanError('Non sei in un clan');
      this.db.prepare('UPDATE users SET clan_id = NULL WHERE id = ?').run(userId);
      if (clan.owner_id !== userId) return;
      const heir = this.db.prepare('SELECT id FROM users WHERE clan_id = ? ORDER BY xp DESC, id ASC LIMIT 1').get(clan.id) as { id: number } | undefined;
      if (heir) this.db.prepare('UPDATE clans SET owner_id = ? WHERE id = ?').run(heir.id, clan.id);
      else this.db.prepare('DELETE FROM clans WHERE id = ?').run(clan.id);
    });
  }

  /** Il capo allontana un membro; restituisce l'id dell'utente allontanato. */
  kickMember(ownerId: number, name: string): number {
    return this.tx(() => {
      const clan = this.clanOf(ownerId);
      if (!clan || clan.owner_id !== ownerId) throw new ClanError('Solo il capo può allontanare i membri');
      const m = this.db.prepare('SELECT id FROM users WHERE name = ? AND clan_id = ?').get(name, clan.id) as { id: number } | undefined;
      if (!m) throw new ClanError('Membro non trovato');
      if (m.id === ownerId) throw new ClanError('Per lasciare il clan usa «Esci dal clan»');
      this.db.prepare('UPDATE users SET clan_id = NULL WHERE id = ?').run(m.id);
      return m.id;
    });
  }

  /** Il capo cede il comando a un altro membro. */
  transferClan(ownerId: number, name: string): void {
    this.tx(() => {
      const clan = this.clanOf(ownerId);
      if (!clan || clan.owner_id !== ownerId) throw new ClanError('Solo il capo può cedere il comando');
      const m = this.db.prepare('SELECT id FROM users WHERE name = ? AND clan_id = ?').get(name, clan.id) as { id: number } | undefined;
      if (!m) throw new ClanError('Membro non trovato');
      this.db.prepare('UPDATE clans SET owner_id = ? WHERE id = ?').run(m.id, clan.id);
    });
  }

  /** Il capo genera un nuovo codice d'invito (il vecchio smette di funzionare). */
  newClanCode(ownerId: number): string {
    const clan = this.clanOf(ownerId);
    if (!clan || clan.owner_id !== ownerId) throw new ClanError('Solo il capo può cambiare il codice');
    const code = newInviteCode();
    this.db.prepare('UPDATE clans SET code = ? WHERE id = ?').run(code, clan.id);
    return code;
  }

  clanMemberIds(tag: string): number[] {
    return (this.db.prepare('SELECT u.id FROM users u JOIN clans c ON c.id = u.clan_id WHERE c.tag = ?').all(tag) as { id: number }[]).map((r) => r.id);
  }

  clanInfo(tag: string, viewerId: number | null = null): ClanInfo | null {
    const c = this.db.prepare('SELECT c.*, u.name AS owner_name FROM clans c JOIN users u ON u.id = c.owner_id WHERE c.tag = ?').get(tag) as
      { id: number; tag: string; name: string; owner_id: number; owner_name: string; code: string; created: number } | undefined;
    if (!c) return null;
    const members = (this.db.prepare('SELECT id, name, xp, color, clan_joined FROM users WHERE clan_id = ? ORDER BY xp DESC, id ASC').all(c.id) as
      { id: number; name: string; xp: number; color: number; clan_joined: number }[])
      .map((m) => ({ id: m.id, name: m.name, level: levelFromXp(m.xp), color: m.color, owner: m.id === c.owner_id, joined: m.clan_joined }));
    const st = this.db.prepare(`SELECT COALESCE(SUM(xp),0) AS xp, COALESCE(SUM(kills),0) AS kills, COALESCE(SUM(frags),0) AS frags,
      COALESCE(SUM(captures),0) AS captures, COALESCE(SUM(wins),0) AS wins FROM stat_log WHERE clan_id = ?`).get(c.id) as ClanInfo['stats'];
    const matches = this.db.prepare(`
      SELECT m.ts, m.mode, m.winner, CASE WHEN m.clan_a = ? THEN cb.tag ELSE ca.tag END AS vs
      FROM clan_matches m JOIN clans ca ON ca.id = m.clan_a JOIN clans cb ON cb.id = m.clan_b
      WHERE m.clan_a = ? OR m.clan_b = ? ORDER BY m.ts DESC`).all(c.id, c.id, c.id) as { ts: number; mode: string; winner: number | null; vs: string }[];
    const res = (w: number | null): 'won' | 'lost' | 'drawn' => (w === null ? 'drawn' : w === c.id ? 'won' : 'lost');
    const wars = { won: 0, lost: 0, drawn: 0 };
    for (const m of matches) wars[res(m.winner)]++;
    const info: ClanInfo = {
      tag: c.tag, name: c.name, created: c.created, owner: c.owner_name,
      members: members.map(({ id: _id, ...m }) => m),
      stats: { xp: Number(st.xp), kills: Number(st.kills), frags: Number(st.frags), captures: Number(st.captures), wins: Number(st.wins) },
      wars,
      recent: matches.slice(0, 10).map((m) => ({ ts: m.ts, mode: m.mode, vs: m.vs, result: res(m.winner) })),
    };
    if (viewerId !== null && members.some((m) => m.id === viewerId)) info.code = c.code;
    return info;
  }

  /** Registra l'esito di una sfida tra clan; winnerTag null = pareggio. */
  recordClanMatch(mode: string, tagA: string, tagB: string, winnerTag: string | null): void {
    const id = (t: string) => (this.db.prepare('SELECT id FROM clans WHERE tag = ?').get(t) as { id: number } | undefined)?.id;
    const a = id(tagA), b = id(tagB);
    if (a === undefined || b === undefined || a === b) return;
    const w = winnerTag === null ? null : id(winnerTag) ?? null;
    this.db.prepare('INSERT INTO clan_matches (ts, mode, clan_a, clan_b, winner) VALUES (?, ?, ?, ?, ?)').run(Date.now(), mode, a, b, w);
  }

  clanLeaderboard(by: ClanBy, period: 'all' | 'week', limit = 20): ClanRow[] {
    if (!CLAN_BY.includes(by)) throw new Error('classifica non valida');
    const since = period === 'week' ? Date.now() - 7 * 86400e3 : 0;
    const members = '(SELECT COUNT(*) FROM users u WHERE u.clan_id = c.id)';
    const sql = by === 'wars'
      ? `SELECT c.tag, c.name, ${members} AS members, COUNT(*) AS value
         FROM clan_matches m JOIN clans c ON c.id = m.winner WHERE m.ts > ? GROUP BY c.id`
      : `SELECT c.tag, c.name, ${members} AS members, SUM(l.${by}) AS value
         FROM stat_log l JOIN clans c ON c.id = l.clan_id WHERE l.ts > ? GROUP BY c.id`;
    const rows = this.db.prepare(`${sql} HAVING value > 0 ORDER BY value DESC, c.id ASC LIMIT ?`).all(since, limit) as unknown as ClanRow[];
    return rows.map((r) => ({ tag: r.tag, name: r.name, members: Number(r.members), value: Number(r.value) }));
  }

  // ---------------------------------------------------------------- amministrazione

  setRole(name: string, role: '' | 'admin'): boolean {
    return Number(this.db.prepare('UPDATE users SET role = ? WHERE name = ?').run(role, name).changes) > 0;
  }

  listAdmins(): string[] {
    return (this.db.prepare("SELECT name FROM users WHERE role = 'admin' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  }

  searchUsers(q: string, limit = 50): AdminUserRow[] {
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    const rows = this.db.prepare(`${USER_SELECT} WHERE u.name LIKE ? ESCAPE '\\' ORDER BY u.banned DESC, u.xp DESC, u.id ASC LIMIT ?`).all(like, limit) as unknown as UserRow[];
    return rows.map((r) => ({
      id: r.id, name: r.name, level: levelFromXp(r.xp), xp: r.xp, tag: r.ctag ?? '', role: r.role,
      banned: r.banned ? r.ban_reason || 'nessun motivo indicato' : null, created: r.created,
      frags: r.frags, kills: r.kills, captures: r.captures, playtime: r.playtime,
    }));
  }

  /** Sospende un account e ne chiude tutte le sessioni. */
  ban(userId: number, reason: string): void {
    this.tx(() => {
      const r = this.row(userId);
      if (!r) throw new UserError('Giocatore non trovato');
      if (r.role === 'admin') throw new UserError('Un amministratore non può essere sospeso: prima toglietegli il ruolo');
      this.db.prepare('UPDATE users SET banned = 1, ban_reason = ? WHERE id = ?').run(reason, userId);
      this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    });
  }

  unban(userId: number): void {
    this.db.prepare("UPDATE users SET banned = 0, ban_reason = '' WHERE id = ?").run(userId);
  }

  renameUser(userId: number, newName: string): void {
    try {
      const res = this.db.prepare('UPDATE users SET name = ? WHERE id = ?').run(newName, userId);
      if (!Number(res.changes)) throw new UserError('Giocatore non trovato');
    } catch (e) {
      if (e instanceof UserError) throw e;
      throw new UserError('Nome già in uso');
    }
  }

  /** Azzera EXP e statistiche, anche nello storico usato dalle classifiche settimanali. */
  resetStats(userId: number): void {
    const zero = ['xp', ...STAT_COLS, 'best_streak', 'best_score'].map((c) => `${c} = 0`).join(', ');
    this.tx(() => {
      this.db.prepare(`UPDATE users SET ${zero} WHERE id = ?`).run(userId);
      this.db.prepare('DELETE FROM stat_log WHERE user_id = ?').run(userId);
    });
  }

  setXp(userId: number, xp: number): void {
    this.db.prepare('UPDATE users SET xp = ? WHERE id = ?').run(Math.max(0, Math.round(xp)), userId);
  }

  listClans(q: string, limit = 50): { tag: string; name: string; owner: string; members: number; created: number }[] {
    const like = `%${q.replace(/[%_\\]/g, (c) => '\\' + c)}%`;
    return this.db.prepare(`
      SELECT c.tag, c.name, u.name AS owner, (SELECT COUNT(*) FROM users m WHERE m.clan_id = c.id) AS members, c.created
      FROM clans c JOIN users u ON u.id = c.owner_id
      WHERE c.tag LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\' ORDER BY c.tag LIMIT ?`).all(like, like, limit) as unknown as
      { tag: string; name: string; owner: string; members: number; created: number }[];
  }

  /** Scioglie un clan; restituisce gli id degli ex membri. */
  disbandClan(tag: string): number[] {
    return this.tx(() => {
      const c = this.db.prepare('SELECT id FROM clans WHERE tag = ?').get(tag) as { id: number } | undefined;
      if (!c) throw new UserError('Clan non trovato');
      const ids = (this.db.prepare('SELECT id FROM users WHERE clan_id = ?').all(c.id) as { id: number }[]).map((r) => r.id);
      this.db.prepare('UPDATE users SET clan_id = NULL WHERE clan_id = ?').run(c.id);
      this.db.prepare('DELETE FROM clans WHERE id = ?').run(c.id);
      return ids;
    });
  }

  /** Cambia sigla e/o nome di un clan; restituisce gli id dei membri. */
  renameClan(tag: string, newTag: string, newName: string): number[] {
    if (!CLAN_TAG_RE.test(newTag)) throw new UserError('Sigla: 2–4 lettere o cifre');
    if (!CLAN_NAME_RE.test(newName)) throw new UserError('Nome del clan: 3–24 caratteri tra lettere, cifre, spazi, _ e -');
    return this.tx(() => {
      const c = this.db.prepare('SELECT id FROM clans WHERE tag = ?').get(tag) as { id: number } | undefined;
      if (!c) throw new UserError('Clan non trovato');
      if (this.db.prepare('SELECT 1 FROM clans WHERE (tag = ? OR name = ?) AND id <> ?').get(newTag, newName, c.id)) throw new UserError('Sigla o nome già in uso');
      this.db.prepare('UPDATE clans SET tag = ?, name = ? WHERE id = ?').run(newTag, newName, c.id);
      return (this.db.prepare('SELECT id FROM users WHERE clan_id = ?').all(c.id) as { id: number }[]).map((r) => r.id);
    });
  }

  logAdmin(adminId: number | null, admin: string, action: string, target: string, detail = ''): void {
    this.db.prepare('INSERT INTO admin_log (ts, admin_id, admin, action, target, detail) VALUES (?, ?, ?, ?, ?, ?)').run(Date.now(), adminId, admin, action, target, detail);
  }

  adminLog(limit = 100): AdminLogRow[] {
    return this.db.prepare('SELECT ts, admin, action, target, detail FROM admin_log ORDER BY id DESC LIMIT ?').all(limit) as unknown as AdminLogRow[];
  }

  counts(): { users: number; clans: number; banned: number; admins: number } {
    const n = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
    return {
      users: n('SELECT COUNT(*) AS n FROM users'), clans: n('SELECT COUNT(*) AS n FROM clans'),
      banned: n('SELECT COUNT(*) AS n FROM users WHERE banned = 1'), admins: n("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'"),
    };
  }
}
