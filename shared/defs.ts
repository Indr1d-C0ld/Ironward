// Costanti di gioco condivise tra client e server.

export const TICK_RATE = 20;
export const TICK_DT = 1 / TICK_RATE;
export const INPUT_RATE = 30;
export const INPUT_DT = 1 / INPUT_RATE;

export const PLAYER_SPEED = 4.2; // celle al secondo
export const PLAYER_RADIUS = 0.25;
export const ENEMY_RADIUS = 0.3;
export const HIT_RADIUS = 0.34;
export const MAX_HP = 100;
export const MAX_AMMO = 99;
export const START_AMMO = 8;
export const RESPAWN_TIME = 3;
export const FRAG_LIMIT = 15;
export const DOOR_TIME = 0.6; // secondi per aprire o chiudere
export const DOOR_HOLD = 4; // secondi in cui la porta resta aperta
export const MAX_PLAYERS = 8;

export type GameMode = 'coop' | 'dm' | 'tdm' | 'ctf';
export const GAME_MODES: readonly GameMode[] = ['coop', 'dm', 'tdm', 'ctf'];
export const MODE_NAMES: Readonly<Record<GameMode, string>> = {
  coop: 'Cooperativa', dm: 'Deathmatch', tdm: 'Deathmatch a squadre', ctf: 'Cattura i documenti',
};
export const isTeamMode = (m: GameMode) => m === 'tdm' || m === 'ctf';
export const parseMode = (m: unknown): GameMode => (GAME_MODES.includes(m as GameMode) ? (m as GameMode) : 'coop');

/** Le due squadre: nome e indice del colore in PLAYER_COLORS. */
export const TEAMS: readonly { name: string; color: number }[] = [
  { name: 'Ferro', color: 0 },
  { name: 'Cobalto', color: 1 },
];
export const TDM_LIMIT = 30;
export const CTF_LIMIT = 3;
export const MATCH_TIME = 600; // secondi, modalità a squadre
export const FLAG_RETURN_TIME = 20;
export const FLAG_TOUCH = 0.7;

export interface WeaponDef {
  name: string;
  cooldown: number;
  dmgMin: number;
  dmgMax: number;
  range: number;
  ammo: number;
  spread: number;
}

export const WEAPONS: readonly WeaponDef[] = [
  { name: 'Coltello', cooldown: 0.45, dmgMin: 14, dmgMax: 26, range: 1.4, ammo: 0, spread: 0 },
  { name: 'Pistola', cooldown: 0.36, dmgMin: 12, dmgMax: 24, range: 48, ammo: 1, spread: 0.012 },
  { name: 'Mitraglietta', cooldown: 0.12, dmgMin: 9, dmgMax: 18, range: 48, ammo: 1, spread: 0.03 },
  { name: 'Mitragliatrice', cooldown: 0.07, dmgMin: 9, dmgMax: 18, range: 48, ammo: 1, spread: 0.045 },
];

export type EnemyKind = 'guard' | 'trooper' | 'hound';
export const ENEMY_KINDS: readonly EnemyKind[] = ['guard', 'trooper', 'hound'];

export interface EnemyDef {
  name: string;
  hp: number;
  speed: number;
  range: number;
  cooldown: number;
  dmgMin: number;
  dmgMax: number;
  score: number;
  melee: boolean;
  reaction: number;
}

export const ENEMIES: Readonly<Record<EnemyKind, EnemyDef>> = {
  guard: { name: 'Sentinella', hp: 25, speed: 1.7, range: 14, cooldown: 1.3, dmgMin: 4, dmgMax: 12, score: 100, melee: false, reaction: 0.45 },
  trooper: { name: 'Assaltatore', hp: 60, speed: 2.1, range: 16, cooldown: 0.55, dmgMin: 3, dmgMax: 9, score: 300, melee: false, reaction: 0.3 },
  hound: { name: 'Mastino', hp: 18, speed: 3.8, range: 1.1, cooldown: 0.7, dmgMin: 5, dmgMax: 12, score: 200, melee: true, reaction: 0.1 },
};

// Stati dei nemici trasmessi in rete.
export const ES_IDLE = 0;
export const ES_CHASE = 1;
export const ES_AIM = 2;
export const ES_PAIN = 3;
export const ES_DEAD = 4;

export type ItemKind = 'medkit' | 'food' | 'ammo' | 'clip' | 'smg' | 'chaingun' | 'coins' | 'gem';
export const ITEM_KINDS: readonly ItemKind[] = ['medkit', 'food', 'ammo', 'clip', 'smg', 'chaingun', 'coins', 'gem'];

export const PLAYER_COLORS: readonly { name: string; rgb: readonly [number, number, number] }[] = [
  { name: 'Rosso', rgb: [178, 52, 44] },
  { name: 'Blu', rgb: [46, 98, 170] },
  { name: 'Verde', rgb: [52, 140, 70] },
  { name: 'Ocra', rgb: [200, 150, 40] },
  { name: 'Viola', rgb: [120, 66, 150] },
  { name: 'Ciano', rgb: [36, 150, 150] },
  { name: 'Arancio', rgb: [210, 100, 30] },
  { name: 'Grigio', rgb: [120, 124, 130] },
];

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
