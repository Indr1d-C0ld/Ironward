// Lettura e scrittura PNG minimali (solo zlib di Node), per gli script di build.

import { deflateSync, inflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

export interface RGBAImage { w: number; h: number; px: Uint8Array; }

/** Decodifica PNG a 8 bit: RGBA, RGB, scala di grigi (con alfa) e palette; niente interlacciamento. */
export function decodePng(buf: Uint8Array): RGBAImage {
  const b = Buffer.from(buf);
  let p = 8, w = 0, h = 0, depth = 0, ct = 0, interlace = 0;
  const idat: Buffer[] = [];
  let plte: Buffer | null = null, trns: Buffer | null = null;
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ct = d[9]; interlace = d[12]; }
    else if (type === 'PLTE') plte = d;
    else if (type === 'tRNS') trns = d;
    else if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  if (depth !== 8 || interlace) throw new Error(`PNG non supportato (profondità ${depth}, interlacciato ${interlace})`);
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : ct === 4 ? 2 : 1;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = new Uint8Array(w * h * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const line = new Uint8Array(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? line[i - bpp] : 0, up = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = line[i];
      if (f === 1) v += a;
      else if (f === 2) v += up;
      else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      line[i] = v & 255;
    }
    prev = line;
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (ct === 6) { out[o] = line[x * 4]; out[o + 1] = line[x * 4 + 1]; out[o + 2] = line[x * 4 + 2]; out[o + 3] = line[x * 4 + 3]; }
      else if (ct === 2) { out[o] = line[x * 3]; out[o + 1] = line[x * 3 + 1]; out[o + 2] = line[x * 3 + 2]; out[o + 3] = 255; }
      else if (ct === 4) { out[o] = out[o + 1] = out[o + 2] = line[x * 2]; out[o + 3] = line[x * 2 + 1]; }
      else if (ct === 0) { out[o] = out[o + 1] = out[o + 2] = line[x]; out[o + 3] = 255; }
      else if (ct === 3 && plte) {
        const i = line[x];
        out[o] = plte[i * 3]; out[o + 1] = plte[i * 3 + 1]; out[o + 2] = plte[i * 3 + 2];
        out[o + 3] = trns && i < trns.length ? trns[i] : 255;
      }
    }
  }
  return { w, h, px: out };
}

export const readPng = (file: string): RGBAImage => decodePng(readFileSync(file));

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const x of buf) c = CRC[(c ^ x) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA -> PNG, ingrandito di `scale` volte senza smussare. */
export function encodePng(img: RGBAImage, scale = 1): Buffer {
  const { w, h, px } = img;
  const W = w * scale, H = h * scale;
  const raw = Buffer.alloc((W * 4 + 1) * H);
  for (let y = 0; y < H; y++) {
    const row = y * (W * 4 + 1);
    const sy = Math.floor(y / scale);
    for (let x = 0; x < W; x++) {
      const si = (sy * w + Math.floor(x / scale)) * 4, di = row + 1 + x * 4;
      raw[di] = px[si]; raw[di + 1] = px[si + 1]; raw[di + 2] = px[si + 2]; raw[di + 3] = px[si + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())]);
}

export const writePng = (file: string, img: RGBAImage, scale = 1): void => writeFileSync(file, encodePng(img, scale));
