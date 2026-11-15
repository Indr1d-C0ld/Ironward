// Musica chiptune procedurale con WebAudio: niente file audio.
//
// Ogni livello compone il proprio brano dal seed della mappa: tonalità, accordi, linea di
// basso, melodia e batteria nascono dallo stesso generatore deterministico. Il tema del
// livello sceglie carattere, scala e tempo. Un sequencer con anticipo programma le note
// qualche decimo di secondo prima, così il ritmo resta preciso anche se il gioco rallenta.

import { mulberry32, type Rng } from '../shared/rng.ts';

interface Style {
  name: string;
  bpm: number;
  /** intervalli della scala in semitoni */
  scale: number[];
  /** nota fondamentale (MIDI) del basso */
  root: number;
  lead: OscillatorType;
  bass: OscillatorType;
  /** probabilità di pausa nella melodia */
  rest: number;
  /** batteria: 0 marcia, 1 incalzante, 2 spezzata, 3 elettronica */
  drums: number;
}

/** Un carattere per tema, nello stesso ordine di THEMES in level.ts. */
const STYLES: readonly Style[] = [
  // Fortezza: marcia in minore naturale
  { name: 'Fortezza', bpm: 112, scale: [0, 2, 3, 5, 7, 8, 10], root: 38, lead: 'square', bass: 'triangle', rest: 0.25, drums: 0 },
  // Bunker: frigio, cupo e incalzante
  { name: 'Bunker', bpm: 128, scale: [0, 1, 3, 5, 7, 8, 10], root: 36, lead: 'sawtooth', bass: 'square', rest: 0.3, drums: 1 },
  // Archivio: minore armonico, misterioso e lento
  { name: 'Archivio', bpm: 96, scale: [0, 2, 3, 5, 7, 8, 11], root: 41, lead: 'triangle', bass: 'triangle', rest: 0.4, drums: 2 },
  // Laboratorio: dorico, sintetico e veloce
  { name: 'Laboratorio', bpm: 136, scale: [0, 2, 3, 5, 7, 9, 10], root: 40, lead: 'square', bass: 'sawtooth', rest: 0.2, drums: 3 },
];

const STEPS = 16; // sedicesimi per battuta
const BARS = 8;

interface Song {
  style: Style;
  /** per battuta: grado della scala dell'accordo */
  chords: number[];
  /** per passo (BARS*STEPS): nota MIDI della melodia o -1 */
  lead: number[];
  bass: number[];
  /** per passo: bit 1 cassa, 2 rullante, 4 charleston */
  drums: number[];
  /** arpeggio: note MIDI per passo, -1 = nessuna */
  arp: number[];
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

function compose(seed: number, theme: number): Song {
  const r: Rng = mulberry32((seed ^ 0x5bd1e995) >>> 0);
  const style = STYLES[theme % STYLES.length];
  const sc = style.scale;
  const deg = (d: number) => sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
  // progressione: parte dalla tonica, poi gradi scelti tra quelli forti
  const pool = [0, 3, 4, 5, 2, 6];
  const prog = [0];
  for (let i = 1; i < 4; i++) prog.push(pool[Math.floor(r() * pool.length)]);
  const chords = [...prog, ...prog.slice(0, 3), r() < 0.5 ? 4 : 6];

  const lead = new Array(BARS * STEPS).fill(-1);
  const bass = new Array(BARS * STEPS).fill(-1);
  const arp = new Array(BARS * STEPS).fill(-1);
  const drums = new Array(BARS * STEPS).fill(0);

  // motivo di due battute, ripetuto con variazioni
  const motif: number[] = [];
  let cur = 7 + Math.floor(r() * 3);
  for (let s = 0; s < STEPS * 2; s++) {
    if (s % 2 === 1 && r() < 0.6) { motif.push(-99); continue; } // tenuta
    if (r() < style.rest) { motif.push(-1); continue; }
    cur += [-2, -1, -1, 0, 1, 1, 2, 3][Math.floor(r() * 8)];
    cur = Math.max(4, Math.min(13, cur));
    motif.push(cur);
  }
  const bassPat = [[0, 8], [0, 6, 8, 14], [0, 3, 8, 11], [0, 4, 8, 12]][Math.floor(r() * 4)];
  for (let b = 0; b < BARS; b++) {
    const ch = chords[b];
    const variant = b >= 4 && r() < 0.5 ? 2 : 0; // seconda metà: melodia trasposta
    for (let s = 0; s < STEPS; s++) {
      const i = b * STEPS + s;
      const m = motif[(b % 2) * STEPS + s];
      if (m >= 0) lead[i] = style.root + 24 + deg(m + variant);
      else if (m === -99 && i > 0) lead[i] = -2; // prolunga la nota precedente
      if (bassPat.includes(s)) bass[i] = style.root + deg(ch) + (s === 8 && r() < 0.3 ? 12 : 0);
      // arpeggio sull'accordo (fondamentale, terza, quinta, ottava)
      const tones = [0, 2, 4, 7];
      arp[i] = style.root + 24 + deg(ch + tones[s % 4]);
      // batteria per stile
      let d = 0;
      if (s % 2 === 0) d |= 4;
      if (style.drums === 0) { if (s === 0 || s === 8 || s === 10) d |= 1; if (s === 4 || s === 12) d |= 2; }
      else if (style.drums === 1) { if (s % 4 === 0) d |= 1; if (s === 4 || s === 12 || s === 14) d |= 2; d |= 4; }
      else if (style.drums === 2) { if (s === 0 || s === 7) d |= 1; if (s === 12) d |= 2; }
      else { if (s % 4 === 0) d |= 1; if (s === 4 || s === 12) d |= 2; if (s % 4 === 2) d |= 4; }
      drums[i] = d;
    }
  }
  return { style, chords, lead, bass, drums, arp };
}

export class Music {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private song: Song | null = null;
  private step = 0;
  private nextTime = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private intensity = 0;
  private enabled = true;
  volume = 0.32;

  /** Collega la musica allo stesso AudioContext degli effetti. */
  attach(ctx: AudioContext, dest: AudioNode, noise: AudioBuffer): void {
    if (this.ctx) return;
    this.ctx = ctx;
    this.noise = noise;
    this.out = ctx.createGain();
    this.out.gain.value = this.enabled ? this.volume : 0;
    this.out.connect(dest);
  }

  get on(): boolean { return this.enabled; }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (this.out && this.ctx) this.out.gain.setTargetAtTime(on ? this.volume : 0, this.ctx.currentTime, 0.2);
  }

  /** 0 = esplorazione, 1 = scontro: più batteria e melodia più presente. */
  setIntensity(v: number): void { this.intensity = Math.max(0, Math.min(1, v)); }

  /** Compone e avvia il brano del livello (seed della mappa, indice del tema). */
  play(seed: number, theme: number): void {
    this.song = compose(seed, theme);
    this.step = 0;
    if (!this.ctx) return;
    this.nextTime = this.ctx.currentTime + 0.1;
    if (!this.timer) this.timer = setInterval(() => this.schedule(), 25);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.song = null;
  }

  private schedule(): void {
    const ctx = this.ctx, song = this.song;
    if (!ctx || !song) return;
    // se la scheda è stata in pausa, riparti da adesso invece di recuperare
    if (this.nextTime < ctx.currentTime - 0.3) this.nextTime = ctx.currentTime + 0.05;
    const dt = 60 / song.style.bpm / 4;
    while (this.nextTime < ctx.currentTime + 0.2) {
      this.playStep(song, this.step % (BARS * STEPS), this.nextTime, dt);
      this.nextTime += dt;
      this.step++;
    }
  }

  private playStep(song: Song, i: number, t: number, dt: number): void {
    const st = song.style;
    const hot = this.intensity;
    // melodia: durata fino alla prossima nota
    const n = song.lead[i];
    if (n >= 0) {
      let len = 1;
      while (len < 8 && song.lead[(i + len) % song.lead.length] === -2) len++;
      this.tone(t, dt * len * 0.95, st.lead, midiHz(n), 0.07 + hot * 0.05, true);
    }
    const b = song.bass[i];
    if (b >= 0) this.tone(t, dt * 1.8, st.bass, midiHz(b), 0.16, false);
    // arpeggio leggero, più presente quando la tensione sale
    if (song.arp[i] >= 0 && (i % 2 === 0 || hot > 0.5)) this.tone(t, dt * 0.6, 'square', midiHz(song.arp[i]), 0.018 + hot * 0.02, false);
    const d = song.drums[i];
    const drumVol = 0.35 + hot * 0.65;
    if (d & 1) this.kick(t, 0.5 * drumVol);
    if (d & 2) this.snare(t, 0.22 * drumVol);
    if (d & 4 && (hot > 0.3 || i % 4 === 0)) this.hat(t, 0.06 * drumVol);
  }

  private tone(t: number, dur: number, type: OscillatorType, hz: number, vol: number, vibrato: boolean): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(hz, t);
    if (vibrato && dur > 0.25) {
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = 5.5; lg.gain.value = hz * 0.008;
      lfo.connect(lg).connect(o.frequency);
      lfo.start(t + 0.12); lfo.stop(t + dur);
    }
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.008);
    g.gain.setValueAtTime(vol * 0.8, t + Math.max(0.01, dur - 0.04));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.out!);
    o.start(t); o.stop(t + dur + 0.02);
  }

  private kick(t: number, vol: number): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    o.connect(g).connect(this.out!);
    o.start(t); o.stop(t + 0.2);
  }

  private noiseHit(t: number, dur: number, type: BiquadFilterType, freq: number, vol: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.out!);
    src.start(t, Math.random() * 0.5, dur + 0.02);
  }

  private snare(t: number, vol: number): void {
    this.noiseHit(t, 0.14, 'bandpass', 1800, vol);
    const ctx = this.ctx!;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'triangle'; o.frequency.setValueAtTime(220, t);
    g.gain.setValueAtTime(vol * 0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    o.connect(g).connect(this.out!);
    o.start(t); o.stop(t + 0.1);
  }

  private hat(t: number, vol: number): void { this.noiseHit(t, 0.04, 'highpass', 7000, vol); }
}

/** Per i test e la galleria: il brano generato, senza suonarlo. */
export const composeSong = compose;
