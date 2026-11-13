// Écriture des PDF avec pdf-lib : export (annotations aplaties), opérations sur les pages, fusion, chiffrement
import {
  PDFDocument, rgb, degrees, BlendMode, LineCapStyle, LineJoinStyle,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, setLineJoin,
  PDFHexString, PDFString, PDFName, PageSizes,
  PDFRef, PDFDict, PDFArray, PDFStream, PDFNumber, PDFPage,
} from '../lib/pdf-lib/pdf-lib.esm.min.js';
import { S } from './state.js';
import {
  FONTS, fontVariant, textLayout, stampLayout, inkPath, arrowHead, symbolPath, symbolStroke,
  roundRectPath, underlineRect, NOTE_SIZE, measure,
} from './geom.js';
import { hexToRgb01, canvasToBlob, normalizeImage, sniffImageMime, loadImage } from './util.js';
import { renderPageToCanvas, pdfjsLib } from './pdfcore.js';
import { pageNumberText, pageNumberPos } from './annotations.js';

export { PageSizes };

const col = (hex) => rgb(...hexToRgb01(hex));

export async function loadLibDoc(bytes, password) {
  const opts = { updateMetadata: false };
  try {
    return await PDFDocument.load(bytes, password != null ? { ...opts, password } : opts);
  } catch (e) {
    if (/encrypt|password/i.test(String(e?.message || e))) {
      return PDFDocument.load(bytes, { ...opts, password: password ?? '' });
    }
    throw e;
  }
}

// ---------- Matrices (convention PDF : [a b c d e f]) ----------
/** Applique m1 puis m2 */
function mul(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1, [a2, b2, c2, d2, e2, f2] = m2;
  return [a1 * a2 + b1 * c2, a1 * b2 + b1 * d2, c1 * a2 + d1 * c2, c1 * b2 + d1 * d2, e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2];
}
function inv(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  return [d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det];
}
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
/** Repère affiché (y vers le bas) -> repère de base (y vers le bas) pour une rotation supplémentaire dr */
function dispToBase(dr, W, H) {
  if (dr === 90) return [0, -1, 1, 0, 0, H];
  if (dr === 180) return [-1, 0, 0, -1, W, H];
  if (dr === 270) return [0, 1, -1, 0, W, 0];
  return [1, 0, 0, 1, 0, 0];
}

// ---------- Polices ----------
const FALLBACK = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '→': '->', '←': '<-', '…': '...', '\t': '    ', ' ': ' ', ' ': ' ', ' ': ' ' };
function makeFontCache(doc) {
  const fonts = new Map();
  const ok = new Map();
  const get = async (name) => {
    if (!fonts.has(name)) fonts.set(name, await doc.embedFont(name));
    return fonts.get(name);
  };
  // Les polices standard ne couvrent que WinAnsi (français OK) : on remplace le reste
  const sanitize = (font, name, text) => {
    let out = '';
    for (const ch of text) {
      const key = name + ch;
      if (!ok.has(key)) {
        try { font.encodeText(ch); ok.set(key, true); } catch { ok.set(key, false); }
      }
      if (ok.get(key)) out += ch;
      else {
        const fb = FALLBACK[ch];
        if (fb) { try { font.encodeText(fb); out += fb; continue; } catch {} }
        out += '?';
      }
    }
    return out;
  };
  return { get, sanitize };
}

// ---------- Dessin d'une annotation ----------
async function drawAnnot(ctx, a) {
  const { page, H, fonts, images, doc } = ctx;
  const op = a.opacity ?? 1;
  switch (a.type) {
    case 'text': {
      const L = textLayout(a);
      const f = FONTS[a.font] || FONTS.helv;
      const name = f.pdf[fontVariant(a)];
      const font = await fonts.get(name);
      if (a.bg) page.drawRectangle({ x: a.x, y: H - a.y - L.h, width: L.w, height: L.h, color: col(a.bg), opacity: op });
      for (const l of L.lines) {
        if (!l.text) continue;
        page.drawText(fonts.sanitize(font, name, l.text), { x: l.x, y: H - l.y, size: a.size, font, color: col(a.color), opacity: op });
      }
      break;
    }
    case 'stamp': {
      const L = stampLayout(a);
      const font = await fonts.get('Helvetica-Bold');
      page.drawSvgPath(roundRectPath(a.x + L.border / 2, a.y + L.border / 2, L.w - L.border, L.h - L.border, L.radius), {
        x: 0, y: H, color: col(a.color), opacity: 0.06 * op, borderColor: col(a.color), borderWidth: L.border, borderOpacity: op,
      });
      page.drawText(fonts.sanitize(font, 'Helvetica-Bold', L.text), { x: L.main.x, y: H - L.main.y, size: L.size, font, color: col(a.color), opacity: op });
      if (L.sub) page.drawText(fonts.sanitize(font, 'Helvetica-Bold', a.sub), { x: L.sub.x, y: H - L.sub.y, size: L.subSize, font, color: col(a.color), opacity: op });
      break;
    }
    case 'ink':
      if (a.points.length) {
        page.drawSvgPath(inkPath(a.points), { x: 0, y: H, borderColor: col(a.color), borderWidth: a.width, borderOpacity: op, borderLineCap: LineCapStyle.Round });
      }
      break;
    case 'rect':
      page.drawRectangle({
        x: a.x, y: H - a.y - a.h, width: a.w, height: a.h,
        color: a.fill ? col(a.fill) : undefined, opacity: op,
        borderColor: a.width > 0 ? col(a.color) : undefined, borderWidth: a.width, borderOpacity: op,
      });
      break;
    case 'ellipse':
      page.drawEllipse({
        x: a.x + a.w / 2, y: H - a.y - a.h / 2, xScale: a.w / 2, yScale: a.h / 2,
        color: a.fill ? col(a.fill) : undefined, opacity: op,
        borderColor: a.width > 0 ? col(a.color) : undefined, borderWidth: a.width, borderOpacity: op,
      });
      break;
    case 'line': case 'arrow': {
      let end = [a.x2, a.y2];
      if (a.type === 'arrow') {
        const h = arrowHead(a);
        end = h.stop;
        page.drawSvgPath(`M${h.tip[0]} ${h.tip[1]} L${h.p1[0]} ${h.p1[1]} L${h.p2[0]} ${h.p2[1]} Z`, {
          x: 0, y: H, color: col(a.color), opacity: op, borderColor: col(a.color), borderWidth: a.width * 0.5, borderOpacity: op,
        });
      }
      page.drawLine({ start: { x: a.x1, y: H - a.y1 }, end: { x: end[0], y: H - end[1] }, thickness: a.width, color: col(a.color), opacity: op, lineCap: LineCapStyle.Round });
      break;
    }
    case 'markup':
      for (const r of a.rects) {
        const rr = a.mode === 'highlight' ? r : underlineRect(r, a.mode);
        page.drawRectangle({
          x: rr.x, y: H - rr.y - rr.h, width: rr.w, height: rr.h, color: col(a.color), opacity: op,
          blendMode: a.mode === 'highlight' ? BlendMode.Multiply : undefined,
        });
      }
      break;
    case 'whiteout':
      page.drawRectangle({ x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, color: col(a.color || '#ffffff') });
      break;
    case 'image': {
      const img = await images(a.imageId);
      if (img) page.drawImage(img, { x: a.x, y: H - a.y - a.h, width: a.w, height: a.h, opacity: op });
      break;
    }
    case 'symbol': {
      const P = symbolPath(a);
      if (P.stroke) page.drawSvgPath(P.d, { x: 0, y: H, borderColor: col(a.color), borderWidth: symbolStroke(a), borderLineCap: LineCapStyle.Round });
      else page.drawSvgPath(P.d, { x: 0, y: H, color: col(a.color) });
      break;
    }
    case 'note': {
      const rect = userRect(ctx, a.x, a.y, NOTE_SIZE, NOTE_SIZE);
      const dict = doc.context.obj({
        Type: 'Annot', Subtype: 'Text', Rect: rect,
        Contents: PDFHexString.fromText(a.text || ''),
        T: PDFHexString.fromText(a.author || 'Formagic'),
        M: PDFString.fromDate(new Date(a.date || Date.now())),
        Name: 'Comment', C: hexToRgb01(a.color), F: 4, Open: false,
      });
      page.node.addAnnot(doc.context.register(dict));
      break;
    }
    case 'link': {
      const rect = userRect(ctx, a.x, a.y, a.w, a.h);
      const d = { Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0], F: 4 };
      if (a.page) {
        const target = doc.getPages()[a.page - 1];
        if (!target) break;
        d.Dest = [target.ref, PDFName.of('Fit')];
      } else if (a.url) {
        d.A = { Type: 'Action', S: 'URI', URI: PDFString.of(a.url) };
      } else break;
      page.node.addAnnot(doc.context.register(doc.context.obj(d)));
      break;
    }
  }
}

/** Rectangle en coordonnées utilisateur PDF pour une boîte en coordonnées de base */
function userRect(ctx, x, y, w, h) {
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([px, py]) => apply(ctx.M, px, ctx.H - py));
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

function beginLayer(page, M, doc) {
  // Isoler le contenu d'origine (q … Q) pour repartir d'un état graphique propre
  try {
    const q = doc.context.register(doc.context.contentStream([pushGraphicsState()]));
    const Q = doc.context.register(doc.context.contentStream([popGraphicsState()]));
    page.node.wrapContentStreams(q, Q);
  } catch {}
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...M), setLineJoin(LineJoinStyle.Round));
}
function endLayer(page) {
  page.pushOperators(popGraphicsState());
}

/**
 * Exporte le document courant : formulaires remplis + annotations aplaties + réglages du document.
 * options : { flattenForms, pagesSubset (indices), noEncrypt, onProgress }
 */
export async function exportPdf(options = {}) {
  const { doc: D } = S;
  let bytes = D.bytes;
  if (D.pdf.annotationStorage?.size > 0) {
    try { bytes = await D.pdf.saveDocument(); } catch (e) { console.warn('saveDocument', e); }
  }
  const doc = await loadLibDoc(bytes, D.password);
  const fonts = makeFontCache(doc);
  const imgCache = new Map();
  const images = async (id) => {
    if (!imgCache.has(id)) {
      const im = S.images.get(id);
      if (!im) { imgCache.set(id, null); return null; }
      const n = await normalizeImage(im.bytes, im.mime);
      imgCache.set(id, n.mime === 'image/png' ? await doc.embedPng(n.bytes) : await doc.embedJpg(n.bytes));
    }
    return imgCache.get(id);
  };
  const ds = S.docSettings;
  const total = S.pages.length;
  const hlFirst = (list) => list.filter((a) => a.type === 'markup').concat(list.filter((a) => a.type !== 'markup'));

  for (let i = 0; i < total; i++) {
    options.onProgress?.(i / total);
    const meta = S.pages[i];
    const list = hlFirst(S.annots.filter((a) => a.pageId === meta.id && a.type !== 'field'));
    const redacts = list.filter((a) => a.type === 'redact');
    const pj = await D.pdf.getPage(i + 1);
    const vp = pj.getViewport({ scale: 1, rotation: meta.baseRot });
    const W = vp.width, Hb = vp.height;
    const dr = (((meta.rot - meta.baseRot) % 360) + 360) % 360;
    let page = doc.getPage(i);
    let baseToUser = inv(vp.transform);

    if (redacts.length) {
      // Caviardage sécurisé : la page devient une image, le texte masqué disparaît réellement
      const scale = 220 / 72;
      const canvas = await renderPageToCanvas(pj, scale, meta.baseRot, { annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE });
      const c2 = canvas.getContext('2d');
      c2.fillStyle = '#000';
      for (const r of redacts) c2.fillRect(r.x * scale, r.y * scale, r.w * scale, r.h * scale);
      const blob = await canvasToBlob(canvas, 'image/jpeg', 0.9);
      const img = await doc.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      const np = doc.insertPage(i, [W, Hb]);
      np.drawImage(img, { x: 0, y: 0, width: W, height: Hb });
      scrubPage(doc, doc.getPage(i + 1)); // le texte caviardé ne doit plus exister nulle part
      doc.removePage(i + 1);
      np.setRotation(degrees(dr));
      page = np;
      baseToUser = [1, 0, 0, -1, 0, Hb];
    }

    const flipB = [1, 0, 0, -1, 0, Hb];
    const M = mul(flipB, baseToUser);
    const drawable = list.filter((a) => a.type !== 'redact');
    const wm = ds.watermark?.text ? ds.watermark : null;
    const pn = ds.pageNumbers && !(ds.pageNumbers.skipFirst && i === 0) ? ds.pageNumbers : null;
    if (!drawable.length && !wm && !pn) continue;

    beginLayer(page, M, doc);
    const ctx = { page, H: Hb, fonts, images, doc, M };
    for (const a of drawable) {
      try { await drawAnnot(ctx, a); } catch (e) { console.warn('Annotation non exportée', a, e); }
    }
    endLayer(page);

    if (wm || pn) {
      const Wd = dr % 180 ? Hb : W, Hd = dr % 180 ? W : Hb;
      const Md = mul([1, 0, 0, -1, 0, Hd], mul(dispToBase(dr, W, Hb), baseToUser));
      page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...Md));
      if (wm) {
        const font = await fonts.get('Helvetica-Bold');
        const txt = fonts.sanitize(font, 'Helvetica-Bold', wm.text);
        const tw = font.widthOfTextAtSize(txt, wm.size);
        const t = (wm.angle * Math.PI) / 180, s = wm.size;
        const ox = Math.cos(t) * (-tw / 2) - Math.sin(t) * (-0.32 * s);
        const oy = Math.sin(t) * (-tw / 2) + Math.cos(t) * (-0.32 * s);
        page.drawText(txt, { x: Wd / 2 + ox, y: Hd / 2 + oy, size: s, font, color: col(wm.color), opacity: wm.opacity, rotate: degrees(wm.angle) });
      }
      if (pn) {
        const font = await fonts.get('Helvetica');
        const txt = pageNumberText(pn, i, total);
        const pos = pageNumberPos(pn, Wd, Hd, txt);
        page.drawText(fonts.sanitize(font, 'Helvetica', txt), { x: pos.x, y: Hd - pos.y, size: pn.size, font, color: col(pn.color) });
      }
      page.pushOperators(popGraphicsState());
    }
  }

  if (options.flattenForms) {
    try { doc.getForm().flatten(); } catch (e) { console.warn('Aplatissement des formulaires', e); }
  }

  const m = ds.meta;
  if (m) {
    if (m.title != null) doc.setTitle(m.title);
    if (m.author != null) doc.setAuthor(m.author);
    if (m.subject != null) doc.setSubject(m.subject);
    if (m.keywords != null) doc.setKeywords(m.keywords.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
  }
  doc.setProducer('Formagic');
  doc.setModificationDate(new Date());

  if (!options.pagesSubset) collectGarbage(doc);
  let out = doc;
  if (options.pagesSubset) {
    out = await PDFDocument.create();
    const pages = await out.copyPages(doc, options.pagesSubset);
    pages.forEach((p) => out.addPage(p));
  }
  const pr = ds.protect;
  if (pr && !options.noEncrypt && (pr.userPassword || pr.ownerPassword)) {
    out.encrypt({
      userPassword: pr.userPassword || '',
      ownerPassword: pr.ownerPassword || pr.userPassword || cryptoRandom(),
      permissions: {
        printing: pr.noPrint ? undefined : 'highResolution',
        modifying: !pr.noModify,
        copying: !pr.noCopy,
        annotating: !pr.noModify,
        fillingForms: true,
        contentAccessibility: true,
        documentAssembly: !pr.noModify,
      },
    });
  }
  options.onProgress?.(1);
  return out.save({ addDefaultPage: false });
}
function cryptoRandom() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reconstruit le document selon un plan de pages.
 * plan : [{ src: 'self', index, rot } | { src: 'ext', doc: n, index, rot } | { blank: [w, h], rot }]
 * `rot` = rotation /Rotate finale (en degrés)
 */
export async function rebuildPages(bytes, password, plan, extBytes = []) {
  const doc = await loadLibDoc(bytes, password);
  const ext = [];
  for (const b of extBytes) ext.push(await loadLibDoc(b, null));
  const orig = doc.getPages();
  const identity = plan.length === orig.length && plan.every((p, i) => p.src === 'self' && p.index === i);
  if (identity) {
    plan.forEach((p, i) => orig[i].setRotation(degrees(p.rot)));
    return doc.save({ addDefaultPage: false, useObjectStreams: false });
  }
  // 1. Construire la liste finale des pages (avant de toucher à l'arbre)
  const used = new Set();
  const finalPages = [];
  for (const p of plan) {
    let pg;
    if (p.src === 'self') {
      if (used.has(p.index)) [pg] = await doc.copyPages(doc, [p.index]);
      else { used.add(p.index); pg = orig[p.index]; materializeInherited(pg); }
    } else if (p.src === 'ext') {
      [pg] = await doc.copyPages(ext[p.doc], [p.index]);
    } else {
      pg = PDFPage.create(doc);
      const [w, h] = p.blank || PageSizes.A4;
      pg.setSize(w, h);
    }
    pg.setRotation(degrees(p.rot || 0));
    finalPages.push(pg);
  }
  // 2. Pages abandonnées : vider leur contenu (elles peuvent rester référencées par un signet)
  orig.forEach((pg, i) => { if (!used.has(i)) scrubPage(doc, pg); });
  // 3. Arbre des pages à plat
  setPageList(doc, finalPages);
  collectGarbage(doc);
  return doc.save({ addDefaultPage: false, useObjectStreams: false });
}

const INHERITABLE = ['Resources', 'MediaBox', 'CropBox', 'Rotate'];
function materializeInherited(page) {
  const node = page.node;
  for (const k of INHERITABLE) {
    const n = PDFName.of(k);
    if (node.get(n) === undefined) {
      const v = node.getInheritableAttribute(n);
      if (v !== undefined) node.set(n, v);
    }
  }
}
function scrubPage(doc, page) {
  const node = page.node;
  node.delete(PDFName.of('Contents'));
  node.delete(PDFName.of('Annots'));
  node.delete(PDFName.of('Thumb'));
  node.set(PDFName.of('Resources'), doc.context.obj({}));
}
/** Remplace l'arbre des pages par une liste plate */
function setPageList(doc, pages) {
  const ctx = doc.context;
  const pagesRef = doc.catalog.get(PDFName.of('Pages'));
  const root = ctx.lookup(pagesRef, PDFDict);
  for (const pg of pages) pg.node.set(PDFName.of('Parent'), pagesRef);
  root.set(PDFName.of('Kids'), ctx.obj(pages.map((pg) => pg.ref)));
  root.set(PDFName.of('Count'), PDFNumber.of(pages.length));
  doc.pageCount = pages.length;
  doc.pageCache.invalidate();
}
/**
 * Supprime les objets inaccessibles depuis le trailer : pdf-lib ne le fait pas, si bien qu'une page supprimée
 * ou le contenu d'origine d'une page caviardée resterait sinon dans le fichier.
 */
export function collectGarbage(doc) {
  const ctx = doc.context;
  const seen = new Set();
  const stack = [];
  const ti = ctx.trailerInfo || {};
  for (const k of ['Root', 'Info', 'Encrypt']) if (ti[k]) stack.push(ti[k]);
  while (stack.length) {
    const o = stack.pop();
    if (!o) continue;
    if (o instanceof PDFRef) {
      if (seen.has(o)) continue;
      seen.add(o);
      stack.push(ctx.lookup(o));
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream) {
      stack.push(o.dict);
    }
  }
  let removed = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref)) { ctx.delete(ref); removed++; }
  }
  return removed;
}

/** Rotation intrinsèque (/Rotate) des pages d'un PDF externe */
export async function pageRotations(bytes) {
  const d = await loadLibDoc(bytes, null);
  return d.getPages().map((p) => p.getRotation().angle);
}

/** Rogne une page : rect en coordonnées de base -> CropBox */
export async function cropPage(bytes, password, index, rectUser) {
  const doc = await loadLibDoc(bytes, password);
  const page = doc.getPage(index);
  const [x0, y0, x1, y1] = rectUser;
  page.setCropBox(x0, y0, x1 - x0, y1 - y0);
  return doc.save({ addDefaultPage: false, useObjectStreams: false });
}
export function baseRectToUser(vp, r) {
  const pts = [[r.x, r.y], [r.x + r.w, r.y + r.h]].map(([x, y]) => vp.convertToPdfPoint(x, y));
  return [Math.min(pts[0][0], pts[1][0]), Math.min(pts[0][1], pts[1][1]), Math.max(pts[0][0], pts[1][0]), Math.max(pts[0][1], pts[1][1])];
}

export async function createBlankPdf(size = PageSizes.A4, count = 1) {
  const doc = await PDFDocument.create();
  for (let i = 0; i < count; i++) doc.addPage(size);
  doc.setProducer('Formagic');
  return doc.save();
}

/** Crée un PDF à partir d'images (une page par image) */
export async function imagesToPdf(files, { fit = 'image' } = {}) {
  const doc = await PDFDocument.create();
  for (const f of files) {
    const raw = f.bytes;
    const n = await normalizeImage(raw, f.mime || sniffImageMime(raw));
    const img = n.mime === 'image/png' ? await doc.embedPng(n.bytes) : await doc.embedJpg(n.bytes);
    let w = img.width * 0.75, h = img.height * 0.75; // 96 dpi
    if (fit === 'a4' || w > 842 * 1.5 || h > 842 * 1.5) {
      const [aw, ah] = w > h ? [842, 595] : [595, 842];
      const s = Math.min(aw / w, ah / h);
      const page = doc.addPage([aw, ah]);
      page.drawImage(img, { x: (aw - w * s) / 2, y: (ah - h * s) / 2, width: w * s, height: h * s });
      continue;
    }
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  doc.setProducer('Formagic');
  return doc.save();
}

/** Insère une image comme page (bytes du document courant) */
export async function imagePageBytes(file) {
  return imagesToPdf([file], { fit: 'a4' });
}

/** Découpe des octets PDF en plusieurs documents. groups = [[indices], …] */
export async function splitPdf(bytes, groups) {
  const src = await loadLibDoc(bytes, null);
  const outs = [];
  for (const g of groups) {
    const d = await PDFDocument.create();
    const pages = await d.copyPages(src, g);
    pages.forEach((p) => d.addPage(p));
    outs.push(await d.save());
  }
  return outs;
}

export { measure, loadImage };
