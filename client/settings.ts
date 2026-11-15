// Impostazioni del giocatore: comandi, video, audio, interfaccia. Salvate nel browser.

/** Azioni a cui si possono assegnare tasti (o pulsanti del mouse: "Mouse0", "Mouse1", "Mouse2"). */
export const ACTIONS = [
  ['forward', 'Avanti'], ['back', 'Indietro'], ['strafeLeft', 'Passo a sinistra'], ['strafeRight', 'Passo a destra'],
  ['turnLeft', 'Ruota a sinistra'], ['turnRight', 'Ruota a destra'],
  ['fire', 'Spara'], ['use', 'Apri / usa'], ['throw', 'Lancia granata'],
  ['weapon1', 'Coltello'], ['weapon2', 'Pistola'], ['weapon3', 'Mitraglietta'], ['weapon4', 'Mitragliatrice'],
  ['nextWeapon', 'Arma successiva'], ['prevWeapon', 'Arma precedente'],
  ['scores', 'Classifica (tenere premuto)'], ['map', 'Minimappa'], ['chat', 'Chat'], ['music', 'Musica sì/no'],
] as const;
export type Action = (typeof ACTIONS)[number][0];

export interface Settings {
  // controlli
  /** sensibilità del mouse: 1 = valore originale del gioco */
  mouseSens: number;
  invertMouse: boolean;
  /** rotazione con i tasti, gradi al secondo */
  turnSpeed: number;
  /** due tasti per azione (stringa vuota = nessuno) */
  keys: Record<Action, [string, string]>;
  // video
  /** righe di risoluzione interna: meno = più "pixelato" e più veloce */
  resolution: number;
  /** campo visivo orizzontale in gradi */
  fov: number;
  /** oscillazione dell'arma camminando, 0..1 */
  bob: number;
  /** lampi a schermo per danni e raccolte, 0..1 */
  flashes: number;
  showFps: boolean;
  // interfaccia
  hudScale: number;
  hudOpacity: number;
  crosshair: 'cross' | 'dot' | 'circle' | 'none';
  crosshairColor: string;
  crosshairSize: number;
  minimapSize: number;
  showXp: boolean;
  // audio
  volume: number;
  sfxVolume: number;
  musicVolume: number;
  music: boolean;
}

export const DEFAULT_KEYS: Record<Action, [string, string]> = {
  forward: ['KeyW', 'ArrowUp'], back: ['KeyS', 'ArrowDown'], strafeLeft: ['KeyA', ''], strafeRight: ['KeyD', ''],
  turnLeft: ['ArrowLeft', ''], turnRight: ['ArrowRight', ''],
  fire: ['Mouse0', 'ControlLeft'], use: ['KeyE', 'Space'], throw: ['KeyG', 'Mouse2'],
  weapon1: ['Digit1', ''], weapon2: ['Digit2', ''], weapon3: ['Digit3', ''], weapon4: ['Digit4', ''],
  nextWeapon: ['WheelDown', 'KeyX'], prevWeapon: ['WheelUp', 'KeyZ'],
  scores: ['Tab', ''], map: ['KeyM', ''], chat: ['KeyT', 'Enter'], music: ['KeyN', ''],
};

export const DEFAULTS: Settings = {
  mouseSens: 0.5, invertMouse: false, turnSpeed: 160, keys: DEFAULT_KEYS,
  resolution: 270, fov: 90, bob: 1, flashes: 1, showFps: false,
  hudScale: 1, hudOpacity: 0.8, crosshair: 'cross', crosshairColor: '#ffffff', crosshairSize: 1, minimapSize: 1, showXp: true,
  volume: 0.8, sfxVolume: 0.75, musicVolume: 0.4, music: true,
};

const KEY = 'iw-settings';

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)) as T; }

/** Unisce i valori salvati a quelli predefiniti (campi nuovi o mancanti restano predefiniti). */
function merge(saved: Partial<Settings>): Settings {
  const s = { ...clone(DEFAULTS), ...saved } as Settings;
  s.keys = { ...clone(DEFAULT_KEYS), ...(saved.keys ?? {}) };
  return s;
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    const s = merge(raw ? JSON.parse(raw) : {});
    // vecchia preferenza della musica (tasto N prima delle opzioni)
    if (!raw && localStorage.getItem('iw-music') === '0') s.music = false;
    return s;
  } catch {
    return clone(DEFAULTS);
  }
}

export const settings: Settings = load();
const listeners: (() => void)[] = [];

/** Salva e avvisa chi applica le impostazioni (renderer, audio...). */
export function saveSettings(): void {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* archivio non disponibile */ }
  for (const f of listeners) f();
}

export function onSettings(f: () => void): void { listeners.push(f); }

export function resetSettings(part?: 'keys'): void {
  if (part === 'keys') settings.keys = clone(DEFAULT_KEYS);
  else Object.assign(settings, clone(DEFAULTS));
  saveSettings();
}

/** Il tasto (o pulsante) è assegnato a questa azione? */
export function bound(action: Action, code: string): boolean {
  const k = settings.keys[action];
  return k[0] === code || k[1] === code;
}

/** Nome leggibile di un tasto. */
export function keyName(code: string): string {
  if (!code) return '—';
  const named: Record<string, string> = {
    Mouse0: 'Mouse sinistro', Mouse1: 'Mouse centrale', Mouse2: 'Mouse destro', Mouse3: 'Mouse 4', Mouse4: 'Mouse 5',
    WheelUp: 'Rotella su', WheelDown: 'Rotella giù', Space: 'Spazio', Enter: 'Invio', Tab: 'Tab', Escape: 'Esc',
    ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ShiftLeft: 'Maiusc sx', ShiftRight: 'Maiusc dx',
    ControlLeft: 'Ctrl sx', ControlRight: 'Ctrl dx', AltLeft: 'Alt sx', AltRight: 'Alt dx', Backspace: 'Backspace',
  };
  if (named[code]) return named[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Tastierino ${code.slice(6)}`;
  return code;
}
