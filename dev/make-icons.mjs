// Génère les icônes PNG de l'extension (dessin procédural + suréchantillonnage)
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size, rgba) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Scène en coordonnées 0..1 ; renvoie [r,g,b,a] ou null
function roundRect(x, y, x0, y0, x1, y1, r) {
  const cx = Math.max(x0 + r, Math.min(x, x1 - r));
  const cy = Math.max(y0 + r, Math.min(y, y1 - r));
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r && x >= x0 && x <= x1 && y >= y0 && y <= y1;
}
function scene(x, y) {
  // fond
  if (!roundRect(x, y, 0.02, 0.02, 0.98, 0.98, 0.22)) return null;
  const t = (x + y) / 2;
  let col = [255 - 20 * t, 107 - 40 * t, 91 - 20 * t, 255];
  // page blanche avec coin plié
  const px0 = 0.25, py0 = 0.17, px1 = 0.75, py1 = 0.83, fold = 0.15;
  const inPage = x >= px0 && x <= px1 && y >= py0 && y <= py1 && !(x > px1 - fold && y < py0 + fold && (x - (px1 - fold)) > (y - py0));
  if (inPage) {
    col = [255, 255, 255, 255];
    // coin plié
    if (x > px1 - fold && y < py0 + fold) col = [255, 214, 208, 255];
    // lignes de texte
    const lines = [0.42, 0.52, 0.62];
    for (const ly of lines) {
      if (Math.abs(y - ly) < 0.025 && x > 0.33 && x < (ly === 0.62 ? 0.56 : 0.67)) col = [60, 66, 84, 255];
    }
    // surlignage jaune
    if (y > 0.495 && y < 0.545 && x > 0.31 && x < 0.69 && !(Math.abs(y - 0.52) < 0.025)) col = [255, 222, 89, 255];
  }
  // stylo en diagonale
  const ux = 0.707, uy = -0.707;
  const ox = x - 0.56, oy = y - 0.80;
  const along = ox * ux + oy * uy, across = -ox * uy + oy * ux;
  if (along > 0 && along < 0.36 && Math.abs(across) < 0.05) col = along < 0.06 ? [255, 222, 89, 255] : [37, 42, 56, 255];
  if (along <= 0 && along > -0.07 && Math.abs(across) < 0.05 * (1 + along / 0.07)) col = [37, 42, 56, 255];
  return col;
}

for (const size of [16, 32, 48, 128]) {
  const ss = 6;
  const buf = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) for (let px = 0; px < size; px++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const c = scene((px + (sx + 0.5) / ss) / size, (py + (sy + 0.5) / ss) / size);
      if (c) { r += c[0] * c[3]; g += c[1] * c[3]; b += c[2] * c[3]; a += c[3]; }
    }
    const i = (py * size + px) * 4;
    if (a > 0) { buf[i] = r / a; buf[i + 1] = g / a; buf[i + 2] = b / a; }
    buf[i + 3] = a / (ss * ss);
  }
  writeFileSync(path.join(out, `icon${size}.png`), png(size, buf));
}
console.log('icônes écrites dans', out);
