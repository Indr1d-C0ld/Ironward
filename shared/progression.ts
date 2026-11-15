// Progressione: curva EXP, ricompense, sblocchi cosmetici e bonus (solo in cooperativa).
// Condiviso: il server assegna l'EXP, il client mostra barra e sblocchi.

import type { EnemyKind } from './defs.ts';

export const MAX_LEVEL = 50;

/** EXP necessaria per passare dal livello l al successivo. */
export function xpToNext(l: number): number {
  return 100 + (l - 1) * 60;
}

/** EXP totale necessaria per raggiungere il livello l (livello 1 = 0). */
export function xpForLevel(l: number): number {
  const n = Math.max(0, Math.min(MAX_LEVEL, l) - 1);
  return n * 100 + (60 * n * (n - 1)) / 2;
}

export function levelFromXp(xp: number): number {
  let l = 1;
  while (l < MAX_LEVEL && xp >= xpForLevel(l + 1)) l++;
  return l;
}

export const XP_ENEMY: Readonly<Record<EnemyKind, number>> = { guard: 10, trooper: 25, hound: 15, officer: 60 };
/** tessera dell'uscita trovata (cooperativa) */
export const XP_KEY = 20;
export const XP_FRAG = 50;
export const XP_EXIT = 100;
export const XP_CLEAR = 60;
export const XP_SECRET = 20;
export const XP_COINS = 2;
export const XP_GEM = 10;
export const XP_WIN = 150;
export const XP_CAPTURE = 100;
export const XP_FLAG_TAKE = 20;
export const XP_FLAG_RETURN = 20;
export const XP_CARRIER_KILL = 25;
export const XP_TEAM_WIN = 100;
export const XP_STREAK = [0, 0, 0, 25, 0, 50, 0, 0, 0, 0, 100] as const;

export const HATS: readonly { name: string; level: number }[] = [
  { name: 'Berretto', level: 1 },
  { name: 'Basco', level: 3 },
  { name: 'Elmetto', level: 5 },
  { name: 'Cappuccio', level: 8 },
  { name: 'Fascia', level: 12 },
];

/** Livello richiesto per ogni colore (indici di PLAYER_COLORS). */
export const COLOR_LEVELS: readonly number[] = [1, 1, 1, 1, 2, 4, 6, 9];

export interface Perks { maxHp: number; startAmmo: number; ammoMul: number; }

export const PERKS: readonly { level: number; name: string; desc: string }[] = [
  { level: 4, name: 'Scorta', desc: '+8 munizioni iniziali' },
  { level: 7, name: 'Tempra', desc: '+15 salute massima' },
  { level: 10, name: 'Raccoglitore', desc: '+50% munizioni raccolte' },
  { level: 15, name: 'Veterano', desc: '+15 salute massima' },
];

/** I bonus valgono solo in cooperativa: in deathmatch tutti partono alla pari. */
export function perksFor(level: number, coop: boolean): Perks {
  const p: Perks = { maxHp: 100, startAmmo: 8, ammoMul: 1 };
  if (!coop) return p;
  if (level >= 4) p.startAmmo += 8;
  if (level >= 7) p.maxHp += 15;
  if (level >= 10) p.ammoMul = 1.5;
  if (level >= 15) p.maxHp += 15;
  return p;
}

export function colorUnlocked(color: number, level: number): boolean {
  return color >= 0 && color < COLOR_LEVELS.length && level >= COLOR_LEVELS[color];
}

export function hatUnlocked(hat: number, level: number): boolean {
  return hat >= 0 && hat < HATS.length && level >= HATS[hat].level;
}

/** Descrizioni di ciò che si sblocca esattamente al livello l. */
export function unlocksAt(l: number, colorNames: readonly string[]): string[] {
  const out: string[] = [];
  COLOR_LEVELS.forEach((lv, i) => { if (lv === l && l > 1) out.push(`colore ${colorNames[i]}`); });
  HATS.forEach((h) => { if (h.level === l && l > 1) out.push(`copricapo ${h.name}`); });
  PERKS.forEach((p) => { if (p.level === l) out.push(`bonus ${p.name} (${p.desc})`); });
  return out;
}

export function sanitizeTag(s: unknown): string {
  return String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
}

// ---------------------------------------------------------------- clan

/** livello minimo per fondare un clan */
export const CLAN_FOUND_LEVEL = 3;
export const CLAN_MAX_MEMBERS = 20;
/** Sigla del clan: 2–4 tra lettere e cifre, maiuscole. */
export const CLAN_TAG_RE = /^[A-Z0-9]{2,4}$/;
/** Nome del clan: 3–24 caratteri tra lettere, cifre, spazi, _ e -. */
export const CLAN_NAME_RE = /^[A-Za-z0-9À-ÿ _-]{3,24}$/;

export function sanitizeClanName(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

export interface ClanBrief {
  tag: string;
  name: string;
  owner: boolean;
}

/** Statistiche accumulate durante la partita e salvate a blocchi nel database. */
export interface StatDelta {
  xp: number;
  kills: number;
  frags: number;
  deaths: number;
  shots: number;
  hits: number;
  damage: number;
  exits: number;
  secrets: number;
  treasure: number;
  wins: number;
  captures: number;
  matches: number;
  playtime: number;
  bestStreak: number;
  bestScore: number;
}

export function emptyDelta(): StatDelta {
  return { xp: 0, kills: 0, frags: 0, deaths: 0, shots: 0, hits: 0, damage: 0, exits: 0, secrets: 0, treasure: 0, wins: 0, captures: 0, matches: 0, playtime: 0, bestStreak: 0, bestScore: 0 };
}

export interface Profile {
  name: string;
  xp: number;
  level: number;
  color: number;
  hat: number;
  /** sigla del clan, vuota senza clan */
  tag: string;
  clan: ClanBrief | null;
  /** solo per gli amministratori */
  admin?: boolean;
  created: number;
  stats: Omit<StatDelta, 'xp'>;
}
