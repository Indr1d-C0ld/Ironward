// Palette a 256 colori in stile VGA e strumenti di disegno in pixel art.
//
// Tutta la grafica (pareti, sprite, armi) viene dipinta in RGB con ombreggiatura,
// poi ridotta alla palette con un dithering ordinato 4x4. In gioco la luce cala a
// scalini attraverso 32 "colormap", tabelle che per ogni livello di luce
// riportano ciascun indice al colore più vicino della stessa palette.

export type RGB = readonly [number, number, number];

/** 16 rampe da 16 tonalità: dal quasi nero (ombre fredde) alla luce piena (calda). */
const RAMPS: readonly [RGB, RGB, RGB][] = [
  [[6, 6, 10], [112, 112, 118], [242, 240, 232]], // grigio
  [[14, 12, 14], [122, 110, 96], [230, 218, 194]], // pietra
  [[16, 8, 6], [120, 74, 40], [236, 186, 124]], // legno
  [[32, 14, 14], [192, 130, 94], [255, 226, 194]], // pelle
  [[22, 2, 6], [172, 36, 30], [255, 156, 124]], // rosso
  [[26, 8, 4], [208, 98, 28], [255, 216, 142]], // arancio
  [[26, 16, 4], [198, 152, 32], [255, 250, 176]], // oro
  [[14, 14, 8], [118, 114, 64], [224, 222, 162]], // cachi
  [[4, 14, 10], [50, 138, 66], [192, 242, 164]], // verde
  [[2, 14, 20], [32, 142, 146], [172, 252, 242]], // ciano
  [[4, 6, 26], [48, 94, 178], [184, 216, 255]], // blu
  [[6, 8, 16], [76, 88, 106], [204, 216, 232]], // acciaio
  [[12, 4, 20], [118, 64, 152], [228, 184, 252]], // viola
  [[20, 6, 6], [142, 68, 50], [238, 172, 142]], // mattone
  [[8, 10, 6], [82, 94, 50], [194, 204, 144]], // muschio
  [[70, 12, 0], [255, 144, 24], [255, 255, 236]], // fuoco
];

/** RGB della palette: 256 * 3 byte. L'indice 0 è riservato alla trasparenza. */
export const PALETTE = new Uint8Array(768);
RAMPS.forEach(([lo, mid, hi], r) => {
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const [a, b, k] = t < 0.55 ? [lo, mid, t / 0.55] : [mid, hi, (t - 0.55) / 0.45];
    for (let ch = 0; ch < 3; ch++) PALETTE[(r * 16 + i) * 3 + ch] = Math.round(a[ch] + (b[ch] - a[ch]) * k);
  }
});

const dist2 = (r: number, g: number, b: number, i: number) => {
  const dr = r - PALETTE[i * 3], dg = g - PALETTE[i * 3 + 1], db = b - PALETTE[i * 3 + 2];
  // pesi percettivi grossolani: il verde conta di più, il blu di meno
  return dr * dr * 3 + dg * dg * 4 + db * db * 2;
};

/** Tabella 32x32x32 (5 bit per canale) -> indice di palette più vicino, mai 0. */
const LUT = new Uint8Array(32768);
for (let r = 0; r < 32; r++) {
  for (let g = 0; g < 32; g++) {
    for (let b = 0; b < 32; b++) {
      const R = r * 8 + 4, G = g * 8 + 4, B = b * 8 + 4;
      let best = 1, bd = Infinity;
      for (let i = 1; i < 256; i++) { const d = dist2(R, G, B, i); if (d < bd) { bd = d; best = i; } }
      LUT[(r << 10) | (g << 5) | b] = best;
    }
  }
}

const c5 = (v: number) => (v <= 0 ? 0 : v >= 255 ? 31 : (v / 8) | 0);
export function nearest(r: number, g: number, b: number): number {
  return LUT[(c5(r) << 10) | (c5(g) << 5) | c5(b)];
}

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16 - 0.5);
/** Indice di palette con dithering ordinato (amp = ampiezza in unità RGB). */
export function dithered(r: number, g: number, b: number, x: number, y: number, amp: number): number {
  const d = BAYER[(y & 3) * 4 + (x & 3)] * amp;
  return nearest(r + d, g + d, b + d);
}

export const LIGHT_LEVELS = 32;
/** livello di luce che riproduce i colori originali */
export const LIGHT_NORMAL = 24;

/** COLORMAP[livello * 256 + indice] = colore ABGR pronto per l'ImageData. */
export const COLORMAP = new Uint32Array(LIGHT_LEVELS * 256);
const abgr = (i: number) => (0xff000000 | (PALETTE[i * 3 + 2] << 16) | (PALETTE[i * 3 + 1] << 8) | PALETTE[i * 3]) >>> 0;
for (let l = 0; l < LIGHT_LEVELS; l++) {
  const k = l / LIGHT_NORMAL;
  for (let i = 0; i < 256; i++) {
    // sopra la luce normale i colori si schiariscono anche verso il bianco
    const lift = Math.max(0, k - 1) * 60;
    const j = i === 0 ? 0 : nearest(PALETTE[i * 3] * k + lift, PALETTE[i * 3 + 1] * k + lift, PALETTE[i * 3 + 2] * k + lift);
    COLORMAP[l * 256 + i] = abgr(j);
  }
}

/**
 * Per gli sprite a colori pieni (PixelLab): LIGHT_MUL[livello * 256 + canale] è il canale
 * illuminato con lo stesso livello delle colormap, sopra la luce normale schiarito verso il bianco.
 */
export const LIGHT_MUL = new Uint8Array(LIGHT_LEVELS * 256);
for (let l = 0; l < LIGHT_LEVELS; l++) {
  const k = l / LIGHT_NORMAL, lift = Math.max(0, k - 1) * 60;
  for (let v = 0; v < 256; v++) LIGHT_MUL[l * 256 + v] = Math.min(255, Math.round(v * k + lift));
}

/** Livello di colormap per un fattore di luce (1 = normale). */
export const lightLevel = (k: number) => Math.max(0, Math.min(LIGHT_LEVELS - 1, Math.round(k * LIGHT_NORMAL)));

// ------------------------------------------------------------------ pittura

export interface Mat {
  /** luce ambiente (default 0.34) */
  amb?: number;
  /** luce diffusa (default 0.82) */
  dif?: number;
  /** riflesso speculare: 0 per stoffa e pelle, 0.5–1 per metallo */
  spec?: number;
  shin?: number;
  /** variazione casuale per pixel (grana del tessuto) */
  grain?: number;
}

// luce dall'alto a sinistra, un po' davanti
const LX = -0.48, LY = -0.58, LZ = 0.66;
const LN = Math.hypot(LX, LY, LZ);
const L = [LX / LN, LY / LN, LZ / LN] as const;

function grainHash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Tela RGB con primitive ombreggiate (sfere, arti cilindrici, poligoni) e
 * conversione finale in indici di palette.
 */
export class Paint {
  readonly w: number;
  readonly h: number;
  readonly r: Float32Array;
  readonly g: Float32Array;
  readonly b: Float32Array;
  readonly a: Uint8Array;

  constructor(w: number, h: number) {
    this.w = w; this.h = h;
    this.r = new Float32Array(w * h); this.g = new Float32Array(w * h); this.b = new Float32Array(w * h);
    this.a = new Uint8Array(w * h);
  }

  plot(x: number, y: number, c: RGB): void {
    x |= 0; y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = y * this.w + x;
    this.r[i] = c[0]; this.g[i] = c[1]; this.b[i] = c[2]; this.a[i] = 1;
  }

  /** Colore illuminato con normale (nx, ny, nz). */
  lit(c: RGB, nx: number, ny: number, nz: number, m: Mat, x: number, y: number): RGB {
    const nl = nx * L[0] + ny * L[1] + nz * L[2];
    let k = (m.amb ?? 0.34) + (m.dif ?? 0.82) * Math.max(0, nl);
    if (m.grain) k *= 1 + (grainHash(x, y) - 0.5) * m.grain;
    let s = 0;
    if (m.spec) {
      const rz = 2 * nl * nz - L[2]; // componente verso l'osservatore del raggio riflesso
      s = m.spec * Math.pow(Math.max(0, rz), m.shin ?? 12) * 255;
    }
    return [c[0] * k + s, c[1] * k + s, c[2] * k + s];
  }

  /** Ellissoide (sfera schiacciata). */
  ball(cx: number, cy: number, rx: number, ry: number, c: RGB, m: Mat = {}): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
        const q = u * u + v * v;
        if (q > 1) continue;
        this.plot(x, y, this.lit(c, u, v, Math.sqrt(1 - q), m, x, y));
      }
    }
  }

  /** Cilindro rastremato da A (raggio ra) a B (raggio rb) con estremi arrotondati. */
  limb(ax: number, ay: number, bx: number, by: number, ra: number, rb: number, c: RGB, m: Mat = {}): void {
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-6;
    const R = Math.max(ra, rb);
    for (let y = Math.floor(Math.min(ay, by) - R); y <= Math.ceil(Math.max(ay, by) + R); y++) {
      for (let x = Math.floor(Math.min(ax, bx) - R); x <= Math.ceil(Math.max(ax, bx) + R); x++) {
        const px = x + 0.5, py = y + 0.5;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const qx = px - (ax + dx * t), qy = py - (ay + dy * t);
        const r = ra + (rb - ra) * t;
        const d2 = qx * qx + qy * qy;
        if (d2 > r * r) continue;
        const nx = qx / r, ny = qy / r;
        this.plot(x, y, this.lit(c, nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)), m, x, y));
      }
    }
  }

  /**
   * Poligono pieno. shape: 'flat' piatto, 'cyl' curvo in orizzontale (busti, canne),
   * 'vcyl' curvo in verticale, 'dome' bombato in entrambe le direzioni.
   */
  poly(pts: readonly number[], c: RGB, m: Mat = {}, shape: 'flat' | 'cyl' | 'vcyl' | 'dome' = 'flat'): void {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      x0 = Math.min(x0, pts[i]); x1 = Math.max(x1, pts[i]);
      y0 = Math.min(y0, pts[i + 1]); y1 = Math.max(y1, pts[i + 1]);
    }
    const n = pts.length / 2;
    for (let y = Math.floor(y0); y <= Math.ceil(y1); y++) {
      const py = y + 0.5;
      // intersezioni della riga con i lati
      const xs: number[] = [];
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const yi = pts[i * 2 + 1], yj = pts[j * 2 + 1];
        if ((yi > py) !== (yj > py)) xs.push(pts[i * 2] + ((py - yi) / (yj - yi)) * (pts[j * 2] - pts[i * 2]));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const sx = xs[k], ex = xs[k + 1];
        for (let x = Math.ceil(sx - 0.5); x < Math.ceil(ex - 0.5); x++) {
          let nx = 0, ny = 0;
          if (shape === 'cyl' || shape === 'dome') nx = ((x + 0.5 - sx) / Math.max(1, ex - sx)) * 2 - 1;
          if (shape === 'vcyl' || shape === 'dome') ny = ((py - y0) / Math.max(1, y1 - y0)) * 2 - 1;
          nx *= 0.92; ny *= 0.92;
          this.plot(x, y, this.lit(c, nx, ny, Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny)), m, x, y));
        }
      }
    }
  }

  /** Rettangolo con smusso: bordo chiaro in alto a sinistra e scuro in basso a destra. */
  box(x: number, y: number, w: number, h: number, c: RGB, m: Mat = {}, bevel = 1): void {
    this.poly([x, y, x + w, y, x + w, y + h, x, y + h], c, m);
    if (bevel <= 0) return;
    const hi: RGB = [c[0] * 1.35 + 20, c[1] * 1.35 + 20, c[2] * 1.35 + 20], lo: RGB = [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5];
    for (let k = 0; k < bevel; k++) {
      for (let i = x + k; i < x + w - k; i++) { this.plot(i, y + k, hi); this.plot(i, y + h - 1 - k, lo); }
      for (let j = y + k; j < y + h - k; j++) { this.plot(x + k, j, hi); this.plot(x + w - 1 - k, j, lo); }
    }
  }

  /** Segmento di spessore 1 (per cuciture, cinghie sottili, contorni). */
  line(x0: number, y0: number, x1: number, y1: number, c: RGB): void {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= n; i++) this.plot(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c);
  }

  /** Moltiplica il colore dei pixel già dipinti dentro un'ellisse (ombre, sporco). */
  tint(cx: number, cy: number, rx: number, ry: number, k: number): void {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) {
      for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
        const u = (x + 0.5 - cx) / rx, v = (y + 0.5 - cy) / ry;
        if (u * u + v * v > 1 || x < 0 || y < 0 || x >= this.w || y >= this.h) continue;
        const i = y * this.w + x;
        if (!this.a[i]) continue;
        this.r[i] *= k; this.g[i] *= k; this.b[i] *= k;
      }
    }
  }

  /** Scurisce i pixel sul bordo della sagoma: il contorno tipico degli sprite VGA. */
  outline(k = 0.42): void {
    const { w, h, a } = this;
    const edge: number[] = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (!a[i]) continue;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !a[i - 1] || !a[i + 1] || !a[i - w] || !a[i + w]) edge.push(i);
      }
    }
    for (const i of edge) { this.r[i] *= k; this.g[i] *= k; this.b[i] *= k; }
  }

  /** Indici di palette per colonne (indice = x*h + y); 0 = trasparente. */
  indexed(amp = 14): Uint8Array {
    const { w, h } = this;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (this.a[i]) out[x * h + y] = dithered(this.r[i], this.g[i], this.b[i], x, y, amp);
      }
    }
    return out;
  }
}

/** Converte un'immagine indicizzata (per colonne) in un canvas RGBA alla luce normale. */
export function indexedToCanvas(idx: Uint8Array | Uint32Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const buf = new Uint32Array(img.data.buffer);
  const base = LIGHT_NORMAL * 256;
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      const v = idx[x * h + y];
      // gli sprite a colori pieni (Uint32, ABGR) si copiano così come sono
      if (v) buf[y * w + x] = idx instanceof Uint32Array ? v : COLORMAP[base + v];
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}
