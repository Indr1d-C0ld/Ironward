// Pagina di sviluppo: mostra tutte le texture e le sprite procedurali.
// Aprire /gallery.html dopo `npm run build`.

import { buildTextures, drawWeapon, enemySpriteKey, HAT_STYLES, playerSpriteKey, POSES, SpriteBank, SS, TS, VIEWS } from './art.ts';
import { PLAYER_COLORS } from '../shared/defs.ts';
import { indexedToCanvas, PALETTE } from './palette.ts';

const VIEW = 192;

function tile(tex: Uint8Array, size: number, label: string, bg: string): HTMLElement {
  const fig = document.createElement('figure');
  const c = indexedToCanvas(tex, size, size);
  c.style.width = c.style.height = `${VIEW}px`;
  c.style.background = bg;
  const cap = document.createElement('figcaption');
  cap.textContent = label;
  fig.append(c, cap);
  return fig;
}

const texSec = document.getElementById('textures')!;
buildTextures().forEach((t, i) => { if (i > 0) texSec.appendChild(tile(t, TS, `tex ${i}`, '#000')); });
const sprSec = document.getElementById('sprites')!;
const bank = new SpriteBank();
const keys = bank.keys();
// nemici: tutte le pose viste di fronte, poi le 8 viste di camminata e mira
for (const kind of ['guard', 'trooper', 'hound']) {
  for (const pose of POSES) keys.push(enemySpriteKey(kind, pose, 0));
  for (const pose of ['walk1', 'aim'] as const) for (let v = 1; v < VIEWS; v++) keys.push(enemySpriteKey(kind, pose, v));
}
// giocatori: tutti i colori fermi, poi ogni copricapo nelle 8 viste
PLAYER_COLORS.forEach((_, c) => keys.push(playerSpriteKey(c, 0, 'stand')));
HAT_STYLES.forEach((_, h) => { for (let v = 0; v < VIEWS; v++) keys.push(playerSpriteKey(1, h, 'stand', v)); });
for (const pose of POSES) keys.push(playerSpriteKey(3, 2, pose, 1));
for (const k of keys) sprSec.appendChild(tile(bank.get(k)!, SS, k, '#3a3f47'));

const wSec = document.getElementById('weapons')!;
for (let w = 0; w < 4; w++) {
  for (const firing of [false, true]) {
    const c = document.createElement('canvas');
    c.width = 260; c.height = 170;
    c.style.width = '520px'; c.style.height = '340px';
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#3a3f47';
    ctx.fillRect(0, 0, 260, 170);
    drawWeapon(ctx, w, firing, 260, 170, 0, 2);
    wSec.appendChild(c);
  }
}

// palette: 16 rampe da 16 colori
const palSec = document.getElementById('palette')!;
const pc = document.createElement('canvas');
pc.width = 16; pc.height = 16;
pc.style.width = pc.style.height = '256px';
const pctx = pc.getContext('2d')!;
for (let i = 0; i < 256; i++) {
  pctx.fillStyle = `rgb(${PALETTE[i * 3]},${PALETTE[i * 3 + 1]},${PALETTE[i * 3 + 2]})`;
  pctx.fillRect(i % 16, i >> 4, 1, 1);
}
palSec.appendChild(pc);
