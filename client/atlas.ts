// Sprite disegnati con PixelLab: un atlante PNG di celle 128x128 più una mappa JSON
// (generati da tools/build-sprites.ts a partire da assets/pixellab/).
//
// Gli sprite restano a colori pieni (ABGR per colonne, come le texture ma a 32 bit):
// il renderer li illumina con gli stessi 32 livelli di luce delle pareti, così si
// fondono con la grafica VGA senza perdere le sfumature del disegno originale.

import type { RGB } from './palette.ts';

export interface AtlasMeta {
  cell: number;
  cols: number;
  /** chiave -> indice della cella */
  entries: Record<string, number>;
  /** armi in prima persona: file PNG separati (240x150) */
  weapons: string[];
  /** quota della bocca di ciascuna arma, in pixel dal fondo dell'immagine (negativa) */
  muzzle: number[];
  /** spostamento orizzontale della bocca rispetto al centro dell'immagine */
  muzzleX?: number[];
}

export interface Atlas extends AtlasMeta {
  /** pixel RGBA dell'intero atlante */
  rgba: Uint8ClampedArray | Uint8Array;
  width: number;
}

/** Tonalità della divisa "chiave" (verde brillante) da sostituire con il colore del giocatore. */
function isKeyGreen(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max < 24 || g !== max) return 0;
  const sat = (max - min) / max;
  if (sat < 0.28) return 0;
  // tonalità in gradi
  const h = 60 * (((b - r) / (max - min)) + 2);
  if (h < 75 || h > 165) return 0;
  return max / 255;
}

/**
 * Estrae una cella come sprite per colonne (indice = x*cell + y) in formato ABGR,
 * con alfa 0 per i pixel trasparenti. `recolor` sostituisce il verde chiave con
 * quel colore mantenendone la luminosità.
 */
export function atlasSprite(a: Atlas, index: number, recolor?: RGB): Uint32Array {
  const n = a.cell;
  const out = new Uint32Array(n * n);
  const ox = (index % a.cols) * n, oy = Math.floor(index / a.cols) * n;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = ((oy + y) * a.width + ox + x) * 4;
      if (a.rgba[i + 3] < 128) continue;
      let r = a.rgba[i], g = a.rgba[i + 1], b = a.rgba[i + 2];
      if (recolor) {
        const v = isKeyGreen(r, g, b);
        if (v > 0) {
          // la luminosità del verde originale (0,71 per #3cb43c) diventa quella del nuovo colore
          const k = v / 0.71;
          r = Math.min(255, recolor[0] * k); g = Math.min(255, recolor[1] * k); b = Math.min(255, recolor[2] * k);
        }
      }
      out[x * n + y] = (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
    }
  }
  return out;
}

/** Carica atlante e mappa nel browser; null se mancano (si usa la grafica procedurale). */
export async function loadAtlas(base = 'sprites/'): Promise<{ atlas: Atlas; weapons: HTMLCanvasElement[] } | null> {
  try {
    const meta = await fetch(`${base}atlas.json`).then((r) => (r.ok ? r.json() as Promise<AtlasMeta> : Promise.reject(new Error(String(r.status)))));
    const loadImg = (src: string) => new Promise<HTMLImageElement>((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error(src));
      im.src = src;
    });
    const toCanvas = (im: HTMLImageElement) => {
      const c = document.createElement('canvas');
      c.width = im.naturalWidth; c.height = im.naturalHeight;
      c.getContext('2d')!.drawImage(im, 0, 0);
      return c;
    };
    const sheet = toCanvas(await loadImg(`${base}atlas.png`));
    const rgba = sheet.getContext('2d')!.getImageData(0, 0, sheet.width, sheet.height).data;
    const weapons = await Promise.all(meta.weapons.map(async (f) => toCanvas(await loadImg(base + f))));
    return { atlas: { ...meta, rgba, width: sheet.width }, weapons };
  } catch {
    return null;
  }
}
