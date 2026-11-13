// Détection automatique des champs de formulaire dans les PDF « à plat » (sans champs AcroForm) :
//  - texte : pointillés « ...... », soulignés « ______ », cases « ☐ », libellés « Nom : », « Signature »
//  - image de la page : lignes horizontales, cadres, cellules de tableau vides, petites cases carrées
//  - champs de signature natifs du PDF (que PDF.js n'affiche pas comme interactifs)
// Toutes les coordonnées renvoyées sont dans le repère « de base » de la page (points, y vers le bas).
import { pdfjsLib, renderPageToCanvas } from './pdfcore.js';
import { measure } from './geom.js';

export const SIG_RE = /signature|sign[ée]e?s?\b|signer|signataire|visa|paraphe|cachet|lu et approuv/i;
const FILLER_RE = /_{3,}|(?:\. ?){4,}|(?:… ?){2,}|-{6,}/g;
const BOX_GLYPH_RE = /[☒☑☐□❑❒◻⬜▢❏]/g;
const MAX_PIXELS = 3.2e6;
// Champs « en peigne » tapés au clavier : |__|__|__| (séparateurs : barres, I, l, ı…)
const COMB_RE = /[|¦│┃ǀıIl_]+/g;
const SEP_ONLY_RE = /^[|¦│┃ǀıIl]{1,2}$/;

/**
 * @param {PDFPageProxy} pdfPage
 * @param {PageViewport} vp  viewport à l'échelle 1 et à la rotation de base
 * @param {number} rotation  rotation de base de la page
 * @returns {Promise<Array<{kind:'text'|'check'|'sig', x, y, w, h, label}>>}
 */
export async function detectFields(pdfPage, vp, rotation) {
  const W = vp.width, H = vp.height;
  let t0 = performance.now();
  const lap = (k) => { const t = performance.now(); timings[k] = (timings[k] || 0) + t - t0; t0 = t; };
  const [T, widgets] = await Promise.all([readText(pdfPage, vp), readWidgets(pdfPage, vp)]);
  // Points de conduite d'un sommaire / index (« Chapitre ........ 12 ») : pas des champs
  T.fillers = T.fillers.filter((f) => !isLeader(f, T.texts));
  lap('text');
  const R = await rasterize(pdfPage, W, H, rotation, T.texts);
  lap('raster');
  const out = [];
  // src : règle qui a produit le champ (diagnostic, jamais enregistré)
  const tag = (src) => { for (const f of out) f.src ||= src; };
  const exclusions = widgets.filter((w) => w.kind !== 'sig').map((w) => w.rect);

  // Texte invisible (recouvert par un rectangle blanc, couche OCR transparente…) : ignoré
  // On mesure l'encre au cœur des lettres (hauteur d'x) : le trait du champ juste dessous, ou le cadre autour,
  // ne doivent pas faire passer pour visible une ancienne valeur masquée par un cache blanc.
  const visible = T.texts.filter((t) => R.rawRatio(rectOf(t)) > 0.008 &&
    (!/[\p{L}\p{N}]/u.test(t.text) || R.rawRatio(glyphCore(t)) > 0.03));
  // Valeurs déjà saisies (texte posé sur une ligne, dans un peigne, sous un libellé…) : elles ne doivent
  // empêcher ni la détection du champ ni le test « zone vide », et deviennent la valeur modifiable du champ
  const cells = findCells(R.hsegs, R.vsegs);
  lap('cells');
  const tcombs = textCombs(T.combPieces, visible);
  const fills = findFillTexts(visible, T.fillers, tcombs, cells, R.hsegs, R.vsegs, W);
  T.texts = visible.filter((t) => !fills.has(t));
  R.inkRatio = R.ratioWithout([...fills]);
  lap('fills');

  // 1. Champs de signature natifs
  for (const w of widgets) if (w.kind === 'sig') out.push({ kind: 'sig', ...w.rect, label: w.label || 'Signature', native: true });

  // 1 bis. Peignes tapés au clavier (un caractère par case)
  tag('widget');
  out.push(...tcombs);
  tag('textcomb');

  // 2. Pointillés / soulignés tapés au clavier
  for (const f of T.fillers) {
    if (tcombs.some((c) => Math.abs(c.base - f.base) < f.size * 0.5 && f.x0 < c.x + c.w - 1 && f.x1 > c.x + 1)) continue;
    const sig = SIG_RE.test(f.label);
    const bottom = f.base + f.size * 0.2;
    let top = bottom - (sig ? 34 : Math.max(f.size * 1.25, 13));
    top = clampTop(top, bottom, f.x0, f.x1, T.texts, R.hsegs, f);
    if (bottom - top < 7) continue;
    // Pointillés seuls sur leur ligne : le libellé est la phrase juste au-dessus
    const label = f.label || labelNear(T.texts, { x: f.x0, y: top, w: f.x1 - f.x0, h: bottom - top });
    // cut : limite basse du masquage d'une valeur imprimée (ne pas effacer les « ____ » dessous)
    out.push({ kind: sig ? 'sig' : 'text', x: f.x0, y: top, w: f.x1 - f.x0, h: bottom - top, label, cut: f.base + f.size * 0.07 });
  }

  tag('filler');
  // 3. Cases dessinées avec un caractère (☐)
  for (const g of T.glyphs) {
    const s = Math.max(5, Math.min(g.x1 - g.x0, g.size * 0.9));
    const cy = g.base - g.size * 0.34;
    // La position est estimée d'après la police : on la recale sur le carré réellement dessiné
    const est = { x: (g.x0 + g.x1) / 2 - s / 2, y: cy - s / 2, w: s, h: s };
    const r = inkBox(R, est, s * 0.35) || est;
    // L'état coché d'une case en caractère se lit au caractère lui-même (☒ ☑), pas à l'encre
    out.push({ kind: 'check', ...r, label: g.label, glyph: true, printedMark: /[☒☑]/.test(g.char) || undefined });
  }

  tag('glyph');
  // 4. Cadres et cellules (les rangées de petites cases accolées forment un peigne)
  const cc = cellCombs(cells, T.texts, R);
  out.push(...cc.fields);
  for (const c of cells) {
    if (cc.used.has(c)) continue;
    const f = classifyCell(c, T.texts, R, W, H, cells);
    if (f) out.push(...[].concat(f));
  }

  tag('cell');
  // 4 bis. Peignes dessinés : ligne de base + petits traits verticaux
  out.push(...vectorCombs(R.hsegs, R.ticks, T.texts, R));
  tag('vcomb');

  // 5. Lignes « à remplir »
  for (const f of lineFields(R.hsegs, T.texts, R, W, H)) out.push(f);
  tag('line');

  // Nettoyage : dans la page, hors des vrais champs, sans doublons
  const fields = [];
  for (const f of out) {
    f.x = Math.max(0, f.x); f.y = Math.max(0, f.y);
    f.w = Math.min(f.w, W - f.x); f.h = Math.min(f.h, H - f.y);
    if (f.w < 4 || f.h < 4) continue;
    if (!f.native && exclusions.some((e) => overlapRatio(f, e) > 0.3)) continue;
    if (fields.some((o) => overlapRatio(f, o) > 0.45)) continue;
    f.label = (f.label || '').replace(/\s+/g, ' ').replace(/[\s:]+$/, '').trim().slice(0, 80);
    fields.push(f);
  }
  // Libellé sans mot (« ) », « I »…) : morceau d'un champ découpé, il reprend le libellé de son voisin de gauche
  const worded = (f) => /\p{L}{2}/u.test(f.label || '');
  for (const f of fields.slice().sort((p, q) => p.x - q.x)) {
    if (worded(f)) continue;
    const left = fields.filter((o) => o !== f && worded(o) && o.x + o.w <= f.x + 2 && f.x - (o.x + o.w) < 60 && Math.abs(o.y + o.h / 2 - (f.y + f.h / 2)) < 4)
      .sort((p, q) => q.x - p.x)[0];
    if (left) { f.label = left.label; continue; }
    // sinon : le dernier texte avec des mots à gauche, sur la même ligne
    const cy = f.y + f.h / 2;
    const txt = T.texts.filter((t) => /\p{L}{2}/u.test(t.text) && t.x1 <= f.x + 2 && Math.abs((t.y0 + t.y1) / 2 - cy) < Math.max(4, f.h * 0.6))
      .sort((p, q) => q.x1 - p.x1)[0];
    if (txt) f.label = txt.text.replace(/\s+/g, ' ').replace(/[\s:(]+$/, '').trim().slice(0, 80);
  }
  // Un vrai champ a toujours un libellé, ou prolonge un champ qui en a un juste au-dessus
  // (lignes suivantes d'un tableau, 2e ligne d'une adresse). Sinon : schéma, graphique, décor.
  const labelled = (f) => /\p{L}/u.test(f.label || '');
  // (une longue ligne de « ____ » tapée au clavier est un signal de formulaire suffisant)
  const kept = new Set(fields.filter((f) => f.native || labelled(f) || (f.src === 'filler' && f.w >= W * 0.4)));
  for (const f of fields.slice().sort((p, q) => p.y - q.y)) {
    if (kept.has(f)) continue;
    const above = [...kept].some((o) => o.y + o.h <= f.y + 2 && f.y - (o.y + o.h) < 20 &&
      overlapX({ x0: o.x, x1: o.x + o.w }, { x0: f.x, x1: f.x + f.w }) >= Math.min(o.w, f.w) * 0.5);
    if (above) kept.add(f);
  }
  for (let i = fields.length - 1; i >= 0; i--) if (!kept.has(fields[i])) fields.splice(i, 1);
  lap('fields');
  attachValues(fields, [...fills], R);
  for (const f of fields) delete f.base;
  lap('values');
  return fields;
}
/** Temps cumulés par étape (ms), pour le diagnostic des performances */
export const timings = {};

const rectOf = (t) => ({ x: t.x0, y: t.y0, w: t.x1 - t.x0, h: t.y1 - t.y0 });
/** Pointillés suivis d'un numéro de page sur la même ligne : points de conduite (sommaire, index) */
function isLeader(f, texts) {
  if (!/^[\s.…·•]+$/.test(f.chars || '')) return false;
  return texts.some((t) => /^(\d{1,4}|[ivxlcdm]{1,7})$/i.test(t.text.trim()) &&
    Math.abs(t.base - f.base) < f.size * 0.5 && t.x0 >= f.x1 - 2 && t.x0 - f.x1 < f.size * 3);
}
/** Bande centrale des lettres (entre ligne de base et hauteur d'x), sans les bords de la boîte du texte */
function glyphCore(t) {
  const size = t.size || (t.y1 - t.y0);
  const base = t.base ?? t.y1 - size * 0.2;
  const w = t.x1 - t.x0;
  return { x: t.x0 + Math.min(0.4, w * 0.1), y: base - size * 0.6, w: Math.max(0.5, w - Math.min(0.8, w * 0.2)), h: size * 0.45 };
}
const isColonLabel = (t) => /[:：]\s*$/.test(t.text);

/**
 * Textes qui sont des valeurs saisies dans un champ (et non des libellés du formulaire).
 * Repérés uniquement par leur position dans la structure du formulaire.
 */
const STRUCT_ONLY_RE = /^[\s|¦│┃ǀı_.·…\-–—:]+$/;
// Séparateurs d'un peigne tapé (certaines polices utilisent I ou l comme barre verticale)
const COMB_SEP_RE = /^[\s|¦│┃ǀıIl_]+$/;

/**
 * Trait horizontal qui appartient à un cadre (côté ou séparation intérieure) : un long trait vertical
 * passe par une de ses extrémités. Les petits traits d'un peigne (< 12 pt) ne comptent pas.
 */
function isFrameEdge(g, vsegs) {
  return vsegs.some((v) => (Math.abs(v.x - g.x0) < 2.5 || Math.abs(v.x - g.x1) < 2.5) &&
    v.y0 <= g.y + 2.5 && v.y1 >= g.y - 2.5 && (v.y1 - g.y > 12 || g.y - v.y0 > 12));
}

function findFillTexts(texts, fillers, tcombs, cells, hsegs, vsegs, W) {
  const fills = new Set();
  // Un texte fait uniquement de traits, de points ou de barres est la structure du champ, jamais sa valeur
  const add = (t) => { if (!STRUCT_ONLY_RE.test(t.text) && !(COMB_SEP_RE.test(t.text) && /[|_]/.test(t.text))) fills.add(t); };
  // a) écrit sur des pointillés / soulignés tapés au clavier
  for (const f of fillers) {
    for (const t of texts) {
      if (fills.has(t) || t.x0 < f.x0 - 3) continue;
      if (overlapX(t, f) >= Math.min(t.x1 - t.x0, f.x1 - f.x0) * 0.5 && t.base <= f.base + f.size * 0.35 && t.base >= f.base - f.size * 1.3) add(t);
    }
  }
  // b) dans un peigne tapé |__|__|
  for (const c of tcombs) {
    for (const t of texts) {
      if (fills.has(t) || /[|_]/.test(t.text) || COMB_SEP_RE.test(t.text)) continue;
      if (overlapX(t, { x0: c.x, x1: c.x + c.w }) >= (t.x1 - t.x0) * 0.8 && Math.abs(t.base - c.base) < c.size * 0.6) add(t);
    }
  }
  // c) posé sur une ligne « à remplir » (hors bordures de cadre), précédée d'un libellé
  for (const g of hsegs) {
    const len = g.x1 - g.x0;
    if (g.used || g.t > 2.6 || len < 14 || len > W * 0.92 || isFrameEdge(g, vsegs)) continue;
    const on = texts.filter((t) => !fills.has(t) && t.x0 >= g.x0 - 2 && t.x1 <= g.x1 + 3 && t.base <= g.y + 1.5 && t.base >= g.y - Math.max(9, t.size * 1.1));
    if (!on.length) continue;
    if (on.length === 1 && Math.abs(on[0].x0 - g.x0) < 3 && Math.abs(on[0].x1 - g.x1) < 3) continue; // simple soulignement
    const others = texts.filter((t) => !on.includes(t));
    const hasLabel = others.some((t) => t.x1 <= g.x0 + 4 && t.x1 >= g.x0 - 90 && Math.abs(t.base - g.y) < 14) ||
      // libellé sous la ligne (signature…) : pas pour un long trait, qui souligne plutôt un titre
      (len <= W * 0.6 && others.some((t) => t.y0 >= g.y - 1 && t.y0 <= g.y + 14 && overlapX(t, g) > 0 && t.text.length <= 45));
    const ruled = hsegs.some((o) => o !== g && Math.abs(o.x0 - g.x0) < 4 && Math.abs(o.x1 - g.x1) < 4 && Math.abs(o.y - g.y) > 8 && Math.abs(o.y - g.y) < 32);
    if (hasLabel || ruled) on.forEach(add);
  }
  // d) dans les cadres et cellules
  const sameRow = (a, b) => Math.abs(a.y0 - b.y0) < 1.5 && Math.abs(a.y1 - b.y1) < 1.5;
  const rowOf = (c) => {
    const row = [c];
    for (let grew = true; grew;) {
      grew = false;
      for (const o of cells) {
        if (row.includes(o) || !sameRow(o, c)) continue;
        if (row.some((r) => Math.abs(o.x1 - r.x0) < 2 || Math.abs(o.x0 - r.x1) < 2)) { row.push(o); grew = true; }
      }
    }
    return row.sort((p, q) => p.x0 - q.x0);
  };
  const innerOf = (c) => { const k = c.t / 2 + 0.8; return { x: c.x0 + k, y: c.y0 + k, w: c.x1 - c.x0 - 2 * k, h: c.y1 - c.y0 - 2 * k }; };
  const insideOf = (c) => { const r = innerOf(c); return texts.filter((t) => fracInside(t, r) > 0.5); };
  for (const c of cells) {
    const r = innerOf(c);
    if (r.w < 4 || r.h < 4) continue;
    const inside = insideOf(c).filter((t) => !fills.has(t));
    if (!inside.length) continue;
    // petite case (peigne, case à cocher) : un caractère saisi
    if (r.w <= 26 && r.h <= 32) {
      if (inside.length === 1 && inside[0].text.length <= 2) add(inside[0]);
      continue;
    }
    const row = rowOf(c);
    if (row.length >= 2) {
      // Tableau. Deux colonnes : libellé | valeur ; davantage : lignes de données sous l'en-tête
      if (row.length === 2) {
        if (row[1] !== c) continue;
        const lab = insideOf(row[0]);
        if (lab.length && (lab.some(isColonLabel) || lab.every((l) => inside.every((t) => t.fontName !== l.fontName)))) inside.forEach(add);
        continue;
      }
      const above = cells.some((o) => o !== c && Math.abs(o.y1 - c.y0) < 2 && o.x0 < c.x1 - 2 && o.x1 > c.x0 + 2);
      if (above && !inside.some(isColonLabel)) inside.forEach(add);
      continue;
    }
    // Cadre isolé : libellés « Xxx : » suivis d'une valeur sur la même ligne
    const colons = inside.filter(isColonLabel);
    for (const l of colons) {
      for (const t of inside) if (t !== l && !colons.includes(t) && t.x0 > l.x1 && Math.abs(t.base - l.base) < l.size * 0.5) add(t);
    }
    if (colons.length) continue;
    // libellé en haut à gauche (style CERFA), valeur en dessous
    const sorted = inside.slice().sort((p, q) => p.y0 - q.y0 || p.x0 - q.x0);
    const lab = sorted[0];
    if (lab.y0 - r.y < Math.max(6, r.h * 0.35) && lab.x0 - r.x < 12 && sorted.length > 1) {
      // Pas un paragraphe qui continue à la ligne : 1re ligne presque pleine largeur, ou suite dans la même police
      const line1 = inside.filter((t) => Math.abs(t.base - lab.base) < lab.size * 0.4);
      const wide = Math.max(...line1.map((t) => t.x1)) - Math.min(...line1.map((t) => t.x0)) > r.w * 0.6;
      const below = sorted.filter((t) => t.y0 >= lab.y1 - 1);
      const sameFont = below.length && below.every((t) => t.fontName === lab.fontName && Math.abs(t.size - lab.size) < 0.5);
      if (!wide && !sameFont) below.forEach(add);
      continue;
    }
    // aucun libellé dans le cadre : valeur courte d'une autre police que le libellé extérieur
    const outLabel = texts.filter((t) => !inside.includes(t) && t.x1 <= r.x + 3 && r.x - t.x1 < 120 && (t.y0 + t.y1) / 2 >= r.y - 2 && (t.y0 + t.y1) / 2 <= r.y + r.h + 2)
      .sort((p, q) => q.x1 - p.x1)[0];
    const lines = new Set(inside.map((t) => Math.round(t.base / 4))).size;
    if (outLabel && lines <= 2 && r.h <= 64 && inside.every((t) => t.fontName !== outLabel.fontName)) inside.forEach(add);
  }
  return fills;
}

/** Associe à chaque champ la valeur déjà imprimée (texte, coche, signature). */
function attachValues(fields, fills, R) {
  const used = new Set();
  for (const f of fields) {
    if (f.native) continue;
    if (f.kind === 'check') {
      if (f.glyph) { delete f.glyph; continue; }
      // retrait proportionnel + marge pour le bord et son anticrénelage (décisif pour les très petites cases)
      const k = Math.min(f.w, f.h) * 0.22 + 1.5 / R.scale;
      const ink = R.rawRatio({ x: f.x + k, y: f.y + k, w: f.w - 2 * k, h: f.h - 2 * k });
      if (ink > 0.04 && ink < 0.7) f.printedMark = true;
      for (const t of fills) if (fracInside(t, f) > 0.5) used.add(t);
      continue;
    }
    if (f.kind === 'sig') {
      if (R.rawRatio({ x: f.x + 2, y: f.y + 2, w: f.w - 4, h: f.h * 0.72 }) > 0.012) f.printedMark = true;
      continue;
    }
    const box = { x: f.x - 2, y: f.y - 2, w: f.w + 4, h: f.h + 4 };
    let mine = fills.filter((t) => !used.has(t) && fracInside(t, box) > 0.5);
    // valeur masquée puis réécrite au même endroit : la plus récente (dessinée par-dessus) l'emporte
    mine = mine.filter((t) => !mine.some((o) => o.idx > t.idx && overlapRatio(rectOf(t), rectOf(o)) > 0.3));
    if (!mine.length) continue;
    for (const t of mine) used.add(t);
    mine.sort((p, q) => (Math.abs(p.base - q.base) > Math.min(p.size, q.size) * 0.5 ? p.base - q.base : p.x0 - q.x0));
    if (f.comb) {
      const cells = f.comb.map(([a, b]) => [f.x + a * f.w, f.x + b * f.w]);
      const out = cells.map(() => ' ');
      for (const t of mine) {
        for (let k = 0; k < t.text.length; k++) {
          const ch = t.text[k];
          if (!ch.trim() || /[|¦│┃ǀı_]/.test(ch)) continue;
          const cx = t.cx ? (t.cx(k) + t.cx(k + 1)) / 2 : (t.x0 + t.x1) / 2;
          // un caractère saisi est centré dans sa case ; ce qui tombe sur une limite est un séparateur (I, |)
          const i = cells.findIndex(([a, b]) => cx >= a + (b - a) * 0.2 && cx <= b - (b - a) * 0.2);
          if (i >= 0) out[i] = ch;
        }
      }
      f.value = out.join('').replace(/\s+$/, '');
    } else {
      const lines = [];
      for (const t of mine) {
        const l = lines[lines.length - 1];
        if (l && Math.abs(l.base - t.base) <= t.size * 0.5) l.parts.push(t.text); else lines.push({ base: t.base, parts: [t.text] });
      }
      f.value = lines.map((l) => l.parts.join(' ')).join('\n');
    }
    if (!f.value.trim()) { delete f.value; continue; }
    f.valueRuns = mine.map((t) => ({
      text: t.text, x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1, base: t.base, size: t.size, fontName: t.fontName, family: t.family,
    }));
  }
}

// ---------- Texte ----------
async function readText(pdfPage, vp) {
  const tc = await pdfPage.getTextContent({ includeMarkedContent: false });
  const texts = [];    // morceaux de texte « réels » (occupation + libellés)
  const fillers = [];
  const glyphs = [];
  const combPieces = [];
  let idx = 0; // ordre de dessin : un texte plus récent est dessiné par-dessus les précédents
  for (const it of tc.items) {
    if (!it.str || !it.transform) continue;
    const [a, b, c, d, e, f] = it.transform;
    const hgt = Math.hypot(c, d) || it.height || 10;
    const len = Math.hypot(a, b) || 1;
    const ux = a / len, uy = b / len;
    const vx = c / hgt, vy = d / hgt;
    const st = tc.styles[it.fontName] || {};
    const asc = st.ascent || 0.8, desc = st.descent || -0.2;
    const Wd = it.width;
    const corner = (t, up) => vp.convertToViewportPoint(e + ux * Wd * t + vx * up * hgt, f + uy * Wd * t + vy * up * hgt);
    const pts = [corner(0, desc), corner(1, desc), corner(0, asc), corner(1, asc)];
    const b0 = vp.convertToViewportPoint(e, f), b1 = vp.convertToViewportPoint(e + ux * Wd, f + uy * Wd);
    const horizontal = Math.abs(b1[1] - b0[1]) <= Math.max(1, Math.abs(b1[0] - b0[0]) * 0.1) && b1[0] >= b0[0];
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const box = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
    if (!horizontal) {
      if (it.str.trim()) texts.push({ text: it.str, ...box, base: b0[1], size: hgt, idx: idx++, fontName: it.fontName, family: st.fontFamily || '' });
      continue;
    }
    // Découper la chaîne en morceaux texte / pointillés / cases, positionnés proportionnellement
    const str = it.str;
    const font = `100px ${st.fontFamily || 'sans-serif'}`;
    const total = measure(str, font) || 1;
    const xAt = (i) => b0[0] + ((measure(str.slice(0, i), font) / total) * (b1[0] - b0[0]));
    const marks = [];
    for (const m of str.matchAll(FILLER_RE)) marks.push({ i: m.index, j: m.index + m[0].length, type: 'fill' });
    for (const m of str.matchAll(BOX_GLYPH_RE)) marks.push({ i: m.index, j: m.index + m[0].length, type: 'box' });
    marks.sort((p, q) => p.i - q.i);
    const sepOnly = SEP_ONLY_RE.test(str.trim());
    for (const m of str.matchAll(COMB_RE)) {
      if (!m[0].includes('_') && !sepOnly) continue;
      const chars = [];
      for (let k = 0; k < m[0].length; k++) chars.push({ ch: m[0][k], x0: xAt(m.index + k), x1: xAt(m.index + k + 1) });
      combPieces.push({ chars, x0: chars[0].x0, x1: chars[chars.length - 1].x1, base: b0[1], size: hgt, prefix: str.slice(0, m.index) });
    }
    let pos = 0;
    let lastLabel = '';
    const pushText = (i, j) => {
      const s = str.slice(i, j);
      if (!s.trim()) return;
      // ignorer les espaces de bord pour une boîte serrée
      const li = i + (s.length - s.trimStart().length), lj = j - (s.length - s.trimEnd().length);
      texts.push({
        text: s.trim(), x0: xAt(li), x1: xAt(lj), y0: box.y0, y1: box.y1, base: b0[1], size: hgt,
        idx: idx++, fontName: it.fontName, family: st.fontFamily || '', cx: (k) => xAt(li + k),
      });
      lastLabel = s.trim();
    };
    for (const m of marks) {
      if (m.i < pos) continue;
      pushText(pos, m.i);
      const x0 = xAt(m.i), x1 = xAt(m.j);
      const label = lastLabel || nearestLeftLabel(texts, x0, b0[1], hgt);
      if (m.type === 'fill') fillers.push({ x0, x1, base: b0[1], size: hgt, label, chars: str.slice(m.i, m.j) });
      else glyphs.push({ x0, x1, base: b0[1], size: hgt, char: str.slice(m.i, m.j), label: str.slice(m.j).trim().slice(0, 60) });
      pos = m.j;
    }
    pushText(pos, str.length);
  }
  // Pour les cases ☐, le libellé suit généralement la case (« ☐ Oui ») : compléter avec le texte à droite
  for (const g of glyphs) {
    if (g.label) continue;
    const right = texts.filter((t) => Math.abs(t.base - g.base) < g.size * 0.4 && t.x0 >= g.x1 - 1 && t.x0 - g.x1 < 30)
      .sort((p, q) => p.x0 - q.x0)[0];
    if (right) g.label = right.text;
  }
  return { texts, fillers, glyphs, combPieces };
}

function nearestLeftLabel(texts, x, base, size) {
  let best = null;
  for (const t of texts) {
    if (Math.abs(t.base - base) > size * 0.5 || t.x1 > x + 2 || x - t.x1 > 120) continue;
    if (!best || t.x1 > best.x1) best = t;
  }
  return best?.text || '';
}

// ---------- Champs natifs ----------
async function readWidgets(pdfPage, vp) {
  let annots = [];
  try { annots = await pdfPage.getAnnotations({ intent: 'display' }); } catch { return []; }
  const out = [];
  for (const a of annots) {
    if (a.subtype !== 'Widget' || !a.rect) continue;
    const p0 = vp.convertToViewportPoint(a.rect[0], a.rect[1]), p1 = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
    const r = [p0[0], p0[1], p1[0], p1[1]];
    const rect = { x: Math.min(r[0], r[2]), y: Math.min(r[1], r[3]), w: Math.abs(r[2] - r[0]), h: Math.abs(r[3] - r[1]) };
    if (rect.w < 1 || rect.h < 1) continue;
    out.push({ kind: a.fieldType === 'Sig' ? 'sig' : 'other', rect, label: a.alternativeText || a.fieldName || '' });
  }
  return out;
}

// ---------- Analyse de l'image ----------
async function rasterize(pdfPage, W, H, rotation, texts) {
  const s = Math.min(2, Math.sqrt(MAX_PIXELS / (W * H)));
  const canvas = await renderPageToCanvas(pdfPage, s, rotation, { annotationMode: pdfjsLib.AnnotationMode.DISABLE });
  const cw = canvas.width, ch = canvas.height;
  const data = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, cw, ch).data;
  canvas.width = canvas.height = 0;
  const ink = new Uint8Array(cw * ch);
  for (let i = 0, p = 0; i < ink.length; i++, p += 4) {
    ink[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) < 212000 ? 1 : 0;
  }
  // Images intégrales de l'encre (avant d'effacer le texte) pour mesurer si une zone est vide
  const iw = cw + 1;
  const buildInteg = (src) => {
    const integ = new Uint32Array(iw * (ch + 1));
    for (let y = 0; y < ch; y++) {
      let row = 0;
      for (let x = 0; x < cw; x++) {
        row += src[y * cw + x];
        integ[(y + 1) * iw + x + 1] = integ[y * iw + x + 1] + row;
      }
    }
    return integ;
  };
  const ratioOf = (integ) => (r) => {
    const x0 = clampI(Math.floor(r.x * s), 0, cw), x1 = clampI(Math.ceil((r.x + r.w) * s), 0, cw);
    const y0 = clampI(Math.floor(r.y * s), 0, ch), y1 = clampI(Math.ceil((r.y + r.h) * s), 0, ch);
    const area = (x1 - x0) * (y1 - y0);
    if (area <= 0) return 0;
    const sum = integ[y1 * iw + x1] - integ[y0 * iw + x1] - integ[y1 * iw + x0] + integ[y0 * iw + x0];
    return sum / area;
  };
  const rawRatio = ratioOf(buildInteg(ink));
  /** Taux d'encre en ignorant les textes donnés (valeurs saisies dans les champs) */
  const ratioWithout = (list) => {
    if (!list.length) return rawRatio;
    const k = ink.slice();
    for (const t of list) {
      const x0 = clampI(Math.floor((t.x0 - 0.5) * s), 0, cw - 1), x1 = clampI(Math.ceil((t.x1 + 0.5) * s), 0, cw - 1);
      const y0 = clampI(Math.floor((t.y0 - 0.5) * s), 0, ch - 1), y1 = clampI(Math.ceil((t.y1 + 0.5) * s), 0, ch - 1);
      for (let y = y0; y <= y1; y++) k.fill(0, y * cw + x0, y * cw + x1 + 1);
    }
    return ratioOf(buildInteg(k));
  };
  // Effacer le texte vectoriel pour que les lettres ne créent pas de faux traits
  const mask = ink.slice();
  for (const t of texts) {
    const x0 = Math.max(0, Math.floor((t.x0 + 0.6) * s)), x1 = Math.min(cw - 1, Math.ceil((t.x1 - 0.6) * s));
    const y0 = Math.max(0, Math.floor((t.y0 + 0.6) * s)), y1 = Math.min(ch - 1, Math.ceil((t.y1 - 0.6) * s));
    for (let y = y0; y <= y1; y++) mask.fill(0, y * cw + x0, y * cw + x1 + 1);
  }
  const minLen = Math.max(6, Math.round(5 * s));
  const maxT = 3.2 * s;
  const hsegs = scanSegments(mask, cw, ch, minLen, true)
    .filter((g) => g.b1 - g.b0 + 1 <= maxT)
    .map((g) => ({ x0: g.a0 / s, x1: (g.a1 + 1) / s, y: (g.b0 + g.b1 + 1) / 2 / s, t: (g.b1 - g.b0 + 1) / s }));
  mendLines(hsegs, texts);
  // Traits verticaux, y compris les petits (séparateurs des peignes) ; les cadres n'utilisent que les longs
  const ticks = scanSegments(mask, cw, ch, Math.max(4, Math.round(1.8 * s)), false)
    .filter((g) => g.b1 - g.b0 + 1 <= maxT)
    .map((g) => ({ y0: g.a0 / s, y1: (g.a1 + 1) / s, x: (g.b0 + g.b1 + 1) / 2 / s, t: (g.b1 - g.b0 + 1) / s, n: g.a1 - g.a0 + 1 }));
  const vsegs = ticks.filter((v) => v.n >= minLen);
  return { hsegs, vsegs, ticks, rawRatio, ratioWithout, inkRatio: rawRatio, scale: s };
}
const clampI = (v, a, b) => (v < a ? a : v > b ? b : v);

/**
 * Le masquage du texte ronge les traits sur lesquels une valeur saisie est posée :
 * on recolle les morceaux d'un même trait (fragments inclus dans un plus long, coupures sous un texte).
 */
function mendLines(hsegs, texts) {
  const near = (a, b) => Math.abs(a.y - b.y) <= (a.t + b.t) / 2 + 0.6;
  const absorb = (o, g) => {
    const top = Math.min(o.y - o.t / 2, g.y - g.t / 2), bot = Math.max(o.y + o.t / 2, g.y + g.t / 2);
    o.x0 = Math.min(o.x0, g.x0); o.x1 = Math.max(o.x1, g.x1); o.y = (top + bot) / 2; o.t = bot - top;
  };
  // Balayage par « rangée » de traits (même hauteur), de gauche à droite : linéaire au lieu de
  // recommencer toute la recherche après chaque fusion (très lent sur les pages chargées de texte).
  const byY = hsegs.slice().sort((a, b) => a.y - b.y);
  const rows = [];
  for (const g of byY) {
    const row = rows[rows.length - 1];
    if (row && near(row[row.length - 1], g)) row.push(g); else rows.push([g]);
  }
  const out = [];
  for (const row of rows) {
    if (row.length === 1) { out.push(row[0]); continue; }
    const y0 = Math.min(...row.map((g) => g.y)) - 3, y1 = Math.max(...row.map((g) => g.y)) + 3;
    const rowTexts = texts.filter((t) => t.y0 <= y1 && t.y1 >= y0);
    let list = row.slice().sort((a, b) => a.x0 - b.x0);
    for (let changed = true; changed && list.length > 1;) {
      changed = false;
      const merged = [list[0]];
      for (let k = 1; k < list.length; k++) {
        const o = merged[merged.length - 1], g = list[k];
        let ok = false;
        if (near(o, g)) {
          const inside = (g.x0 >= o.x0 - 1 && g.x1 <= o.x1 + 1) || (o.x0 >= g.x0 - 1 && o.x1 <= g.x1 + 1);
          const gap = g.x0 - o.x1;
          const bridged = gap > 0 && gap < 400 && rowTexts.some((t) => t.x0 <= o.x1 + 2 && t.x1 >= g.x0 - 2 && t.y0 <= o.y + 2 && t.y1 >= o.y - 2);
          ok = (inside || gap <= 1.5 || bridged) && !(inside && o.t + g.t > 3.2); // trait épais (cadre) : pas de fusion
        }
        if (ok) { absorb(o, g); changed = true; } else merged.push(g);
      }
      list = merged;
    }
    out.push(...list);
  }
  hsegs.length = 0;
  hsegs.push(...out);
}

/**
 * Segments de traits continus. horizontal=true : a = x, b = y (épaisseur). Sinon a = y, b = x.
 * Les petites interruptions (1 px, anticrénelage) sont tolérées.
 */
function scanSegments(mask, cw, ch, minLen, horizontal) {
  const along = horizontal ? cw : ch, across = horizontal ? ch : cw;
  const at = horizontal ? (a, b) => mask[b * cw + a] : (a, b) => mask[a * cw + b];
  const segs = [];
  let active = [];
  for (let b = 0; b < across; b++) {
    const next = [];
    let a = 0;
    while (a < along) {
      if (!at(a, b)) { a++; continue; }
      let a1 = a;
      while (a1 + 1 < along && (at(a1 + 1, b) || (a1 + 2 < along && at(a1 + 2, b)))) a1++;
      if (a1 - a + 1 >= minLen) {
        let sg = null;
        for (let k = 0; k < active.length; k++) {
          const c = active[k];
          if (Math.abs(c.a0 - a) <= 2 && Math.abs(c.a1 - a1) <= 2) { sg = c; active.splice(k, 1); break; }
        }
        if (sg) { sg.b1 = b; sg.a0 = Math.min(sg.a0, a); sg.a1 = Math.max(sg.a1, a1); }
        else { sg = { a0: a, a1, b0: b, b1: b }; segs.push(sg); }
        next.push(sg);
      }
      a = a1 + 1;
    }
    active = next;
  }
  return segs;
}

// ---------- Cadres / cellules ----------
function findCells(H, V) {
  const cells = [];
  if (H.length > 700 || V.length > 700) return cells; // dessin trop complexe (plan, graphique…)
  const hs = H.slice().sort((p, q) => p.y - q.y);
  const vs = V.slice().sort((p, q) => p.x - q.x);
  const seen = new Set();
  for (let i = 0; i < hs.length; i++) {
    const top = hs[i];
    for (let j = i + 1; j < hs.length; j++) {
      const bot = hs[j];
      const dy = bot.y - top.y;
      if (dy < 4.5) continue;
      if (dy > 320) break;
      const ox0 = Math.max(top.x0, bot.x0), ox1 = Math.min(top.x1, bot.x1);
      if (ox1 - ox0 < 4.5) continue;
      const cand = [];
      for (const v of vs) {
        if (v.x < ox0 - 2.5) continue;
        if (v.x > ox1 + 2.5) break;
        if (v.y0 <= top.y + 2.5 && v.y1 >= bot.y - 2.5) {
          if (cand.length && v.x - cand[cand.length - 1].x < 2) continue;
          cand.push(v);
        }
      }
      for (let k = 0; k + 1 < cand.length; k++) {
        const va = cand[k], vb = cand[k + 1];
        if (vb.x - va.x < 4.5) continue;
        // cellule minimale : aucun trait horizontal ne la recoupe
        let blocked = false;
        for (let m = i + 1; m < j; m++) {
          const hh = hs[m];
          if (hh.y > top.y + 2 && hh.y < bot.y - 2 && hh.x0 <= va.x + 2 && hh.x1 >= vb.x - 2) { blocked = true; break; }
        }
        if (blocked) continue;
        const key = `${Math.round(va.x)}|${Math.round(top.y)}|${Math.round(vb.x)}|${Math.round(bot.y)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        top.used = bot.used = true;
        cells.push({ x0: va.x, x1: vb.x, y0: top.y, y1: bot.y, t: Math.max(top.t, bot.t, va.t, vb.t) });
      }
    }
  }
  return cells;
}

function classifyCell(c, texts, R, W, H, cells) {
  const inset = c.t / 2 + 0.8;
  const r = { x: c.x0 + inset, y: c.y0 + inset, w: c.x1 - c.x0 - 2 * inset, h: c.y1 - c.y0 - 2 * inset };
  if (r.w < 4 || r.h < 4) return null;
  if (r.w * r.h > W * H * 0.35 || (r.w > W * 0.9 && r.h > H * 0.5)) return null; // cadre de page
  const inside = texts.filter((t) => fracInside(t, r) > 0.5);
  const square = Math.abs(r.w - r.h) <= Math.max(r.w, r.h) * 0.3 && r.w <= 26 && r.h <= 26;
  const near = labelNear(texts, r);
  // Cellule d'un tableau (une voisine partage sa hauteur et un côté)
  const inGrid = cells.some((o) => o !== c && Math.abs(o.y0 - c.y0) < 1.5 && Math.abs(o.y1 - c.y1) < 1.5 && (Math.abs(o.x1 - c.x0) < 2 || Math.abs(o.x0 - c.x1) < 2));

  if (!inside.length) {
    const ink = R.inkRatio(r);
    // case cochée (trait de coche) : reste une case ; carré plein (puce, pastille de couleur) : ignoré
    if (square) return ink > 0.55 ? null : { kind: 'check', x: c.x0, y: c.y0, w: c.x1 - c.x0, h: c.y1 - c.y0, label: rightLabel(texts, r) || near };
    if (r.h < 7) return null;
    if (SIG_RE.test(near) && r.h >= 22) return { kind: 'sig', ...r, label: near }; // éventuellement déjà signé
    if (ink > 0.02) return null; // contenu non textuel (image, dessin…)
    // Cadre vide sans aucun libellé, hors tableau : élément de schéma ou décor, pas une zone à remplir
    if (!near && !inGrid) return null;
    if (r.h <= 64) return { kind: 'text', ...r, label: near };
    if (r.h <= 170 && r.w >= 60) return { kind: 'text', ...r, label: near, multiline: true };
    return null;
  }
  if (square) return null;
  // Libellé imprimé dans le cadre : la zone libre est en dessous ou à droite
  const label = inside.map((t) => t.text).join(' ');
  const tx1 = Math.max(...inside.map((t) => t.x1));
  const ty1 = Math.max(...inside.map((t) => t.y1));
  const tx0 = Math.min(...inside.map((t) => t.x0));
  const below = { x: r.x, y: ty1 + 1, w: r.w, h: r.y + r.h - ty1 - 1 };
  const right = { x: tx1 + 3, y: r.y, w: r.x + r.w - tx1 - 3, h: r.h };
  const sig = SIG_RE.test(label);
  // Plusieurs libellés « Xxx : » dans le cadre : une zone après chacun
  let colon = inside.filter((t) => /[:：]\s*$/.test(t.text) && !SIG_RE.test(t.text));
  if (colon.length) {
    // Encadré « Définition : » suivi de lignes de contenu (sans « : ») : c'est un texte, pas un formulaire
    const sameLine = (a, b) => Math.abs(a.base - b.base) < Math.min(a.size, b.size) * 0.5;
    const firstBase = Math.min(...colon.map((t) => t.base));
    const contentLines = [];
    for (const t of inside) {
      if (t.base <= firstBase + t.size * 0.5 || colon.some((k) => sameLine(k, t))) continue;
      if (!contentLines.some((o) => sameLine(o, t))) contentLines.push(t);
    }
    if (contentLines.length >= 2) colon = [];
  }
  if (colon.length) {
    const res = [];
    for (const t of colon) {
      const next = inside.filter((o) => o !== t && o.x0 > t.x1 && Math.abs(o.base - t.base) < t.size * 0.5).sort((p, q) => p.x0 - q.x0)[0];
      const x0 = t.x1 + 3, x1 = next ? next.x0 - 6 : r.x + r.w - 1;
      const fh = Math.min(r.h, Math.max(t.y1 - t.y0 + 4, 13));
      const y = Math.min(Math.max(r.y, (t.y0 + t.y1) / 2 - fh / 2), r.y + r.h - fh);
      const f = { kind: 'text', x: x0, y, w: x1 - x0, h: fh, label: t.text };
      if (f.w >= 30 && R.inkRatio(f) < 0.01) res.push(f);
    }
    if (res.length) return res;
  }
  if (below.h >= (sig ? 20 : 10) && below.h >= r.h * 0.4 && R.inkRatio(below) < 0.01) {
    return { kind: sig ? 'sig' : 'text', ...below, label, multiline: below.h > 40 && !sig };
  }
  const leftAligned = tx0 - r.x < 10;
  // Cellule d'un tableau avec un texte sans « : » : c'est un en-tête, pas un champ
  const hasColon = /[:：]\s*$/.test(label);
  if (inGrid && !hasColon) return null;
  const minRight = hasColon ? 30 : Math.max(40, r.w * 0.45);
  if (leftAligned && right.w >= minRight && r.h <= 64 && R.inkRatio(right) < 0.01) {
    return { kind: sig ? 'sig' : 'text', ...right, label };
  }
  return null;
}

// ---------- Peignes (un caractère par case) ----------
const combFrac = (cells, x0, w) => cells.map(([a, b]) => [(a - x0) / w, (b - x0) / w]);

/** Peignes tapés au clavier : morceaux « |__|__ » enchaînés sur une même ligne de base. */
function textCombs(pieces, texts) {
  const chains = [];
  for (const pc of pieces.slice().sort((p, q) => p.x0 - q.x0)) {
    const ch = chains.find((c) => {
      const l = c[c.length - 1], sz = Math.max(l.size, pc.size);
      return Math.abs(l.base - pc.base) < sz * 0.35 && pc.x0 >= l.x1 - 1.5 && pc.x0 - l.x1 < Math.max(2.5, sz * 0.25);
    });
    if (ch) ch.push(pc); else chains.push([pc]);
  }
  const out = [];
  for (const c of chains) {
    const chars = c.flatMap((p) => p.chars.map((k) => ({ ...k, size: p.size, base: p.base })));
    const seps = chars.filter((k) => k.ch !== '_');
    let groups = 0;
    for (let i = 0; i < chars.length; i++) if (chars[i].ch === '_' && (i === 0 || chars[i - 1].ch !== '_')) groups++;
    if (seps.length < 2 || groups < 2) continue;
    const bounds = [];
    const addB = (x) => { if (!bounds.length || x - bounds[bounds.length - 1] > 1.5) bounds.push(x); };
    if (chars[0].ch === '_') addB(chars[0].x0);
    for (const k of chars) if (k.ch !== '_') addB((k.x0 + k.x1) / 2);
    if (chars[chars.length - 1].ch === '_') addB(chars[chars.length - 1].x1);
    const cells = [];
    for (let i = 0; i + 1 < bounds.length; i++) if (bounds[i + 1] - bounds[i] >= 2.5) cells.push([bounds[i], bounds[i + 1]]);
    if (cells.length < 2) continue;
    const size = Math.max(...seps.map((k) => k.size));
    const base = Math.max(...chars.map((k) => k.base));
    const x0 = cells[0][0], w = cells[cells.length - 1][1] - x0;
    const top = base - size * 0.78, bottom = base + size * 0.1;
    const label = c[0].prefix.trim() || nearestLeftLabel(texts, x0, base, size);
    out.push({ kind: 'text', x: x0, y: top, w, h: bottom - top, label, comb: combFrac(cells, x0, w), base, size, cut: base + size * 0.06 });
  }
  return out;
}

/** Rangées de petites cases vides accolées (style CERFA), éventuellement en groupes séparés par un petit blanc. */
function cellCombs(cells, texts, R) {
  const used = new Set(), fields = [];
  const small = cells.filter((c) => {
    const w = c.x1 - c.x0, h = c.y1 - c.y0;
    if (w < 5 || w > 24 || h < 7 || h > 30 || h < w * 0.6) return false;
    const r = { x: c.x0, y: c.y0, w, h };
    const inset = c.t / 2 + 0.8;
    return !texts.some((t) => fracInside(t, r) > 0.5) && R.inkRatio({ x: c.x0 + inset, y: c.y0 + inset, w: w - 2 * inset, h: h - 2 * inset }) <= 0.02;
  });
  const seen = new Set();
  for (const c of small) {
    if (seen.has(c)) continue;
    const row = small.filter((o) => Math.abs(o.y0 - c.y0) < 1.5 && Math.abs(o.y1 - c.y1) < 1.5).sort((p, q) => p.x0 - q.x0);
    for (const o of row) seen.add(o);
    let run = [row[0]];
    const flush = () => {
      const adjacent = run.some((o, i) => i && Math.abs(o.x0 - run[i - 1].x1) < 2);
      if (run.length >= 3 && adjacent) {
        const x0 = run[0].x0, w = run[run.length - 1].x1 - x0;
        const y0 = Math.min(...run.map((o) => o.y0)), y1 = Math.max(...run.map((o) => o.y1));
        const r = { kind: 'text', x: x0, y: y0, w, h: y1 - y0, comb: combFrac(run.map((o) => [o.x0, o.x1]), x0, w) };
        r.label = labelNear(texts, r);
        fields.push(r);
        for (const o of run) used.add(o);
      }
    };
    for (let i = 1; i < row.length; i++) {
      const a = run[run.length - 1], b = row[i];
      const gap = b.x0 - a.x1;
      const ok = gap < 2 || (gap <= (a.x1 - a.x0) * 1.6 &&
        !texts.some((t) => overlapX(t, { x0: a.x1, x1: b.x0 }) > 0.5 && t.y1 > a.y0 && t.y0 < a.y1) &&
        R.inkRatio({ x: a.x1 + 1, y: a.y0, w: gap - 2, h: a.y1 - a.y0 }) < 0.02);
      if (ok) run.push(b); else { flush(); run = [b]; }
    }
    flush();
  }
  return { fields, used };
}

/** Peignes dessinés : une ligne de base hérissée de petits traits verticaux réguliers. */
function vectorCombs(H, ticks, texts, R) {
  const out = [];
  if (ticks.length > 4000) return out;
  for (const g of H) {
    if (g.used || g.t > 2.6 || g.x1 - g.x0 < 14) continue;
    const top = g.y - g.t / 2, bot = g.y + g.t / 2;
    const xs = [];
    for (const v of ticks) {
      if (v.x < g.x0 - 2 || v.x > g.x1 + 2 || v.y1 < bot - 1.2 || v.y1 > bot + 1.5 || v.y0 > top - 1.5 || top - v.y0 > 30) continue;
      xs.push({ x: v.x, h: top - v.y0 });
    }
    xs.sort((p, q) => p.x - q.x);
    const ts = [];
    for (const v of xs) {
      const l = ts[ts.length - 1];
      if (l && v.x - l.x < 2) l.h = Math.max(l.h, v.h); else ts.push({ ...v });
    }
    if (ts.length < 3) continue;
    const span = ts[ts.length - 1].x - ts[0].x;
    if (span < (g.x1 - g.x0) * 0.85) continue;
    const gaps = ts.slice(1).map((v, i) => v.x - ts[i].x);
    const gmin = Math.min(...gaps), gmax = Math.max(...gaps);
    if (gmin < 3.5 || gmax > 40 || gmax > gmin * 3.5) continue;
    const bottom = top - 0.3;
    // hauteur : celle des grands traits (+ un peu), pour que les caractères reposent sur la ligne
    const want = clampN(Math.max(...ts.map((v) => v.h)) + 2.5, 10, 22);
    const y0 = clampTop(bottom - want, bottom, ts[0].x, ts[ts.length - 1].x, texts, H, g);
    const h = bottom - y0;
    if (h < 7) continue;
    if (gaps.some((gw, i) => R.inkRatio({ x: ts[i].x + 1, y: y0 + 0.5, w: gw - 2, h: h - 1.5 }) > 0.03)) continue;
    g.used = true;
    const x0 = ts[0].x;
    const r = { kind: 'text', x: x0, y: y0, w: span, h, comb: combFrac(gaps.map((gw, i) => [ts[i].x, ts[i + 1].x]), x0, span) };
    r.label = labelNear(texts, r);
    out.push(r);
  }
  return out;
}
const clampN = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------- Lignes ----------
function lineFields(H, texts, R, W, Hpage) {
  const out = [];
  const cand = H.filter((g) => !g.used && g.t <= 2.6 && g.x1 - g.x0 >= 18);
  for (const g of cand) {
    const len = g.x1 - g.x0;
    if (len > W * 0.92) continue;
    // Déjà rempli ou simple soulignement d'un texte
    const onTop = texts.some((t) => overlapX(t, g) >= Math.min(t.x1 - t.x0, len) * 0.25 && t.y1 >= g.y - 5 && t.y0 < g.y);
    if (onTop) continue;
    // Côté d'un cadre (haut ou bas), pas une ligne à remplir
    if (isFrameEdge(g, R.vsegs)) continue;
    const left = texts.filter((t) => t.x1 >= g.x0 - 90 && t.x1 <= g.x0 + 4 && t.y1 >= g.y - 18 && t.y1 <= g.y + 5 && t.y0 < g.y)
      .sort((p, q) => q.x1 - p.x1)[0];
    const below = texts.filter((t) => t.y0 >= g.y - 1 && t.y0 <= g.y + 14 && overlapX(t, g) >= Math.min(t.x1 - t.x0, len) * 0.3 && t.text.length <= 45)
      .sort((p, q) => p.y0 - q.y0)[0];
    const ruled = cand.some((o) => o !== g && Math.abs(o.x0 - g.x0) < 4 && Math.abs(o.x1 - g.x1) < 4 && Math.abs(o.y - g.y) > 8 && Math.abs(o.y - g.y) < 32);
    const label = left?.text || below?.text || '';
    if (!label && !ruled) continue;
    const sig = SIG_RE.test(label);
    const bandAbove = { x: g.x0 + 1, y: g.y - 11, w: len - 2, h: 8.5 };
    if (!sig && R.inkRatio(bandAbove) > 0.03) continue;
    // Bord d'une surface pleine (en-tête de tableau grisé, bandeau coloré) : pas une ligne d'écriture
    if (R.rawRatio({ x: g.x0 + 1, y: g.y + g.t / 2 + 0.8, w: len - 2, h: 4 }) > 0.45) continue;
    const bottom = g.y - g.t / 2 - 0.4;
    let top = bottom - (sig ? 36 : 15);
    top = clampTop(top, bottom, g.x0, g.x1, texts, H, g);
    if (bottom - top < 8) continue;
    out.push({ kind: sig ? 'sig' : 'text', x: g.x0, y: top, w: len, h: bottom - top, label });
  }
  return out;
}

/**
 * Rectangle exact de l'encre autour d'une position estimée (marge `pad` de recherche).
 * Rogne chaque côté tant que la bande de bord est vide. null si rien de plausible.
 */
function inkBox(R, est, pad) {
  let x0 = est.x - pad, y0 = est.y - pad, x1 = est.x + est.w + pad, y1 = est.y + est.h + pad;
  const st = 0.25, empty = (r) => R.rawRatio(r) < 0.02;
  while (x1 - x0 > 2 && empty({ x: x0, y: y0, w: st, h: y1 - y0 })) x0 += st;
  while (x1 - x0 > 2 && empty({ x: x1 - st, y: y0, w: st, h: y1 - y0 })) x1 -= st;
  while (y1 - y0 > 2 && empty({ x: x0, y: y0, w: x1 - x0, h: st })) y0 += st;
  while (y1 - y0 > 2 && empty({ x: x0, y: y1 - st, w: x1 - x0, h: st })) y1 -= st;
  const w = x1 - x0, h = y1 - y0;
  if (w < 2.5 || h < 2.5 || w > est.w * 1.6 || h > est.h * 1.6 || Math.abs(w - h) > Math.max(w, h) * 0.35) return null;
  return { x: x0, y: y0, w, h };
}

/** Remonte le haut d'une zone jusqu'au premier obstacle (texte ou trait) situé au-dessus. */
function clampTop(top, bottom, x0, x1, texts, H, self) {
  const w = x1 - x0;
  for (const t of texts) {
    if (overlapX(t, { x0, x1 }) < Math.min(w, t.x1 - t.x0) * 0.3) continue;
    if (t.y1 > top && t.y1 <= bottom - 3 && t.y0 < bottom - 3) top = Math.max(top, t.y1 + 0.8);
  }
  for (const h of H) {
    if (h === self || overlapX(h, { x0, x1 }) < w * 0.3) continue;
    if (h.y > top && h.y < bottom - 3) top = Math.max(top, h.y + h.t / 2 + 0.8);
  }
  return top;
}

// ---------- Libellés ----------
function labelNear(texts, r) {
  // à gauche sur la même hauteur, sinon juste au-dessus
  let best = null, bd = Infinity;
  for (const t of texts) {
    const cy = (t.y0 + t.y1) / 2;
    if (t.x1 <= r.x + 3 && r.x - t.x1 < 120 && cy >= r.y - 2 && cy <= r.y + r.h + 2) {
      const d = r.x - t.x1;
      if (d < bd) { bd = d; best = t; }
    } else if (t.y1 <= r.y + 2 && r.y - t.y1 < 16 && overlapX(t, { x0: r.x, x1: r.x + r.w }) > 0) {
      const d = (r.y - t.y1) * 2 + 40;
      if (d < bd) { bd = d; best = t; }
    }
  }
  return best?.text || '';
}
function rightLabel(texts, r) {
  const cy = r.y + r.h / 2;
  const t = texts.filter((q) => q.x0 >= r.x + r.w - 1 && q.x0 - (r.x + r.w) < 40 && Math.abs((q.y0 + q.y1) / 2 - cy) < Math.max(r.h, 8))
    .sort((p, q) => p.x0 - q.x0)[0];
  return t?.text || '';
}

// ---------- Géométrie ----------
function overlapX(a, b) { return Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)); }
function fracInside(t, r) {
  const ix = Math.max(0, Math.min(t.x1, r.x + r.w) - Math.max(t.x0, r.x));
  const iy = Math.max(0, Math.min(t.y1, r.y + r.h) - Math.max(t.y0, r.y));
  const area = (t.x1 - t.x0) * (t.y1 - t.y0);
  return area > 0 ? (ix * iy) / area : 0;
}
/** Recouvrement rapporté à la plus petite des deux zones ({x,y,w,h}) */
export function overlapRatio(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const m = Math.min(a.w * a.h, b.w * b.h);
  return m > 0 ? (ix * iy) / m : 0;
}

/** Type le plus probable d'une zone tracée à la main */
export function guessKind(r, nearLabel = '') {
  if (Math.abs(r.w - r.h) <= Math.max(r.w, r.h) * 0.3 && r.w <= 26) return 'check';
  if (SIG_RE.test(nearLabel) || (r.h >= 34 && r.w / r.h < 6 && r.w >= 80 && SIG_RE.test(nearLabel))) return 'sig';
  return 'text';
}
