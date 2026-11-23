// Reconnaissance de texte (OCR) des pages scannées, entièrement locale :
// Tesseract.js (moteur LSTM en WebAssembly) et le modèle français fournis dans lib/tesseract/.
// Pour chaque ligne reconnue, on estime aussi la police standard la plus ressemblante
// (Helvetica, Times ou Courier, gras, italique), sa taille et ses couleurs, afin de pouvoir
// remplacer l'image du texte par du vrai texte modifiable.
import { FONTS } from './geom.js';
import { rgbToHex } from './util.js';

const BASE = new URL('../lib/tesseract/', import.meta.url).href;
const LANG = 'fra'; // le modèle français reconnaît aussi l'anglais et les autres langues latines courantes

let workerP = null;
let progressFn = null;
let cancelFn = null; // rejette la reconnaissance en cours

function getWorker() {
  if (!workerP) {
    workerP = (async () => {
      const { default: Tesseract } = await import('../lib/tesseract/tesseract.esm.min.js');
      const w = await Tesseract.createWorker(LANG, 1 /* LSTM */, {
        workerPath: BASE + 'worker.min.js',
        corePath: BASE + 'core/',
        langPath: BASE + 'lang',
        workerBlobURL: false,
        cacheMethod: 'none',
        gzip: true,
        logger: (m) => progressFn?.(m),
        errorHandler: (e) => console.warn('OCR', e),
      });
      await w.setParameters({ tessedit_pageseg_mode: '3', user_defined_dpi: '300', preserve_interword_spaces: '0' });
      return w;
    })();
    workerP.catch(() => { workerP = null; });
  }
  return workerP;
}

/** Arrête la reconnaissance en cours (le moteur est rechargé à la prochaine demande). */
export async function cancelOcr() {
  const p = workerP;
  workerP = null;
  progressFn = null;
  cancelFn?.();
  try { (await p)?.terminate(); } catch {}
}

/** Échelle de rendu conseillée pour l'OCR (≈ 300 dpi, plafonnée à ~12 Mpx). */
export function ocrScale(baseW, baseH) {
  return Math.max(1.5, Math.min(300 / 72, Math.sqrt(12e6 / (baseW * baseH))));
}

/**
 * Reconnaît le texte d'une page rendue dans `canvas` à l'échelle `scale` (1 = 72 dpi).
 * Renvoie les lignes en points (repère de base de la page) :
 * { str, x0, y0, x1, y1, base, size, font, bold, italic, color, bg, conf, para, words }
 */
export async function recognizePage(canvas, scale, { onProgress } = {}) {
  const cancelled = new Promise((_, reject) => { cancelFn = () => reject(Object.assign(new Error('OCR annulé'), { name: 'AbortError' })); });
  let data;
  try {
    const w = await Promise.race([getWorker(), cancelled]);
    progressFn = (m) => { if (m.status === 'recognizing text') onProgress?.(m.progress); };
    ({ data } = await Promise.race([w.recognize(canvas, {}, { blocks: true, text: false }), cancelled]));
  } finally { progressFn = null; cancelFn = null; }
  return extractLines(data.blocks || [], canvas, scale);
}

// ---------- Lignes ----------
const LIGATURES = { 'ﬀ': 'ff', 'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'st', 'ﬆ': 'st' };
const cleanText = (s) => s.replace(/[ﬀ-ﬆ]/g, (c) => LIGATURES[c] || c).replace(/\s+/g, ' ').trim();

function extractLines(blocks, canvas, scale) {
  const W = canvas.width, H = canvas.height;
  const img = canvas.getContext('2d').getImageData(0, 0, W, H).data;
  const lines = [];
  let para = 0;
  for (const bl of blocks) {
    if (/IMAGE|LINE|NOISE/.test(bl.blocktype || '')) continue;
    for (const pa of bl.paragraphs || []) {
      para++;
      for (const li of pa.lines || []) {
        const words = (li.words || []).filter((w) => w.text && w.text.trim());
        const str = cleanText(words.map((w) => w.text).join(' '));
        if (!str || !/[\p{L}\p{N}]/u.test(str)) continue;
        const b = li.bbox;
        if (b.x1 - b.x0 < 3 || b.y1 - b.y0 < 4) continue;
        const bl0 = li.baseline;
        const base = bl0 && bl0.x1 > bl0.x0 ? (bl0.y0 + bl0.y1) / 2 : b.y1;
        lines.push({
          str, px: b, basePx: Math.min(b.y1, Math.max(b.y0 + 1, base)), conf: li.confidence ?? 0, para,
          words: words.map((w) => ({ text: cleanText(w.text), b: w.bbox, conf: w.confidence ?? 0 })).filter((w) => w.text),
        });
      }
    }
  }
  const gray = toGray(img, W, H);
  for (const l of lines) Object.assign(l, analyseLine(l, img, gray, W, H));
  chooseFonts(lines);
  // Conversion en points
  return lines.map((l) => {
    const s = 1 / scale;
    const sizePx = fitWidth(l);
    const m = metrics(l.str, l.v);
    const originX = l.px.x0 + (m.l * sizePx) / 100; // l'encre commence après l'approche gauche du premier glyphe
    return {
      str: l.str,
      x0: l.px.x0 * s, y0: l.px.y0 * s, x1: l.px.x1 * s, y1: l.px.y1 * s,
      ox: originX * s, base: l.basePx * s,
      size: Math.max(4, Math.round(sizePx * s * 2) / 2),
      font: l.v.font, bold: l.v.bold, italic: l.v.italic,
      color: l.fg, bg: l.bg, conf: l.conf, para: l.para,
    };
  });
}

function toGray(img, W, H) {
  const g = new Uint8Array(W * H);
  for (let i = 0, j = 0; j < g.length; i += 4, j++) g[j] = (img[i] * 77 + img[i + 1] * 150 + img[i + 2] * 29) >> 8;
  return g;
}

/** Seuil encre / fond et couleurs d'une ligne. */
function analyseLine(l, img, gray, W, H) {
  const b = l.px;
  const pad = Math.max(2, Math.round((b.y1 - b.y0) * 0.15));
  const x0 = Math.max(0, b.x0 - pad), y0 = Math.max(0, b.y0 - pad), x1 = Math.min(W, b.x1 + pad), y1 = Math.min(H, b.y1 + pad);
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { hist[gray[y * W + x]]++; n++; }
  const pct = (p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= p * n) return v; } return 255; };
  const light = pct(0.75), dark = pct(0.02);
  const thr = (light + dark) / 2;
  // Fond : médiane des pixels clairs autour et dans la ligne ; texte : moyenne des pixels les plus sombres
  // cœur des traits : le quart le plus sombre des pixels d'encre (les bords sont éclaircis par le flou du scan)
  let nInk = 0;
  for (let v = 0; v < thr; v++) nInk += hist[v];
  let deep = dark;
  for (let v = 0, acc = 0; v < thr; v++) { acc += hist[v]; if (acc >= nInk * 0.25) { deep = v; break; } }
  const hr = new Uint32Array(256), hg = new Uint32Array(256), hb = new Uint32Array(256);
  let nb = 0, fr = 0, fg = 0, fb = 0, nf = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = y * W + x, v = gray[k], i = k * 4;
      if (v > thr + (light - thr) * 0.5) { hr[img[i]]++; hg[img[i + 1]]++; hb[img[i + 2]]++; nb++; }
      else if (v <= deep) { fr += img[i]; fg += img[i + 1]; fb += img[i + 2]; nf++; }
    }
  }
  const med = (h) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += h[v]; if (acc >= nb / 2) return v; } return 255; };
  const bg = nb ? rgbToHex(med(hr), med(hg), med(hb)) : '#ffffff';
  let fgc = nf ? [fr / nf, fg / nf, fb / nf] : [0, 0, 0];
  // Texte presque noir : noir franc (le scan grise le noir)
  if (Math.max(...fgc) < 90 && Math.max(...fgc) - Math.min(...fgc) < 25) fgc = fgc.map((c) => c * 0.5);
  return { thr, contrast: light - dark, bg, fg: rgbToHex(...fgc), scores: scoreVariants(l, gray, W, H, thr, light - dark) };
}

// ---------- Police ressemblante ----------
const VARIANTS = [];
for (const font of ['helv', 'times', 'courier']) for (const bold of [false, true]) for (const italic of [false, true]) VARIANTS.push({ font, bold, italic });
const DEFAULT_V = VARIANTS[0];
// Légère préférence pour le romain maigre : on ne choisit gras ou italique que s'ils ressemblent nettement mieux
const BIAS = (v) => (v.bold ? 0.04 : 0) + (v.italic ? 0.06 : 0);

let mctx = null, rctx = null;
const mcache = new Map();
function metrics(text, v) {
  const key = `${v.font}|${+v.bold}|${+v.italic}|${text}`;
  let m = mcache.get(key);
  if (m) return m;
  mctx ||= document.createElement('canvas').getContext('2d');
  mctx.font = `${v.italic ? 'italic ' : ''}${v.bold ? 'bold ' : ''}100px ${FONTS[v.font].css}`;
  const t = mctx.measureText(text);
  m = { l: t.actualBoundingBoxLeft, r: t.actualBoundingBoxRight, a: t.actualBoundingBoxAscent, d: t.actualBoundingBoxDescent };
  if (mcache.size > 5000) mcache.clear();
  mcache.set(key, m);
  return m;
}

/**
 * Compare chaque mot de la ligne à son rendu dans chaque variante de police :
 * proportions (largeur / hauteur), forme (recouvrement des pixels d'encre) et graisse (quantité d'encre).
 */
function scoreVariants(l, gray, W, H, thr, contrast) {
  if (contrast < 40) return null;
  const words = l.words
    .filter((w) => w.conf >= 55 && w.text.length >= 2 && w.b.x1 - w.b.x0 >= 6 && w.b.y1 - w.b.y0 >= 5)
    .sort((a, b) => b.text.length - a.text.length).slice(0, 8);
  if (!words.length) return null;
  rctx ||= Object.assign(document.createElement('canvas'), { width: 64, height: 64 }).getContext('2d', { willReadFrequently: true });
  const acc = VARIANTS.map(() => ({ score: 0, wsum: 0, sizes: [] }));
  for (const w of words) {
    const bw = w.b.x1 - w.b.x0, bh = w.b.y1 - w.b.y0;
    // masque observé
    const obs = new Uint8Array(bw * bh);
    let nObs = 0;
    for (let y = 0; y < bh; y++) {
      const row = (w.b.y0 + y) * W + w.b.x0;
      for (let x = 0; x < bw; x++) if (gray[row + x] < thr) { obs[y * bw + x] = 1; nObs++; }
    }
    if (nObs < 8) continue;
    const c = rctx.canvas;
    if (c.width < bw || c.height < bh) { c.width = Math.max(c.width, bw); c.height = Math.max(c.height, bh); }
    const weight = Math.min(12, w.text.length);
    VARIANTS.forEach((v, i) => {
      const m = metrics(w.text, v);
      const inkW = m.l + m.r, inkH = m.a + m.d;
      if (inkW <= 0 || inkH <= 0) return;
      const sizeH = (100 * bh) / inkH, sizeW = (100 * bw) / inkW;
      // rendu étiré à la boîte observée pour comparer la forme indépendamment de la chasse
      rctx.setTransform(1, 0, 0, 1, 0, 0);
      rctx.clearRect(0, 0, bw, bh);
      const sx = sizeW / sizeH;
      rctx.setTransform(sx, 0, 0, 1, 0, 0);
      rctx.font = `${v.italic ? 'italic ' : ''}${v.bold ? 'bold ' : ''}${sizeH}px ${FONTS[v.font].css}`;
      rctx.fillStyle = '#000';
      rctx.fillText(w.text, (m.l * sizeH) / 100, (m.a * sizeH) / 100);
      const d = rctx.getImageData(0, 0, bw, bh).data;
      let inter = 0, nRen = 0;
      for (let k = 0, p = 3; k < obs.length; k++, p += 4) {
        if (d[p] > 127) { nRen++; if (obs[k]) inter++; }
      }
      const union = nObs + nRen - inter;
      const iou = union ? inter / union : 0;
      const prop = Math.abs(Math.log(sizeW / sizeH));
      const weightDiff = Math.abs(Math.log(Math.max(1, nRen) / nObs));
      acc[i].score += weight * (1.6 * prop + (1 - iou) + 0.35 * weightDiff);
      acc[i].wsum += weight;
      acc[i].sizes.push([sizeH, weight]);
    });
  }
  if (!acc[0].wsum) return null;
  return acc.map((a, i) => ({ score: a.wsum ? a.score / a.wsum + BIAS(VARIANTS[i]) : Infinity, size: wmedian(a.sizes), wsum: a.wsum }));
}

function wmedian(pairs) {
  if (!pairs.length) return 0;
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  const tot = s.reduce((t, p) => t + p[1], 0);
  let acc = 0;
  for (const [v, w] of s) { acc += w; if (acc >= tot / 2) return v; }
  return s[s.length - 1][0];
}

/** Famille choisie par paragraphe (plus fiable), graisse et style par ligne, taille lissée par paragraphe. */
function chooseFonts(lines) {
  const byPara = new Map();
  for (const l of lines) (byPara.get(l.para) || byPara.set(l.para, []).get(l.para)).push(l);
  for (const group of byPara.values()) {
    const famScore = { helv: 0, times: 0, courier: 0 };
    let any = false;
    for (const l of group) {
      if (!l.scores) continue;
      any = true;
      for (const fam of Object.keys(famScore)) {
        famScore[fam] += Math.min(...VARIANTS.map((v, i) => (v.font === fam ? l.scores[i].score : Infinity))) * l.scores[0].wsum;
      }
    }
    const fam = any ? Object.keys(famScore).sort((a, b) => famScore[a] - famScore[b])[0] : 'helv';
    for (const l of group) {
      if (!l.scores) { l.v = { ...DEFAULT_V, font: fam }; l.sizePx = fallbackSize(l, l.v); continue; }
      let bi = -1;
      VARIANTS.forEach((v, i) => { if (v.font === fam && (bi < 0 || l.scores[i].score < l.scores[bi].score)) bi = i; });
      l.v = VARIANTS[bi];
      l.sizePx = l.scores[bi].size || fallbackSize(l, l.v);
    }
    // taille commune aux lignes de même style et de taille voisine (corps d'un paragraphe)
    const byStyle = new Map();
    for (const l of group) { const k = `${+l.v.bold}${+l.v.italic}`; (byStyle.get(k) || byStyle.set(k, []).get(k)).push(l); }
    for (const same of byStyle.values()) {
      const med = wmedian(same.map((l) => [l.sizePx, l.str.length]));
      for (const l of same) if (Math.abs(l.sizePx / med - 1) < 0.12) l.sizePx = med;
    }
  }
}

/** Taille d'après la hauteur de la ligne quand les mots n'ont pas pu être comparés. */
function fallbackSize(l, v) {
  const m = metrics(l.str, v);
  const h = l.px.y1 - l.px.y0;
  return m.a + m.d > 0 ? (100 * h) / (m.a + m.d) : h / 0.95;
}

/** Réduit la taille si le texte converti déborderait nettement de la ligne d'origine. */
function fitWidth(l) {
  const m = metrics(l.str, l.v);
  const w = ((m.l + m.r) * l.sizePx) / 100;
  const obs = l.px.x1 - l.px.x0;
  if (w > obs * 1.03) return l.sizePx * Math.max(0.82, (obs * 1.03) / w);
  return l.sizePx;
}
