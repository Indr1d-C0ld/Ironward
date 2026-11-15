// Effetti sonori sintetizzati con WebAudio: nessun file audio.
// Spari, porte ed esplosioni passano anche da un riverbero sintetico (corridoi di pietra).
import { Music } from './music.ts';

export type SfxName =
  | 'knife' | 'pistol' | 'smg' | 'chaingun' | 'enemyShot' | 'bite' | 'alert' | 'pain' | 'die'
  | 'pick' | 'weapon' | 'door' | 'secret' | 'hurt' | 'exit' | 'empty' | 'hit'
  | 'flagTake' | 'flagLost' | 'flagReturn' | 'boom' | 'throw' | 'step';

/** Quanto riverbero riceve ciascun suono (0 = nessuno). */
const WET: Partial<Record<SfxName, number>> = {
  knife: 0.15, pistol: 0.45, smg: 0.35, chaingun: 0.3, enemyShot: 0.45, bite: 0.2, alert: 0.3, pain: 0.25, die: 0.35,
  door: 0.4, secret: 0.5, boom: 0.7, throw: 0.2, step: 0.08, exit: 0.25,
};

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private send: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private wet = 0;
  /** musica procedurale, sullo stesso AudioContext */
  readonly music = new Music();
  volume = 0.6;

  /** Va chiamato dentro un gesto dell'utente (click, tasto). */
  unlock(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);
    const len = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    // riverbero: risposta all'impulso di rumore che decade in ~1,4 s, con prime riflessioni
    const ir = ctx.createBuffer(2, Math.floor(ctx.sampleRate * 1.4), ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const b = ir.getChannelData(ch);
      for (let i = 0; i < b.length; i++) {
        const t = i / ctx.sampleRate;
        b[i] = (Math.random() * 2 - 1) * Math.pow(1 - t / 1.4, 3) * (t < 0.06 ? 0.4 : 1);
      }
    }
    const conv = ctx.createConvolver();
    conv.buffer = ir;
    const ret = ctx.createGain();
    ret.gain.value = 0.55;
    this.send = ctx.createGain();
    this.send.connect(conv).connect(ret).connect(this.master);
    this.music.attach(ctx, this.master, this.noiseBuf);
  }

  /** Livello RMS dell'uscita (0..1), per la modalità di debug. */
  level(): number {
    if (!this.analyser) return 0;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    return Math.sqrt(sum / buf.length);
  }

  get state(): string { return this.ctx?.state ?? 'nessun contesto'; }

  /** Collega un suono all'uscita diretta e, in proporzione, al riverbero. */
  private route(node: AudioNode): void {
    node.connect(this.master!);
    if (this.wet > 0 && this.send) {
      const g = this.ctx!.createGain();
      g.gain.value = this.wet;
      node.connect(g).connect(this.send);
    }
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number): void {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private noise(t: number, dur: number, type: BiquadFilterType, freq: number, vol: number, q = 1, freqEnd?: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    this.env(g, t, vol, 0.004, dur);
    src.connect(f).connect(g);
    this.route(g);
    src.start(t, Math.random() * 0.5, dur + 0.05);
  }

  private tone(t: number, dur: number, type: OscillatorType, f0: number, f1: number, vol: number, attack = 0.005): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = ctx.createGain();
    this.env(g, t, vol, attack, dur);
    o.connect(g);
    this.route(g);
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  }

  /** vol 0..1, già attenuato per la distanza dal chiamante. */
  play(name: SfxName, vol = 1): void {
    if (!this.ctx || vol < 0.03) return;
    const t = this.ctx.currentTime + 0.005;
    this.wet = WET[name] ?? 0;
    switch (name) {
      case 'step': this.noise(t, 0.07, 'lowpass', 380 + Math.random() * 160, 0.22 * vol, 1.2, 160); break;
      case 'knife': this.noise(t, 0.12, 'highpass', 2500, 0.25 * vol, 1, 6000); break;
      case 'pistol':
        this.noise(t, 0.03, 'highpass', 3000, 0.7 * vol); // schiocco
        this.noise(t, 0.2, 'bandpass', 1300, 0.9 * vol, 0.8, 260);
        this.tone(t, 0.14, 'sine', 170, 38, 0.7 * vol);
        break;
      case 'smg': this.noise(t, 0.02, 'highpass', 3500, 0.5 * vol); this.noise(t, 0.1, 'bandpass', 1800, 0.7 * vol, 0.9, 500); this.tone(t, 0.08, 'sine', 140, 50, 0.45 * vol); break;
      case 'chaingun': this.noise(t, 0.02, 'highpass', 4000, 0.45 * vol); this.noise(t, 0.09, 'bandpass', 2200, 0.7 * vol, 1, 700); this.tone(t, 0.07, 'square', 110, 50, 0.16 * vol); this.tone(t, 0.06, 'sine', 90, 40, 0.35 * vol); break;
      case 'enemyShot': this.noise(t, 0.18, 'bandpass', 1000, 0.8 * vol, 0.7, 250); this.tone(t, 0.12, 'sine', 120, 35, 0.5 * vol); break;
      case 'bite': this.tone(t, 0.18, 'sawtooth', 120, 70, 0.35 * vol); this.noise(t, 0.12, 'lowpass', 900, 0.3 * vol); break;
      case 'alert': this.tone(t, 0.09, 'square', 520, 480, 0.18 * vol); this.tone(t + 0.11, 0.14, 'square', 400, 300, 0.18 * vol); break;
      case 'pain': this.tone(t, 0.16, 'square', 330, 160, 0.16 * vol); break;
      case 'die': this.tone(t, 0.55, 'sawtooth', 380, 55, 0.22 * vol); this.noise(t, 0.3, 'lowpass', 600, 0.2 * vol); break;
      case 'pick': this.tone(t, 0.06, 'triangle', 660, 660, 0.25 * vol); this.tone(t + 0.06, 0.06, 'triangle', 880, 880, 0.25 * vol); this.tone(t + 0.12, 0.1, 'triangle', 1320, 1320, 0.25 * vol); break;
      case 'weapon': this.tone(t, 0.08, 'square', 220, 220, 0.15 * vol); this.tone(t + 0.09, 0.15, 'square', 330, 330, 0.15 * vol); this.noise(t, 0.1, 'highpass', 3000, 0.2 * vol); break;
      case 'door': this.noise(t, 0.55, 'lowpass', 500, 0.35 * vol, 4, 200); this.tone(t, 0.5, 'sawtooth', 70, 60, 0.08 * vol, 0.05); break;
      case 'secret': this.noise(t, 1.1, 'lowpass', 220, 0.6 * vol, 2, 90); break;
      case 'hurt': this.noise(t, 0.12, 'lowpass', 700, 0.5 * vol); this.tone(t, 0.14, 'square', 200, 110, 0.18 * vol); break;
      case 'hit': this.tone(t, 0.05, 'square', 1100, 900, 0.08 * vol); break;
      case 'exit': [523, 659, 784, 1046].forEach((f, i) => this.tone(t + i * 0.12, 0.2, 'triangle', f, f, 0.25 * vol)); break;
      case 'flagTake': [440, 554, 659].forEach((f, i) => this.tone(t + i * 0.08, 0.12, 'square', f, f, 0.14 * vol)); break;
      case 'flagLost': [659, 523, 392].forEach((f, i) => this.tone(t + i * 0.1, 0.16, 'square', f, f, 0.14 * vol)); break;
      case 'flagReturn': this.tone(t, 0.25, 'triangle', 392, 784, 0.22 * vol); break;
      case 'boom':
        this.noise(t, 1.1, 'lowpass', 900, 1.0 * vol, 1, 60);
        this.tone(t, 0.6, 'sine', 90, 30, 0.9 * vol);
        this.noise(t + 0.05, 0.5, 'bandpass', 400, 0.4 * vol, 0.6, 120);
        break;
      case 'throw': this.noise(t, 0.18, 'bandpass', 1200, 0.25 * vol, 1.5, 500); this.tone(t, 0.08, 'triangle', 500, 300, 0.1 * vol); break;
      case 'empty': this.tone(t, 0.03, 'square', 900, 700, 0.1 * vol); break;
    }
  }
}
