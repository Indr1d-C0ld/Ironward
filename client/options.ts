// Pannello delle opzioni: si apre dal menu iniziale e dal menu di pausa in partita.
// Ogni modifica si applica e si salva subito.

import { ACTIONS, DEFAULTS, keyName, resetSettings, saveSettings, settings, type Action, type Settings } from './settings.ts';

type Tab = 'controls' | 'keys' | 'video' | 'hud' | 'audio';
const TABS: [Tab, string][] = [['controls', 'Controlli'], ['keys', 'Comandi'], ['video', 'Video'], ['hud', 'Interfaccia'], ['audio', 'Audio']];

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  if (cls) e.className = cls;
  return e;
}

let root: HTMLDivElement | null = null;
let body: HTMLDivElement;
let tab: Tab = 'controls';
let onClose: (() => void) | null = null;
/** tasto in attesa di assegnazione */
let capture: { action: Action; slot: 0 | 1; button: HTMLButtonElement } | null = null;

export function optionsOpen(): boolean { return !!root && !root.hidden; }

export function openOptions(closed?: () => void): void {
  onClose = closed ?? null;
  if (!root) build();
  root!.hidden = false;
  render();
}

export function closeOptions(): void {
  if (!root || root.hidden) return;
  stopCapture();
  root.hidden = true;
  onClose?.();
}

function build(): void {
  root = el('div', undefined, 'opt-wrap') as HTMLDivElement;
  const card = el('div', undefined, 'opt-card');
  const head = el('div', undefined, 'opt-head');
  head.append(el('h2', 'Opzioni'));
  const close = el('button', 'Chiudi', 'opt-link');
  close.type = 'button';
  close.addEventListener('click', closeOptions);
  head.append(close);
  const tabs = el('div', undefined, 'opt-tabs');
  for (const [t, label] of TABS) {
    const b = el('button', label);
    b.type = 'button';
    b.dataset.tab = t;
    b.addEventListener('click', () => { tab = t; stopCapture(); render(); });
    tabs.append(b);
  }
  body = el('div', undefined, 'opt-body') as HTMLDivElement;
  const foot = el('div', undefined, 'opt-foot');
  const reset = el('button', 'Ripristina tutto', 'opt-small');
  reset.type = 'button';
  reset.addEventListener('click', () => { if (confirm('Riportare tutte le opzioni ai valori predefiniti?')) { resetSettings(); render(); } });
  foot.append(el('span', 'Le modifiche si salvano subito.', 'opt-hint'), reset);
  card.append(head, tabs, body, foot);
  root.append(card);
  root.addEventListener('mousedown', (e) => { if (e.target === root) closeOptions(); });
  document.body.append(root);

  // assegnazione dei tasti: cattura tastiera, mouse e rotella mentre si aspetta
  window.addEventListener('keydown', (e) => {
    if (!optionsOpen()) return;
    if (!capture) { if (e.code === 'Escape') { e.preventDefault(); closeOptions(); } return; }
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.code === 'Escape') stopCapture();
    else assign(e.code === 'Backspace' || e.code === 'Delete' ? '' : e.code);
  }, true);
  window.addEventListener('mousedown', (e) => {
    if (!capture || e.target === capture.button) return;
    e.preventDefault(); e.stopImmediatePropagation();
    assign(`Mouse${e.button}`);
  }, true);
  window.addEventListener('wheel', (e) => {
    if (!capture) return;
    e.preventDefault();
    assign(e.deltaY < 0 ? 'WheelUp' : 'WheelDown');
  }, { capture: true, passive: false });
  window.addEventListener('contextmenu', (e) => { if (capture) e.preventDefault(); }, true);
}

function stopCapture(): void {
  if (capture) capture.button.classList.remove('wait');
  capture = null;
}

function assign(code: string): void {
  if (!capture) return;
  const { action, slot } = capture;
  // lo stesso tasto non può servire a due azioni: lo si toglie dall'altra
  let moved = '';
  if (code) {
    for (const [a] of ACTIONS) {
      const k = settings.keys[a];
      for (const i of [0, 1] as const) if (k[i] === code && !(a === action && i === slot)) { k[i] = ''; moved = a; }
    }
  }
  settings.keys[action][slot] = code;
  stopCapture();
  saveSettings();
  render();
  if (moved) {
    const label = ACTIONS.find(([a]) => a === moved)?.[1] ?? moved;
    note(`${keyName(code)} tolto da «${label}»`);
  }
}

let noteTimer = 0;
function note(text: string): void {
  const n = root?.querySelector('.opt-hint');
  if (!n) return;
  n.textContent = text;
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => { n.textContent = 'Le modifiche si salvano subito.'; }, 3500);
}

// ------------------------------------------------------------------ controlli dei valori

function row(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const r = el('div', undefined, 'opt-row');
  const l = el('div', undefined, 'opt-label');
  l.append(el('span', label));
  if (hint) l.append(el('small', hint));
  r.append(l, control);
  return r;
}

function slider<K extends keyof Settings>(key: K, min: number, max: number, step: number, fmt: (v: number) => string, after?: () => void): HTMLElement {
  const wrap = el('div', undefined, 'opt-slider');
  const input = el('input');
  input.type = 'range';
  input.min = String(min); input.max = String(max); input.step = String(step);
  input.value = String(settings[key]);
  const out = el('output', fmt(Number(settings[key])));
  input.addEventListener('input', () => {
    (settings[key] as number) = Number(input.value);
    out.textContent = fmt(Number(input.value));
    saveSettings();
    after?.();
  });
  const def = el('button', '↺', 'opt-small');
  def.type = 'button';
  def.title = `Predefinito: ${fmt(DEFAULTS[key] as number)}`;
  def.addEventListener('click', () => { (settings[key] as number) = DEFAULTS[key] as number; saveSettings(); render(); });
  wrap.append(input, out, def);
  return wrap;
}

function toggle<K extends keyof Settings>(key: K): HTMLElement {
  const input = el('input');
  input.type = 'checkbox';
  input.checked = Boolean(settings[key]);
  input.addEventListener('change', () => { (settings[key] as boolean) = input.checked; saveSettings(); });
  return input;
}

function select<K extends keyof Settings>(key: K, options: [string | number, string][]): HTMLElement {
  const s = el('select');
  for (const [v, t] of options) { const o = el('option', t); o.value = String(v); s.append(o); }
  s.value = String(settings[key]);
  s.addEventListener('change', () => {
    (settings[key] as unknown) = typeof DEFAULTS[key] === 'number' ? Number(s.value) : s.value;
    saveSettings();
  });
  return s;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

// ------------------------------------------------------------------ schede

function render(): void {
  if (!root) return;
  for (const b of root.querySelectorAll<HTMLButtonElement>('.opt-tabs button')) b.classList.toggle('on', b.dataset.tab === tab);
  body.replaceChildren();
  if (tab === 'controls') {
    body.append(
      row('Sensibilità del mouse', slider('mouseSens', 0.05, 2, 0.05, (v) => v.toFixed(2)), '1,00 = la sensibilità originale del gioco, più alta'),
      row('Inverti il mouse', toggle('invertMouse'), 'muovere il mouse a destra ruota a sinistra'),
      row('Rotazione con i tasti', slider('turnSpeed', 60, 360, 10, (v) => `${v}°/s`)),
    );
  } else if (tab === 'keys') {
    const help = el('p', 'Clicca un tasto e premi quello nuovo, un pulsante del mouse o la rotella. Esc annulla, Canc lo toglie.', 'opt-hint');
    const t = el('table', undefined, 'opt-keys');
    for (const [action, label] of ACTIONS) {
      const tr = el('tr');
      tr.append(el('td', label));
      for (const slot of [0, 1] as const) {
        const td = el('td');
        const b = el('button', keyName(settings.keys[action][slot]), 'opt-key');
        b.type = 'button';
        b.addEventListener('click', () => {
          stopCapture();
          capture = { action, slot, button: b };
          b.textContent = 'Premi…';
          b.classList.add('wait');
        });
        td.append(b);
        tr.append(td);
      }
      t.append(tr);
    }
    const reset = el('button', 'Comandi predefiniti', 'opt-small');
    reset.type = 'button';
    reset.addEventListener('click', () => { resetSettings('keys'); render(); });
    body.append(help, t, reset);
  } else if (tab === 'video') {
    body.append(
      row('Risoluzione interna', select('resolution', [[200, '200 righe (molto VGA)'], [240, '240 righe'], [270, '270 righe (predefinita)'], [360, '360 righe'], [480, '480 righe (nitida)']]), 'meno righe = pixel più grossi e più velocità'),
      row('Campo visivo', slider('fov', 60, 120, 1, (v) => `${v}°`), 'orizzontale'),
      row('Oscillazione dell\'arma', slider('bob', 0, 1.5, 0.05, pct)),
      row('Lampi di danno e raccolta', slider('flashes', 0, 1, 0.05, pct)),
      row('Mostra FPS', toggle('showFps')),
    );
  } else if (tab === 'hud') {
    body.append(
      row('Dimensione dell\'HUD', slider('hudScale', 0.6, 1.6, 0.05, pct)),
      row('Opacità della barra', slider('hudOpacity', 0.2, 1, 0.05, pct)),
      row('Mirino', select('crosshair', [['cross', 'Croce'], ['dot', 'Punto'], ['circle', 'Cerchio'], ['none', 'Nessuno']])),
      row('Colore del mirino', colorPicker()),
      row('Dimensione del mirino', slider('crosshairSize', 0.5, 2.5, 0.1, pct)),
      row('Dimensione della minimappa', slider('minimapSize', 0.5, 1.6, 0.05, pct)),
      row('Mostra l\'EXP guadagnata', toggle('showXp')),
    );
  } else {
    body.append(
      row('Volume generale', slider('volume', 0, 1, 0.05, pct)),
      row('Effetti', slider('sfxVolume', 0, 1, 0.05, pct)),
      row('Musica', slider('musicVolume', 0, 1, 0.05, pct)),
      row('Musica attiva', toggle('music'), 'anche con il tasto assegnato a «Musica sì/no»'),
    );
  }
}

function colorPicker(): HTMLElement {
  const input = el('input');
  input.type = 'color';
  input.value = settings.crosshairColor;
  input.addEventListener('input', () => { settings.crosshairColor = input.value; saveSettings(); });
  return input;
}
