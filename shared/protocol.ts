// Messaggi JSON tra client e server via WebSocket.

import type { GameMode } from './defs.ts';

/** Comando di input del client, uno ogni INPUT_DT. */
export interface InputCmd {
  /** numero di sequenza */
  q: number;
  /** avanti/indietro -1..1 */
  f: number;
  /** strafe -1..1 (positivo = destra) */
  s: number;
  /** angolo di vista in radianti */
  a: number;
  /** pulsanti: BTN_FIRE | BTN_USE */
  b: number;
  /** cambio arma richiesto, -1 se nessuno */
  w: number;
  /**
   * Solo quando si spara: il tick del server (anche frazionario) che il client stava
   * mostrando, per la compensazione della latenza.
   */
  v?: number;
}

/** Al massimo di quanto il server riavvolge le posizioni per verificare un colpo. */
export const MAX_REWIND_MS = 400;

export const BTN_FIRE = 1;
export const BTN_USE = 2;
export const BTN_THROW = 4;

export type ClientMsg =
  | { t: 'join'; name: string; color: number; room: string; mode: GameMode; seed: string; token?: string }
  | { t: 'in'; c: InputCmd[] }
  | { t: 'chat'; text: string };

export interface NetPlayer {
  id: number;
  n: string;
  c: number;
  x: number;
  y: number;
  a: number;
  /** 1 = vivo */
  al: number;
  w: number;
  /** frag */
  k: number;
  sc: number;
  /** morti */
  d: number;
  /** livello */
  lv: number;
  /** copricapo */
  h: number;
  /** sigla della squadra */
  tg: string;
  /** 1 = account registrato */
  reg: number;
  /** squadra (0, 1) oppure -1 */
  tm: number;
}

export interface NetMe {
  hp: number;
  am: number;
  /** bitmask armi possedute */
  wp: number;
  w: number;
  /** secondi al respawn */
  rs: number;
  /** EXP totale (salvata + della sessione) */
  xp: number;
  lv: number;
  /** salute massima */
  mhp: number;
  /** armatura */
  ar: number;
  /** granate */
  gr: number;
  /** la squadra ha la tessera dell'uscita (cooperativa): 1 sì, 0 no */
  key: number;
}

export interface NetEnemy {
  id: number;
  /** indice in ENEMY_KINDS */
  k: number;
  x: number;
  y: number;
  a: number;
  s: number;
}

export type NetEvent =
  | { e: 'shot'; id: number; w: number; x: number; y: number }
  | { e: 'throw'; id: number; x: number; y: number }
  | { e: 'boom'; x: number; y: number }
  | { e: 'hurt'; id: number; by: number }
  | { e: 'die'; id: number; x: number; y: number }
  | { e: 'kill'; by: string; vic: string }
  | { e: 'pick'; id: number; k: number }
  | { e: 'door'; x: number; y: number; open: number }
  | { e: 'secret'; x: number; y: number }
  | { e: 'alert'; id: number; x: number; y: number }
  | { e: 'msg'; text: string }
  | { e: 'xp'; id: number; n: number; why: string }
  | { e: 'flag'; k: 'take' | 'drop' | 'return' | 'cap'; team: number; by: number }
  | { e: 'lvlup'; id: number; lvl: number };

export interface SnapMsg {
  t: 'snap';
  ack: number;
  me: NetMe;
  tk: number;
  p: NetPlayer[];
  en: NetEnemy[];
  /** coppie piatte [idPorta, apertura*100] per le porte non chiuse */
  d: number[];
  /** id degli oggetti statici già raccolti */
  gone: number[];
  /** oggetti dinamici, quadruple piatte [id, kind, x*100, y*100] */
  di: number[];
  /** granate in volo, coppie piatte [x*100, y*100] */
  pj?: number[];
  ev: NetEvent[];
  /** modalità a squadre: punteggi [Ferro, Cobalto] */
  ts?: number[];
  /** modalità a squadre: secondi rimasti */
  tl?: number;
  /** cattura: per squadra [stato (0 base, 1 preso, 2 a terra), x*100, y*100, idPortatore] */
  fl?: number[];
}

export interface WelcomeMsg {
  t: 'welcome';
  id: number;
  /** false se si gioca come ospite (progressi non salvati) */
  reg: boolean;
  room: string;
  mode: GameMode;
  seed: number;
  lvl: number;
}

export interface LevelMsg {
  t: 'level';
  seed: number;
  lvl: number;
}

export type ServerMsg = SnapMsg | WelcomeMsg | LevelMsg | { t: 'error'; text: string };

/** Gli id dei nemici partono da qui; quelli dei giocatori restano sotto. */
export const ENEMY_ID_BASE = 1000;
/** Negli eventi 'shot' dei nemici, w = ENEMY_WEAPON_BASE + indice del tipo. */
export const ENEMY_WEAPON_BASE = 10;
