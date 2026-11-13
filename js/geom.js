// Géométrie et mise en page des annotations — partagée par l'affichage (SVG) et l'export (pdf-lib)
// pour garantir que le PDF enregistré correspond exactement à l'écran.
// Unités : points PDF, origine en haut à gauche de la page « de base » (y vers le bas).

export const FONTS = {
  helv: {
    label: 'Sans (Helvetica)',
    css: 'Arial, Helvetica, "Liberation Sans", sans-serif',
    asc: 0.905, desc: 0.212,
    pdf: { r: 'Helvetica', b: 'Helvetica-Bold', i: 'Helvetica-Oblique', bi: 'Helvetica-BoldOblique' },
  },
  times: {
    label: 'Serif (Times)',
    css: '"Times New Roman", Times, "Liberation Serif", serif',
    asc: 0.891, desc: 0.216,
    pdf: { r: 'Times-Roman', b: 'Times-Bold', i: 'Times-Italic', bi: 'Times-BoldItalic' },
  },
  courier: {
    label: 'Mono (Courier)',
    css: '"Courier New", Courier, "Liberation Mono", monospace',
    asc: 0.833, desc: 0.300,
    pdf: { r: 'Courier', b: 'Courier-Bold', i: 'Courier-Oblique', bi: 'Courier-BoldOblique' },
  },
};

export const TEXT_PAD = 2;
export const NOTE_SIZE = 20;

export function fontVariant(a) {
  return a.bold ? (a.italic ? 'bi' : 'b') : (a.italic ? 'i' : 'r');
}
export function cssFont(a, size = a.size) {
  const f = FONTS[a.font] || FONTS.helv;
  return `${a.italic ? 'italic ' : ''}${a.bold ? 'bold ' : ''}${size}px ${f.css}`;
}

let mctx = null;
export function measure(text, fontCss) {
  mctx ||= document.createElement('canvas').getContext('2d');
  mctx.font = fontCss;
  return mctx.measureText(text).width;
}

/** Disposition d'un bloc de texte : lignes avec position x et ligne de base. */
export function textLayout(a) {
  const f = FONTS[a.font] || FONTS.helv;
  const size = a.size || 12;
  const lh = (a.lh || 1.2) * size;
  const lines = String(a.text ?? '').split('\n');
  const font = cssFont({ ...a, size: 100 });
  const widths = lines.map((l) => (measure(l, font) * size) / 100);
  const innerW = Math.max(4, ...widths);
  const w = innerW + TEXT_PAD * 2;
  const h = lines.length * lh + TEXT_PAD * 2;
  const baseOff = (lh - (f.asc + f.desc) * size) / 2 + f.asc * size;
  const out = lines.map((text, i) => {
    let dx = 0;
    if (a.align === 'center') dx = (innerW - widths[i]) / 2;
    else if (a.align === 'right') dx = innerW - widths[i];
    return { text, x: a.x + TEXT_PAD + dx, y: a.y + TEXT_PAD + i * lh + baseOff, width: widths[i] };
  });
  return { lines: out, w, h, lh, baseOff };
}

/** Disposition d'un tampon (cadre arrondi + texte en gras + sous-texte optionnel). */
export function stampLayout(a) {
  const size = a.size || 18;
  const padX = size * 0.45, padY = size * 0.28;
  const fMain = `bold 100px ${FONTS.helv.css}`;
  const fSub = `bold 100px ${FONTS.helv.css}`;
  const text = String(a.text || '').toUpperCase();
  const tw = (measure(text, fMain) * size) / 100;
  const subSize = size * 0.45;
  const sw = a.sub ? (measure(a.sub, fSub) * subSize) / 100 : 0;
  const innerW = Math.max(tw, sw);
  const w = innerW + padX * 2;
  const h = padY * 2 + size + (a.sub ? size * 0.6 : 0);
  return {
    w, h, size, subSize, text,
    border: Math.max(1, size * 0.11),
    radius: size * 0.28,
    main: { x: a.x + padX + (innerW - tw) / 2, y: a.y + padY + size * 0.86, width: tw },
    sub: a.sub ? { x: a.x + padX + (innerW - sw) / 2, y: a.y + padY + size * 0.86 + size * 0.62, width: sw } : null,
  };
}

/** Recalcule w/h pour les types dont la taille dépend du contenu. */
export function normalize(a) {
  if (a.type === 'text') { const l = textLayout(a); a.w = l.w; a.h = l.h; }
  else if (a.type === 'stamp') { const l = stampLayout(a); a.w = l.w; a.h = l.h; }
  else if (a.type === 'note') { a.w = NOTE_SIZE; a.h = NOTE_SIZE; }
  return a;
}

export function bbox(a) {
  switch (a.type) {
    case 'line': case 'arrow': {
      const x = Math.min(a.x1, a.x2), y = Math.min(a.y1, a.y2);
      return { x, y, w: Math.abs(a.x2 - a.x1), h: Math.abs(a.y2 - a.y1) };
    }
    case 'ink': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of a.points) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
      const r = (a.width || 1) / 2;
      return { x: x0 - r, y: y0 - r, w: x1 - x0 + 2 * r, h: y1 - y0 + 2 * r };
    }
    case 'markup': {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of a.rects) { x0 = Math.min(x0, r.x); y0 = Math.min(y0, r.y); x1 = Math.max(x1, r.x + r.w); y1 = Math.max(y1, r.y + r.h); }
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    case 'note':
      return { x: a.x, y: a.y, w: NOTE_SIZE, h: NOTE_SIZE };
    default:
      return { x: a.x, y: a.y, w: a.w || 0, h: a.h || 0 };
  }
}

/** Applique la transformation qui envoie la boîte `from` sur la boîte `to`. Modifie `a`. */
export function transformAnnot(a, from, to) {
  const sx = from.w ? to.w / from.w : 1;
  const sy = from.h ? to.h / from.h : 1;
  const mx = (x) => to.x + (x - from.x) * sx;
  const my = (y) => to.y + (y - from.y) * sy;
  switch (a.type) {
    case 'line': case 'arrow':
      a.x1 = mx(a.x1); a.y1 = my(a.y1); a.x2 = mx(a.x2); a.y2 = my(a.y2);
      break;
    case 'ink': {
      // garder la marge de l'épaisseur du trait hors de l'échelle
      const r = (a.width || 1) / 2;
      const f2 = { x: from.x + r, y: from.y + r, w: Math.max(0.01, from.w - 2 * r), h: Math.max(0.01, from.h - 2 * r) };
      const t2 = { x: to.x + r, y: to.y + r, w: Math.max(0.01, to.w - 2 * r), h: Math.max(0.01, to.h - 2 * r) };
      const ssx = t2.w / f2.w, ssy = t2.h / f2.h;
      a.points = a.points.map(([x, y, p]) => [t2.x + (x - f2.x) * ssx, t2.y + (y - f2.y) * ssy, p]);
      break;
    }
    case 'markup':
      a.rects = a.rects.map((r) => ({ x: mx(r.x), y: my(r.y), w: r.w * sx, h: r.h * sy }));
      break;
    case 'text': case 'stamp':
      a.x = to.x; a.y = to.y;
      if (Math.abs(sy - 1) > 1e-6) a.size = Math.max(3, Math.min(400, (a.size || 12) * sy));
      normalize(a);
      break;
    case 'note':
      a.x = to.x; a.y = to.y;
      break;
    default:
      a.x = to.x; a.y = to.y; a.w = to.w; a.h = to.h;
  }
  return a;
}

export function translateAnnot(a, dx, dy) {
  const b = bbox(a);
  return transformAnnot(a, b, { x: b.x + dx, y: b.y + dy, w: b.w, h: b.h });
}

/** Chemin lissé (courbes quadratiques entre points médians) */
export function inkPath(points) {
  const n = points.length;
  if (!n) return '';
  const f = (v) => +v.toFixed(2);
  if (n === 1) {
    const [x, y] = points[0];
    return `M${f(x)} ${f(y)} L${f(x + 0.01)} ${f(y + 0.01)}`;
  }
  if (n === 2) return `M${f(points[0][0])} ${f(points[0][1])} L${f(points[1][0])} ${f(points[1][1])}`;
  let d = `M${f(points[0][0])} ${f(points[0][1])}`;
  for (let i = 1; i < n - 1; i++) {
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    d += ` Q${f(x)} ${f(y)} ${f((x + nx) / 2)} ${f((y + ny) / 2)}`;
  }
  const [lx, ly] = points[n - 1];
  d += ` L${f(lx)} ${f(ly)}`;
  return d;
}

/** Simplification Ramer–Douglas–Peucker pour alléger les tracés */
export function simplify(points, eps = 0.35) {
  if (points.length < 3) return points;
  const sq = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;
  const segDist = (p, a, b) => {
    const l2 = sq(a, b);
    if (!l2) return sq(p, a);
    let t = ((p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1])) / l2;
    t = Math.max(0, Math.min(1, t));
    return sq(p, [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
  };
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const e2 = eps * eps;
  while (stack.length) {
    const [s, e] = stack.pop();
    let max = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = segDist(points[i], points[s], points[e]);
      if (d > max) { max = d; idx = i; }
    }
    if (max > e2 && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Pointe de flèche : renvoie le triangle et le point où arrêter la ligne */
export function arrowHead(a) {
  const w = a.width || 2;
  const len = Math.max(8, w * 4.2);
  const ang = Math.atan2(a.y2 - a.y1, a.x2 - a.x1);
  const spread = Math.PI / 7;
  const p1 = [a.x2 - len * Math.cos(ang - spread), a.y2 - len * Math.sin(ang - spread)];
  const p2 = [a.x2 - len * Math.cos(ang + spread), a.y2 - len * Math.sin(ang + spread)];
  const back = len * Math.cos(spread) * 0.8;
  const stop = [a.x2 - back * Math.cos(ang), a.y2 - back * Math.sin(ang)];
  return { tip: [a.x2, a.y2], p1, p2, stop };
}

/** Chemin des symboles (coche, croix, point) dans leur boîte */
export function symbolPath(a) {
  const { x, y, w, h } = a;
  const P = (u, v) => `${(x + u * w).toFixed(2)} ${(y + v * h).toFixed(2)}`;
  if (a.kind === 'check') return { d: `M${P(0.12, 0.55)} L${P(0.4, 0.84)} L${P(0.9, 0.16)}`, stroke: true };
  if (a.kind === 'cross') return { d: `M${P(0.16, 0.16)} L${P(0.84, 0.84)} M${P(0.84, 0.16)} L${P(0.16, 0.84)}`, stroke: true };
  // point : cercle via deux arcs
  const rx = w * 0.3, ry = h * 0.3, cx = x + w / 2, cy = y + h / 2;
  return { d: `M${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`, stroke: false };
}
export const symbolStroke = (a) => Math.max(0.8, Math.min(a.w, a.h) * 0.13);

export function roundRectPath(x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  return `M${x + r} ${y} H${x + w - r} A${r} ${r} 0 0 1 ${x + w} ${y + r} V${y + h - r} A${r} ${r} 0 0 1 ${x + w - r} ${y + h} H${x + r} A${r} ${r} 0 0 1 ${x} ${y + h - r} V${y + r} A${r} ${r} 0 0 1 ${x + r} ${y} Z`;
}

export function underlineRect(r, mode) {
  const t = Math.max(0.6, r.h * 0.075);
  if (mode === 'underline') return { x: r.x, y: r.y + r.h - t * 1.2, w: r.w, h: t };
  return { x: r.x, y: r.y + r.h * 0.52 - t / 2, w: r.w, h: t };
}

export const TYPE_LABELS = {
  text: 'Texte', stamp: 'Tampon', ink: 'Dessin', rect: 'Rectangle', ellipse: 'Ellipse', line: 'Ligne',
  arrow: 'Flèche', markup: 'Surlignage', whiteout: 'Masque', redact: 'Caviardage', image: 'Image',
  symbol: 'Symbole', note: 'Commentaire', link: 'Lien',
};
export const TYPE_ICONS = {
  text: 'text', stamp: 'stamp', ink: 'pen', rect: 'rect', ellipse: 'ellipse', line: 'line', arrow: 'arrow',
  markup: 'highlight', whiteout: 'whiteout', redact: 'redact', image: 'image', symbol: 'check', note: 'note', link: 'link',
};
