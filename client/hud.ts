// HUD disegnato a risoluzione piena sopra la vista 3D.

import { settings } from './settings.ts';
import { MODE_NAMES, PLAYER_COLORS, TEAMS, WEAPONS, isTeamMode, type GameMode } from '../shared/defs.ts';
import { TEX_EXIT, THEMES, type Level } from '../shared/level.ts';
import type { NetMe, NetPlayer } from '../shared/protocol.ts';
import { MAX_LEVEL, xpForLevel } from '../shared/progression.ts';

export interface HudState {
  me: NetMe;
  alive: boolean;
  myId: number;
  mode: GameMode;
  room: string;
  levelNum: number;
  level: Level;
  doorOpen: Float32Array;
  players: NetPlayer[];
  feed: { text: string; t: number }[];
  hurt: number;
  pickup: number;
  hitMarker: number;
  showScores: boolean;
  showMap: boolean;
  cam: { x: number; y: number; a: number };
  others: { x: number; y: number; c: number }[];
  enemiesLeft: number;
  now: number;
  registered: boolean;
  xpPopups: { text: string; t: number }[];
  levelBanner: { lvl: number; unlocks: string[]; t: number } | null;
  /** fotogrammi al secondo da mostrare, negativo per nasconderli */
  fps: number;
  teamScore: number[];
  timeLeft: number;
  flags: { state: number; x: number; y: number; carrier: number }[];
  myTeam: number;
}

const teamRgb = (t: number) => PLAYER_COLORS[TEAMS[t].color].rgb;

const rgb = (c: readonly number[], a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;

export function drawHud(ctx: CanvasRenderingContext2D, W: number, H: number, s: HudState): void {
  const u = Math.max(0.6, Math.min(W / 640, H / 400)) * settings.hudScale;
  ctx.save();
  ctx.textBaseline = 'middle';
  const font = (px: number, bold = true) => { ctx.font = `${bold ? 'bold ' : ''}${Math.round(px * u)}px "Courier New", monospace`; };

  // lampi di danno e raccolta
  if (s.hurt > 0) { ctx.fillStyle = `rgba(200,20,10,${Math.min(0.55, s.hurt * 0.5)})`; ctx.fillRect(0, 0, W, H); }
  if (s.pickup > 0) { ctx.fillStyle = `rgba(255,220,120,${s.pickup * 0.25})`; ctx.fillRect(0, 0, W, H); }

  // mirino (stile, colore e dimensione dalle opzioni) e hit marker
  const cx = W / 2, cy = H / 2;
  const cs = settings.crosshairSize;
  ctx.strokeStyle = settings.crosshairColor;
  ctx.fillStyle = settings.crosshairColor;
  ctx.globalAlpha = 0.85;
  ctx.lineWidth = Math.max(1, u * Math.min(1.5, cs));
  ctx.beginPath();
  if (settings.crosshair === 'cross') {
    ctx.moveTo(cx - 7 * u * cs, cy); ctx.lineTo(cx - 3 * u * cs, cy);
    ctx.moveTo(cx + 3 * u * cs, cy); ctx.lineTo(cx + 7 * u * cs, cy);
    ctx.moveTo(cx, cy - 7 * u * cs); ctx.lineTo(cx, cy - 3 * u * cs);
    ctx.moveTo(cx, cy + 3 * u * cs); ctx.lineTo(cx, cy + 7 * u * cs);
    ctx.stroke();
  } else if (settings.crosshair === 'circle') {
    ctx.arc(cx, cy, 6 * u * cs, 0, Math.PI * 2);
    ctx.stroke();
  } else if (settings.crosshair === 'dot') {
    ctx.arc(cx, cy, 1.6 * u * cs, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  const hm = 1 - (s.now - s.hitMarker) / 250;
  if (hm > 0) {
    ctx.strokeStyle = `rgba(255,80,60,${hm})`;
    ctx.lineWidth = 2 * u;
    ctx.beginPath();
    for (const [dx, dy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { ctx.moveTo(cx + dx * 5 * u, cy + dy * 5 * u); ctx.lineTo(cx + dx * 11 * u, cy + dy * 11 * u); }
    ctx.stroke();
  }

  // barra inferiore
  const barH = 44 * u;
  const y = H - barH;
  ctx.fillStyle = `rgba(14,16,20,${settings.hudOpacity})`;
  ctx.fillRect(0, y, W, barH);
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  ctx.fillRect(0, y, W, Math.max(1, u));
  const me = s.me;
  const myP = s.players.find((p) => p.id === s.myId);
  const cells: [string, string, string][] = [
    ['SALUTE', `${me.hp}`, me.hp > me.mhp / 2 ? '#7ee081' : me.hp > me.mhp / 4 ? '#f0c040' : '#ff5a4a'],
    ['MUNIZIONI', `${me.am}`, me.am > 0 ? '#e8e2d0' : '#ff5a4a'],
    ['ARMA', WEAPONS[me.w]?.name ?? '-', '#e8e2d0'],
    ['ARMAT. · GRANATE', `${me.ar} · ${me.gr}`, me.ar > 0 ? '#8cc4ff' : 'rgba(220,220,210,0.55)'],
    ['PUNTI', `${myP?.sc ?? 0}`, '#f0c040'],
    s.mode !== 'coop' ? ['FRAG', `${myP?.k ?? 0}`, '#ff9a6a'] : [me.key ? 'NEMICI · TESSERA ✓' : 'NEMICI', `${s.enemiesLeft}`, '#ff9a6a'],
  ];
  const cw = W / cells.length;
  cells.forEach(([label, value, color], i) => {
    const x = cw * i + cw / 2;
    ctx.textAlign = 'center';
    font(9, false);
    ctx.fillStyle = 'rgba(220,220,210,0.6)';
    ctx.fillText(label, x, y + 12 * u);
    font(i === 2 || i === 3 ? 14 : 20);
    ctx.fillStyle = color;
    ctx.fillText(value, x, y + 30 * u);
  });
  // armi possedute
  font(9);
  ctx.textAlign = 'center';
  for (let w = 0; w < WEAPONS.length; w++) {
    const has = (me.wp >> w) & 1;
    ctx.fillStyle = w === me.w ? '#f0c040' : has ? 'rgba(230,230,220,0.8)' : 'rgba(230,230,220,0.2)';
    ctx.fillText(String(w + 1), cw * 2 + cw / 2 + (w - 1.5) * 14 * u, y + 41 * u);
  }

  // barra dell'esperienza sopra la barra inferiore
  {
    const cur = xpForLevel(me.lv), next = xpForLevel(me.lv + 1);
    const frac = me.lv >= MAX_LEVEL ? 1 : Math.max(0, Math.min(1, (me.xp - cur) / (next - cur)));
    const bh = Math.max(3, 4 * u);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, y - bh, W, bh);
    ctx.fillStyle = s.registered ? '#e0a830' : 'rgba(200,200,190,0.5)';
    ctx.fillRect(0, y - bh, W * frac, bh);
    font(10);
    ctx.textAlign = 'left';
    ctx.fillStyle = '#e0a830';
    ctx.fillText(`LIV ${me.lv}`, 8 * u, y - bh - 8 * u);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(230,230,220,0.6)';
    ctx.fillText(s.registered ? `${me.xp - cur} / ${next - cur} EXP` : 'ospite · EXP non salvata', W - 8 * u, y - bh - 8 * u);
  }

  // EXP guadagnata
  font(11);
  ctx.textAlign = 'center';
  s.xpPopups.filter((p) => s.now - p.t < 1800).forEach((p, i, arr) => {
    const age = (s.now - p.t) / 1800;
    ctx.fillStyle = `rgba(240,200,80,${1 - age})`;
    ctx.fillText(p.text, cx, cy + (34 + (arr.length - 1 - i) * 15 - age * 10) * u);
  });

  // banner di passaggio di livello
  if (s.levelBanner && s.now - s.levelBanner.t < 4500) {
    const b = s.levelBanner;
    const a = Math.min(1, (4500 - (s.now - b.t)) / 600);
    const bw = 360 * u, bh2 = (54 + b.unlocks.length * 16) * u;
    ctx.fillStyle = `rgba(20,16,6,${0.8 * a})`;
    ctx.fillRect(cx - bw / 2, H * 0.18, bw, bh2);
    ctx.strokeStyle = `rgba(224,168,48,${a})`;
    ctx.strokeRect(cx - bw / 2, H * 0.18, bw, bh2);
    font(22);
    ctx.fillStyle = `rgba(240,200,80,${a})`;
    ctx.fillText(`LIVELLO ${b.lvl}!`, cx, H * 0.18 + 24 * u);
    font(11, false);
    ctx.fillStyle = `rgba(235,230,215,${a})`;
    b.unlocks.forEach((t, i) => ctx.fillText(`Sbloccato: ${t}`, cx, H * 0.18 + (48 + i * 16) * u));
  }

  // info stanza
  font(10, false);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(230,230,220,0.75)';
  const theme = THEMES[s.level.theme].name;
  ctx.fillText(`${s.room} · ${MODE_NAMES[s.mode]} · Livello ${s.levelNum} · ${theme} · seed ${s.level.seed}`, 10 * u, 12 * u);

  // kill feed e messaggi
  font(11);
  ctx.textAlign = 'right';
  const recent = s.feed.filter((f) => s.now - f.t < 7000).slice(-6);
  recent.forEach((f, i) => {
    const a = Math.min(1, (7000 - (s.now - f.t)) / 1000);
    ctx.fillStyle = `rgba(0,0,0,${0.45 * a})`;
    const tw = ctx.measureText(f.text).width;
    ctx.fillRect(W - tw - 18 * u, (8 + i * 18) * u, tw + 12 * u, 16 * u);
    ctx.fillStyle = `rgba(240,236,220,${a})`;
    ctx.fillText(f.text, W - 12 * u, (16 + i * 18) * u);
  });

  if (isTeamMode(s.mode)) drawTeamPanel(ctx, W, u, s, font);

  if (!s.alive) {
    ctx.fillStyle = 'rgba(60,0,0,0.45)';
    ctx.fillRect(0, 0, W, H);
    ctx.textAlign = 'center';
    font(28);
    ctx.fillStyle = '#ff6a5a';
    ctx.fillText('SEI STATO ELIMINATO', cx, cy - 20 * u);
    font(14, false);
    ctx.fillStyle = '#eee';
    ctx.fillText(`Rientro tra ${Math.ceil(me.rs)} s`, cx, cy + 14 * u);
  }

  if (s.showMap) drawMinimap(ctx, W, H, u, s);
  if (s.fps >= 0) {
    font(10);
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(200,255,200,0.85)';
    ctx.fillText(`${Math.round(s.fps)} FPS`, W - 8 * u, 40 * u);
  }
  if (s.showScores) drawScores(ctx, W, H, u, s);
  ctx.restore();
}

function drawTeamPanel(ctx: CanvasRenderingContext2D, W: number, u: number, s: HudState, font: (px: number, bold?: boolean) => void): void {
  const cx = W / 2;
  const pw = 300 * u, ph = (s.mode === 'ctf' ? 46 : 32) * u, py = 22 * u;
  ctx.fillStyle = 'rgba(10,12,16,0.72)';
  ctx.fillRect(cx - pw / 2, py, pw, ph);
  for (let t = 0; t < 2; t++) {
    const side = t === 0 ? -1 : 1;
    const c = teamRgb(t);
    ctx.fillStyle = `rgb(${c.join(',')})`;
    ctx.fillRect(t === 0 ? cx - pw / 2 : cx + pw / 2 - 5 * u, py, 5 * u, ph);
    ctx.textAlign = t === 0 ? 'left' : 'right';
    font(11);
    ctx.fillStyle = t === s.myTeam ? '#f0c040' : '#e8e2d0';
    ctx.fillText(TEAMS[t].name.toUpperCase(), cx + side * (pw / 2 - 12 * u), py + 11 * u);
    ctx.textAlign = 'center';
    font(20);
    ctx.fillStyle = `rgb(${c.map((v) => Math.min(255, v + 70)).join(',')})`;
    ctx.fillText(String(s.teamScore[t] ?? 0), cx + side * 40 * u, py + 16 * u);
    if (s.mode === 'ctf') {
      const f = s.flags[t];
      const st = !f ? '' : f.state === 0 ? 'documenti alla base' : f.state === 1 ? 'documenti PRESI' : 'documenti a terra';
      font(9, f?.state === 1);
      ctx.textAlign = t === 0 ? 'left' : 'right';
      ctx.fillStyle = f && f.state !== 0 ? '#ff9a6a' : 'rgba(230,230,220,0.6)';
      ctx.fillText(st, cx + side * (pw / 2 - 12 * u), py + 37 * u);
    }
  }
  const m = Math.floor(s.timeLeft / 60), sec = Math.floor(s.timeLeft % 60);
  font(10, false);
  ctx.textAlign = 'center';
  ctx.fillStyle = s.timeLeft < 60 ? '#ff7a6a' : 'rgba(230,230,220,0.75)';
  ctx.fillText(`${m}:${String(sec).padStart(2, '0')}`, cx, py + 16 * u);

  // avvisi per i documenti
  if (s.mode === 'ctf') {
    const carrying = s.flags.some((f) => f.state === 1 && f.carrier === s.myId);
    const ownTaken = s.flags[s.myTeam]?.state === 1;
    const msg = carrying ? 'HAI I DOCUMENTI: portali alla tua base' : ownTaken ? 'I vostri documenti sono stati presi!' : '';
    if (msg) {
      font(13);
      ctx.fillStyle = carrying ? '#f0c040' : '#ff7a6a';
      ctx.fillText(msg, cx, py + ph + 16 * u);
    }
  }
}

function drawMinimap(ctx: CanvasRenderingContext2D, _W: number, H: number, u: number, s: HudState): void {
  const lvl = s.level;
  const cs = Math.max(1, Math.floor((Math.min(H * (isTeamMode(s.mode) ? 0.45 : 0.55), 300 * u) * settings.minimapSize) / lvl.h));
  const ox = 10 * u, oy = (isTeamMode(s.mode) ? 96 : 22) * u;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(ox - 2, oy - 2, lvl.w * cs + 4, lvl.h * cs + 4);
  for (let y = 0; y < lvl.h; y++) {
    for (let x = 0; x < lvl.w; x++) {
      const i = y * lvl.w + x;
      const d = lvl.doorAt[i];
      let c: string | null = null;
      if (d >= 0) c = lvl.doors[d].secret && s.doorOpen[d] < 1 ? 'rgba(150,150,150,0.9)' : lvl.doors[d].secret ? null : 'rgba(210,140,60,0.95)';
      else if (lvl.walls[i] === TEX_EXIT) c = '#4ad060';
      else if (lvl.walls[i]) {
        // solo le pareti che confinano con il pavimento
        const edge = [i + 1, i - 1, i + lvl.w, i - lvl.w].some((n) => n >= 0 && n < lvl.walls.length && lvl.walls[n] === 0);
        c = edge ? 'rgba(150,150,150,0.9)' : null;
      }
      if (c) { ctx.fillStyle = c; ctx.fillRect(ox + x * cs, oy + y * cs, cs, cs); }
    }
  }
  for (const o of s.others) {
    ctx.fillStyle = rgb(PLAYER_COLORS[o.c].rgb);
    ctx.fillRect(ox + o.x * cs - cs, oy + o.y * cs - cs, cs * 2, cs * 2);
  }
  lvl.bases.forEach((b, t) => {
    if (s.mode !== 'ctf') return;
    ctx.strokeStyle = rgb(teamRgb(t));
    ctx.lineWidth = Math.max(1, u);
    ctx.strokeRect(ox + b.x * cs - cs * 2, oy + b.y * cs - cs * 2, cs * 4, cs * 4);
  });
  s.flags.forEach((f, t) => {
    ctx.fillStyle = rgb(teamRgb(t));
    ctx.fillRect(ox + f.x * cs - cs * 1.5, oy + f.y * cs - cs * 1.5, cs * 3, cs * 3);
    ctx.fillStyle = '#fff';
    ctx.fillRect(ox + f.x * cs - cs * 0.5, oy + f.y * cs - cs * 0.5, cs, cs);
  });
  const px = ox + s.cam.x * cs, py = oy + s.cam.y * cs;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(1, u);
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px + Math.cos(s.cam.a) * cs * 3, py + Math.sin(s.cam.a) * cs * 3);
  ctx.stroke();
  ctx.fillStyle = '#fff';
  ctx.fillRect(px - cs, py - cs, cs * 2, cs * 2);
}

function drawScores(ctx: CanvasRenderingContext2D, W: number, H: number, u: number, s: HudState): void {
  const teams = isTeamMode(s.mode);
  const sorted = [...s.players].sort((a, b) => (s.mode !== 'coop' ? b.k - a.k : b.sc - a.sc));
  // nelle modalità a squadre: intestazione di squadra seguita dai suoi giocatori
  type Row = { p?: (typeof sorted)[number]; team?: number };
  const rows: Row[] = teams
    ? [0, 1].flatMap((t) => [{ team: t }, ...sorted.filter((p) => p.tm === t).map((p) => ({ p }))])
    : sorted.map((p) => ({ p }));
  const w = 470 * u, rh = 22 * u;
  const h = (rows.length + 2) * rh;
  const x = (W - w) / 2, y = Math.max(20 * u, (H - h) / 2 - 40 * u);
  ctx.fillStyle = 'rgba(10,12,16,0.85)';
  ctx.fillRect(x, y, w, h);
  ctx.textAlign = 'left';
  ctx.font = `bold ${Math.round(12 * u)}px "Courier New", monospace`;
  ctx.fillStyle = 'rgba(230,230,220,0.6)';
  const cols = [x + 16 * u, x + 230 * u, x + 280 * u, x + 330 * u, x + 390 * u];
  ['GIOCATORE', 'LIV', 'FRAG', 'MORTI', 'PUNTI'].forEach((t, i) => ctx.fillText(t, cols[i], y + rh));
  rows.forEach((row, i) => {
    const ry = y + rh * (i + 2);
    if (row.team !== undefined) {
      ctx.fillStyle = rgb(teamRgb(row.team), 0.35);
      ctx.fillRect(x, ry - rh / 2, w, rh);
      ctx.fillStyle = '#fff';
      ctx.fillText(`${TEAMS[row.team].name.toUpperCase()} · ${s.teamScore[row.team] ?? 0}`, cols[0], ry);
      return;
    }
    const p = row.p!;
    ctx.fillStyle = rgb(PLAYER_COLORS[teams && p.tm >= 0 ? TEAMS[p.tm].color : p.c].rgb);
    ctx.fillRect(cols[0], ry - 6 * u, 10 * u, 12 * u);
    ctx.fillStyle = p.id === s.myId ? '#f0c040' : '#e8e2d0';
    ctx.fillText(`${p.tg ? `[${p.tg}] ` : ''}${p.n}${p.reg ? '' : ' (ospite)'}`, cols[0] + 16 * u, ry);
    ctx.fillText(String(p.lv), cols[1], ry);
    ctx.fillText(String(p.k), cols[2], ry);
    ctx.fillText(String(p.d), cols[3], ry);
    ctx.fillText(String(p.sc), cols[4], ry);
  });
}
