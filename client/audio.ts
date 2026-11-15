// Effetti sonori sintetizzati con WebAudio: nessun file audio.

export type SfxName =
  | 'knife' | 'pistol' | 'smg' | 'chaingun' | 'enemyShot' | 'bite' | 'alert' | 'pain' | 'die'
  | 'pick' | 'weapon' | 'door' | 'secret' | 'hurt' | 'exit' | 'empty' | 'hit'
  | 'flagTake' | 'flagLost' | 'flagReturn' | 'boom' | 'throw';

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  volume = 0.6;

  /** Va chiamato dentro un gesto dell'utente (click, tasto). */
  unlock(): void {
    if (this.ctx) { void this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(ctx.destination);
    const len = ctx.sampleRate;
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
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
    src.connect(f).connect(g).connect(this.master!);
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
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + attack + dur + 0.05);
  }

  /** vol 0..1, già attenuato per la distanza dal chiamante. */
  play(name: SfxName, vol = 1): void {
    if (!this.ctx || vol < 0.03) return;
    const t = this.ctx.currentTime + 0.005;
    switch (name) {
      case 'knife': this.noise(t, 0.12, 'highpass', 2500, 0.25 * vol, 1, 6000); break;
      case 'pistol': this.noise(t, 0.16, 'bandpass', 1400, 0.9 * vol, 0.8, 300); this.tone(t, 0.12, 'sine', 160, 40, 0.6 * vol); break;
      case 'smg': this.noise(t, 0.09, 'bandpass', 1800, 0.7 * vol, 0.9, 500); this.tone(t, 0.07, 'sine', 140, 50, 0.4 * vol); break;
      case 'chaingun': this.noise(t, 0.08, 'bandpass', 2200, 0.7 * vol, 1, 700); this.tone(t, 0.06, 'square', 110, 50, 0.15 * vol); break;
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
