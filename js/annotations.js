// Couche d'édition : rendu SVG des annotations au-dessus des pages PDF.js et interactions (outils)
import { S, emit, checkpoint, dropCheckpoint, getAnnot, markDirty } from './state.js';
import {
  FONTS, textLayout, stampLayout, normalize, bbox, transformAnnot, translateAnnot, inkPath, simplify,
  arrowHead, symbolPath, symbolStroke, roundRectPath, underlineRect, NOTE_SIZE, cssFont, TEXT_PAD, measure,
} from './geom.js';
import { uid, clamp, getSettings, formatDate, escapeHtml, openMenu, rgbToHex } from './util.js';
import { renderPageToCanvas } from './pdfcore.js';
import { guessKind, overlapRatio } from './formdetect.js';

const esc = escapeHtml;
const f2 = (v) => +(+v).toFixed(2);

// Outils
export const DRAW_TOOLS = new Set(['field', 'ink', 'eraser', 'rect', 'ellipse', 'line', 'arrow', 'whiteout', 'redact', 'link', 'crop', 'note', 'text', 'check', 'cross', 'dot', 'date', 'stamp', 'signature', 'image']);
export const MARKUP_TOOLS = new Set(['highlight', 'underline', 'strike']);
const SHAPE_TOOLS = new Set(['field', 'rect', 'ellipse', 'line', 'arrow', 'whiteout', 'redact', 'link', 'crop']);
const PLACE_TOOLS = new Set(['check', 'cross', 'dot', 'date', 'stamp', 'signature', 'image']);

// ---------- Propriétés par défaut des outils ----------
const DEFAULT_PROPS = {
  text: { font: 'helv', size: 14, color: '#000000', bold: false, italic: false, align: 'left', bg: null, opacity: 1 },
  highlight: { color: '#ffe14d', opacity: 1 },
  underline: { color: '#1a56db', opacity: 1 },
  strike: { color: '#e5484d', opacity: 1 },
  ink: { color: '#e5484d', width: 2, opacity: 1 },
  rect: { color: '#e5484d', width: 2, fill: null, opacity: 1 },
  ellipse: { color: '#e5484d', width: 2, fill: null, opacity: 1 },
  line: { color: '#e5484d', width: 2, opacity: 1 },
  arrow: { color: '#e5484d', width: 2, opacity: 1 },
  whiteout: { color: '#ffffff' },
  symbol: { color: '#1a56db', size: 14 },
  note: { color: '#ffc83d' },
  stamp: { opacity: 0.9 },
  image: { opacity: 1 },
  field: { mark: 'check' },
};
function loadToolProps() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem('pa-toolprops') || '{}'); } catch {}
  const out = {};
  for (const [k, v] of Object.entries(DEFAULT_PROPS)) out[k] = { ...v, ...(saved[k] || {}) };
  return out;
}
export const toolProps = loadToolProps();
export function saveToolProps() {
  try { localStorage.setItem('pa-toolprops', JSON.stringify(toolProps)); } catch {}
}
/** Clé de propriétés correspondant à un outil ou à un type d'annotation */
export function propsKeyFor(toolOrType, a) {
  if (a) {
    if (a.type === 'markup') return a.mode;
    if (a.type === 'symbol') return 'symbol';
    return a.type;
  }
  if (['check', 'cross', 'dot'].includes(toolOrType)) return 'symbol';
  if (toolOrType === 'edittext' || toolOrType === 'date') return 'text';
  if (toolOrType === 'signature') return 'image';
  return toolOrType;
}
/** Propriétés modifiables par type */
export const TYPE_PROPS = {
  text: ['font', 'size', 'bold', 'italic', 'align', 'color', 'bg', 'opacity'],
  stamp: ['color', 'opacity'],
  ink: ['color', 'width', 'opacity'],
  rect: ['color', 'width', 'fill', 'opacity'],
  ellipse: ['color', 'width', 'fill', 'opacity'],
  line: ['color', 'width', 'opacity'],
  arrow: ['color', 'width', 'opacity'],
  highlight: ['color', 'opacity'],
  underline: ['color', 'opacity'],
  strike: ['color', 'opacity'],
  whiteout: ['color'],
  symbol: ['color', 'size'],
  note: ['color'],
  image: ['opacity'],
  field: [],
};

// ---------- État interne ----------
const overlays = new Map();   // pageId -> overlay
const geomCache = new Map();  // pageId -> { baseW, baseH, vp, pdfPage }
let container, viewerDiv;
let drag = null;
let editing = null;            // { id, isNew, cp, el }
let placing = null;            // { template, repeat }
let clipboard = [];
let liveCp = false;
let notePop = null;

export function init(containerEl, viewerEl) {
  container = containerEl;
  viewerDiv = viewerEl;
  const bus = S.eventBus;
  bus.on('pagerender', ({ source }) => ensureOverlay(source));
  bus.on('pagerendered', ({ source }) => ensureOverlay(source));
  bus.on('pagesloaded', () => attachAll());
  bus.on('pagesinit', () => attachAll());

  // PDF.js vide les pages lors du zoom/recyclage : on raccroche immédiatement notre couche
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.removedNodes) {
        if (n.classList?.contains('pa-host') && m.target.isConnected && !n.isConnected && overlays.get(n.dataset.pageId)?.div === m.target) {
          m.target.append(n);
        }
      }
    }
  }).observe(viewerDiv, { childList: true, subtree: true });

  container.addEventListener('pointerdown', onPointerDown, true);
  container.addEventListener('pointermove', onHover);
  container.addEventListener('pointerleave', () => clearGhosts());
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  container.addEventListener('dblclick', onDblClick, true);
  container.addEventListener('contextmenu', onContextMenu);
  document.addEventListener('pointerup', onSelectionPointerUp);
}

export function resetForNewDocument() {
  for (const o of overlays.values()) o.host.remove();
  overlays.clear();
  geomCache.clear();
  textRunsCache.clear();
  sampleCache.clear();
  scanCache.clear();
  ocrCache.clear();
  ocrDone.clear();
  S.selection.clear();
  closeEditor(false);
  closeNotePop();
  drag = null;
}

function attachAll() {
  const v = S.viewer;
  if (!v) return;
  for (let i = 0; i < v.pagesCount; i++) {
    const pv = v.getPageView(i);
    if (pv?.pdfPage) ensureOverlay(pv);
  }
}

export function pageGeom(pageId) { return geomCache.get(pageId); }

/** Géométrie d'une page (calculée à la demande si la page n'est pas encore affichée). */
export async function ensurePageGeom(pageId) {
  let g = geomCache.get(pageId);
  if (g) return g;
  const idx = S.pages.findIndex((p) => p.id === pageId);
  if (idx < 0) return null;
  const pdfPage = await S.doc.pdf.getPage(idx + 1);
  const meta = S.pages[idx];
  const vp = pdfPage.getViewport({ scale: 1, rotation: meta.baseRot });
  g = { baseW: vp.width, baseH: vp.height, vp, pdfPage };
  geomCache.set(pageId, g);
  return g;
}

function ensureOverlay(pageView) {
  const meta = S.pages[pageView.id - 1];
  if (!meta || !pageView.pdfPage) return null;
  let g = geomCache.get(meta.id);
  if (!g || g.pdfPage !== pageView.pdfPage) {
    const vp = pageView.pdfPage.getViewport({ scale: 1, rotation: meta.baseRot });
    g = { baseW: vp.width, baseH: vp.height, vp, pdfPage: pageView.pdfPage };
    geomCache.set(meta.id, g);
  }
  let o = overlays.get(meta.id);
  if (o && o.div === pageView.div) {
    if (!o.host.isConnected || o.host.parentNode !== pageView.div) pageView.div.append(o.host);
    applyTransform(o, meta, g);
    return o;
  }
  o?.host.remove();
  const host = document.createElement('div');
  host.className = 'pa-host';
  host.dataset.pageId = meta.id;
  const mk = (cls, withSvg) => {
    const r = document.createElement('div');
    r.className = 'pa-root ' + cls;
    if (withSvg) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      r.append(svg);
    }
    host.append(r);
    return r;
  };
  o = { host, div: pageView.div, pageId: meta.id, hl: mk('pa-hl', true), main: mk('pa-main', true), ui: mk('pa-ui', false) };
  o.hlSvg = o.hl.firstChild;
  o.mainSvg = o.main.firstChild;
  overlays.set(meta.id, o);
  pageView.div.append(host);
  applyTransform(o, meta, g);
  renderOverlay(meta.id);
  return o;
}

function rotDelta(meta) { return (((meta.rot - meta.baseRot) % 360) + 360) % 360; }

function applyTransform(o, meta, g) {
  const dr = rotDelta(meta);
  const k = 'var(--scale-factor)';
  let tf = `scale(${k})`;
  if (dr === 90) tf = `translateX(calc(${k} * ${g.baseH}px)) rotate(90deg) scale(${k})`;
  else if (dr === 180) tf = `translate(calc(${k} * ${g.baseW}px), calc(${k} * ${g.baseH}px)) rotate(180deg) scale(${k})`;
  else if (dr === 270) tf = `translateY(calc(${k} * ${g.baseW}px)) rotate(270deg) scale(${k})`;
  const key = `${dr}|${g.baseW}|${g.baseH}`;
  if (o.tfKey === key) return;
  o.tfKey = key;
  for (const r of [o.hl, o.main, o.ui]) {
    r.style.width = g.baseW + 'px';
    r.style.height = g.baseH + 'px';
    r.style.transform = tf;
  }
  for (const svg of [o.hlSvg, o.mainSvg]) {
    svg.setAttribute('width', g.baseW);
    svg.setAttribute('height', g.baseH);
    svg.setAttribute('viewBox', `0 0 ${g.baseW} ${g.baseH}`);
  }
}

/** Contexte de page à partir d'un élément ou de coordonnées écran */
function pageCtxFromPoint(target, clientX, clientY) {
  let pageDiv = target?.closest?.('.page');
  if (!pageDiv || !viewerDiv.contains(pageDiv)) {
    const el = document.elementFromPoint(clientX, clientY);
    pageDiv = el?.closest?.('.page');
  }
  if (!pageDiv || !viewerDiv.contains(pageDiv)) return null;
  const n = Number(pageDiv.dataset.pageNumber);
  const pv = S.viewer.getPageView(n - 1);
  if (!pv) return null;
  const o = ensureOverlay(pv);
  if (!o) return null;
  const meta = S.pages[n - 1];
  return { meta, o, g: geomCache.get(meta.id), index: n - 1 };
}
function pageCtxById(pageId) {
  const o = overlays.get(pageId);
  if (!o) return null;
  const index = S.pages.findIndex((p) => p.id === pageId);
  return { meta: S.pages[index], o, g: geomCache.get(pageId), index };
}

/** Coordonnées écran -> coordonnées de base de la page (points) */
export function toBase(pc, clientX, clientY, clampToPage = false) {
  const r = pc.o.host.getBoundingClientRect();
  const { baseW, baseH } = pc.g;
  const dr = rotDelta(pc.meta);
  const k = r.width / (dr % 180 ? baseH : baseW);
  const cx = (clientX - r.left) / k, cy = (clientY - r.top) / k;
  let x, y;
  if (dr === 0) { x = cx; y = cy; }
  else if (dr === 90) { x = cy; y = baseH - cx; }
  else if (dr === 180) { x = baseW - cx; y = baseH - cy; }
  else { x = baseW - cy; y = cx; }
  if (clampToPage) { x = clamp(x, 0, baseW); y = clamp(y, 0, baseH); }
  return { x, y, k };
}

// ---------- Rendu ----------
function annotSvg(a, extraCls = '') {
  const op = a.opacity ?? 1;
  const hide = editing?.id === a.id ? ' style="visibility:hidden"' : '';
  const g = (cls, inner) => `<g data-aid="${a.id}" class="${cls} t-${a.type} ${extraCls}" opacity="${op}"${hide}>${inner}</g>`;
  const hitW = (w) => Math.max((w || 1) + 6, 8);
  switch (a.type) {
    case 'text': {
      const L = textLayout(a);
      const f = FONTS[a.font] || FONTS.helv;
      const bg = a.bg ? `<rect x="${f2(a.x)}" y="${f2(a.y)}" width="${f2(L.w)}" height="${f2(L.h)}" fill="${a.bg}"/>` : '';
      const spans = L.lines.map((l) => `<tspan x="${f2(l.x)}" y="${f2(l.y)}">${esc(l.text)}</tspan>`).join('');
      return g('fillhit', `<rect x="${f2(a.x)}" y="${f2(a.y)}" width="${f2(L.w)}" height="${f2(L.h)}" fill="transparent"/>${bg}` +
        `<text font-family='${f.css}' font-size="${a.size}" font-weight="${a.bold ? 700 : 400}" font-style="${a.italic ? 'italic' : 'normal'}" fill="${a.color}" style="white-space:pre">${spans}</text>`);
    }
    case 'stamp': {
      const L = stampLayout(a);
      const path = roundRectPath(a.x + L.border / 2, a.y + L.border / 2, L.w - L.border, L.h - L.border, L.radius);
      const ff = FONTS.helv.css;
      return g('fillhit', `<path d="${path}" fill="${a.color}" fill-opacity="0.06" stroke="${a.color}" stroke-width="${f2(L.border)}"/>` +
        `<text font-family='${ff}' font-weight="700" font-size="${f2(L.size)}" fill="${a.color}" x="${f2(L.main.x)}" y="${f2(L.main.y)}" style="white-space:pre">${esc(L.text)}</text>` +
        (L.sub ? `<text font-family='${ff}' font-weight="700" font-size="${f2(L.subSize)}" fill="${a.color}" x="${f2(L.sub.x)}" y="${f2(L.sub.y)}" style="white-space:pre">${esc(a.sub)}</text>` : ''));
    }
    case 'ink': {
      const d = inkPath(a.points);
      return g('', `<path class="hit" d="${d}" fill="none" stroke="transparent" stroke-width="${hitW(a.width)}" stroke-linecap="round" stroke-linejoin="round"/>` +
        `<path d="${d}" fill="none" stroke="${a.color}" stroke-width="${a.width}" stroke-linecap="round" stroke-linejoin="round"/>`);
    }
    case 'rect': case 'ellipse': {
      const fill = a.fill || 'none';
      const shape = a.type === 'rect'
        ? (attrs) => `<rect x="${f2(a.x)}" y="${f2(a.y)}" width="${f2(a.w)}" height="${f2(a.h)}" ${attrs}/>`
        : (attrs) => `<ellipse cx="${f2(a.x + a.w / 2)}" cy="${f2(a.y + a.h / 2)}" rx="${f2(a.w / 2)}" ry="${f2(a.h / 2)}" ${attrs}/>`;
      const hit = a.fill ? '' : shape(`class="hit" fill="none" stroke="transparent" stroke-width="${hitW(a.width)}"`);
      return g(a.fill ? 'fillhit' : '', hit + shape(`fill="${fill}" stroke="${a.width > 0 ? a.color : 'none'}" stroke-width="${a.width}"`));
    }
    case 'line': case 'arrow': {
      let end = [a.x2, a.y2], head = '';
      if (a.type === 'arrow') {
        const H = arrowHead(a);
        end = H.stop;
        head = `<path d="M${f2(H.tip[0])} ${f2(H.tip[1])} L${f2(H.p1[0])} ${f2(H.p1[1])} L${f2(H.p2[0])} ${f2(H.p2[1])} Z" fill="${a.color}" stroke="${a.color}" stroke-width="${f2(a.width * 0.5)}" stroke-linejoin="round"/>`;
      }
      return g('', `<line class="hit" x1="${f2(a.x1)}" y1="${f2(a.y1)}" x2="${f2(a.x2)}" y2="${f2(a.y2)}" stroke="transparent" stroke-width="${hitW(a.width)}"/>` +
        `<line x1="${f2(a.x1)}" y1="${f2(a.y1)}" x2="${f2(end[0])}" y2="${f2(end[1])}" stroke="${a.color}" stroke-width="${a.width}" stroke-linecap="round"/>${head}`);
    }
    case 'markup': {
      const rects = a.rects.map((r) => {
        const rr = a.mode === 'highlight' ? r : underlineRect(r, a.mode);
        const hit = a.mode === 'highlight' ? '' : `<rect x="${f2(r.x)}" y="${f2(r.y)}" width="${f2(r.w)}" height="${f2(r.h)}" fill="transparent"/>`;
        return hit + `<rect x="${f2(rr.x)}" y="${f2(rr.y)}" width="${f2(rr.w)}" height="${f2(rr.h)}" fill="${a.color}"/>`;
      }).join('');
      return g('fillhit', rects);
    }
    case 'whiteout':
      return g('fillhit', `<rect x="${f2(a.x)}" y="${f2(a.y)}" width="${f2(a.w)}" height="${f2(a.h)}" fill="${a.color || '#ffffff'}"/>`);
    case 'redact':
      return g('fillhit', `<rect x="${f2(a.x)}" y="${f2(a.y)}" width="${f2(a.w)}" height="${f2(a.h)}" fill="#000" stroke="#e5484d" stroke-width="0.8" stroke-dasharray="3 2"/>`);
    case 'image': {
      const img = S.images.get(a.imageId);
      return g('fillhit', `<rect x="${f2(a.x)}" y="${f2(a.y)}" width="${f2(a.w)}" height="${f2(a.h)}" fill="transparent"/>` +
        (img ? `<image href="${img.url}" x="${f2(a.x)}" y="${f2(a.y)}" width="${f2(a.w)}" height="${f2(a.h)}" preserveAspectRatio="none"/>` : ''));
    }
    case 'symbol': {
      const P = symbolPath(a);
      return g('fillhit', `<rect x="${f2(a.x)}" y="${f2(a.y)}" width="${f2(a.w)}" height="${f2(a.h)}" fill="transparent"/>` +
        (P.stroke
          ? `<path d="${P.d}" fill="none" stroke="${a.color}" stroke-width="${f2(symbolStroke(a))}" stroke-linecap="round" stroke-linejoin="round"/>`
          : `<path d="${P.d}" fill="${a.color}"/>`));
    }
    case 'note': {
      const s = NOTE_SIZE, x = a.x, y = a.y;
      return g('fillhit', `<path d="M${x + 2} ${y + 2} h${s - 4} a2 2 0 0 1 2 2 v${s - 9} a2 2 0 0 1 -2 2 h-${s - 11} l-5 4 v-4 h-1 a2 2 0 0 1 -2 -2 v-${s - 9} a2 2 0 0 1 2 -2 z" fill="${a.color}" stroke="rgba(0,0,0,.45)" stroke-width="0.8"/>` +
        `<path d="M${x + 6} ${y + 7.5} h${s - 12} M${x + 6} ${y + 11} h${s - 15}" stroke="rgba(0,0,0,.55)" stroke-width="1.1" stroke-linecap="round"/>`);
    }
    case 'link':
      return g('fillhit', `<rect x="${f2(a.x)}" y="${f2(a.y)}" width="${f2(a.w)}" height="${f2(a.h)}" fill="rgba(47,123,246,.10)" stroke="#2f7bf6" stroke-width="0.8" stroke-dasharray="3 2"/>`);
    case 'field': {
      const filled = extraCls.includes('filled');
      const box = `x="${f2(a.x)}" y="${f2(a.y)}" width="${f2(a.w)}" height="${f2(a.h)}"`;
      const title = `<title>${esc(fieldTitle(a))}</title>`;
      const kl = `<text class="fk" x="${f2(a.x)}" y="${f2(a.y - 1.5)}" font-size="6" font-family='${FONTS.helv.css}'>${FIELD_KINDS[a.kind] || ''}${a.auto ? ' (auto)' : ''}</text>`;
      if (a.kind === 'sig') {
        const fs = clamp(a.h * 0.36, 6, 11);
        const lbl = filled ? '' : `<text x="${f2(a.x + Math.min(6, a.w * 0.05))}" y="${f2(a.y + a.h / 2 + fs * 0.36)}" font-size="${f2(fs)}" font-family='${FONTS.helv.css}' font-weight="600" fill="#8a6100" style="white-space:pre">✍ Signer ici</text>`;
        return g('fillhit', title + `<rect class="fz" ${box} rx="1.5" fill="#f5c518" fill-opacity="${filled ? 0 : 0.24}" stroke="#d4a106" stroke-opacity="${filled ? 0 : 0.75}" stroke-width="0.7" stroke-dasharray="3 2"/>` + lbl + kl);
      }
      const op = a.kind === 'check' ? 0.16 : filled ? 0.06 : 0.15;
      const stroke = a.kind === 'check' ? ' stroke="#2563eb" stroke-opacity=".55" stroke-width="0.6"' : '';
      if (a.kind === 'text' && a.comb?.length) {
        // Peigne : une pastille par case (le grand rectangle ne sert qu'au clic et au contour en mode Champs)
        const cells = combCells(a).map((c) => {
          const gap = Math.min(0.8, (c.x1 - c.x0) * 0.08);
          return `<rect class="fzc" x="${f2(c.x0 + gap)}" y="${f2(a.y)}" width="${f2(Math.max(0.5, c.x1 - c.x0 - 2 * gap))}" height="${f2(a.h)}" fill="#2563eb" fill-opacity="${filled ? 0.05 : 0.13}"/>`;
        }).join('');
        return g('fillhit', title + `<rect class="fz" ${box} fill="#2563eb" style="fill-opacity:0"/>` + cells + kl);
      }
      // Très petite case : zone de clic invisible élargie à 12 pt pour pouvoir la viser
      const m = a.kind === 'check' ? Math.max(0, (12 - Math.min(a.w, a.h)) / 2) : 0;
      const hit = m ? `<rect x="${f2(a.x - m)}" y="${f2(a.y - m)}" width="${f2(a.w + 2 * m)}" height="${f2(a.h + 2 * m)}" fill="#2563eb" style="fill-opacity:0"/>` : '';
      return g('fillhit', title + hit + `<rect class="fz" ${box} fill="#2563eb" fill-opacity="${op}"${stroke}/>` + kl);
    }
    default:
      return '';
  }
}

export function renderOverlay(pageId) {
  const o = overlays.get(pageId);
  if (!o) return;
  const list = S.annots.filter((a) => a.pageId === pageId);
  // Zones de champ sous le surlignage (même calque, mélange « multiplier » : le texte reste lisible)
  let fields = '';
  if (S.tool === 'field' || getSettings().showFields !== false) {
    const byField = new Map();
    for (const a of list) if (a.fieldId) (byField.get(a.fieldId) || byField.set(a.fieldId, []).get(a.fieldId)).push(a);
    fields = list.filter((a) => a.type === 'field').map((a) => annotSvg(a, `k-${a.kind}${fieldFilled(a, byField.get(a.id) || []) ? ' filled' : ''}`)).join('');
  }
  o.hlSvg.innerHTML = fields + list.filter((a) => a.type === 'markup').map((a) => annotSvg(a)).join('');
  o.mainSvg.innerHTML = list.filter((a) => a.type !== 'markup' && a.type !== 'field').map((a) => annotSvg(a)).join('') + docDecorations(pageId);
  renderSelection(pageId);
  renderSuggestions(pageId);
  renderOcrLines(pageId);
}

// ---------- Suggestions « Mes informations » : aperçu de la valeur dans le champ + pastille sous le champ ----------
const suggestions = new Map(); // fieldId -> { value, title, onAccept, onReject }
/** Remplace les suggestions affichées. list : [{ field, value, title, onAccept, onReject }] */
export function setSuggestions(list) {
  suggestions.clear();
  for (const s of list) suggestions.set(s.field.id, s);
  for (const id of overlays.keys()) renderSuggestions(id);
}
export function dropSuggestion(fieldId) {
  const f = getAnnot(fieldId);
  if (suggestions.delete(fieldId) && f) renderSuggestions(f.pageId);
}
function renderSuggestions(pageId) {
  const o = overlays.get(pageId);
  if (!o) return;
  for (const el of [...o.ui.querySelectorAll('.pa-sugg')]) el.remove();
  if (!suggestions.size) return;
  const editedField = (editing && getAnnot(editing.id)?.fieldId) || combEdit?.f?.id;
  for (const [id, s] of suggestions) {
    const f = getAnnot(id);
    if (!f || f.pageId !== pageId || id === editedField || !isFieldEmpty(f)) continue;
    const box = document.createElement('div');
    box.className = 'pa-sugg pa-sugg-box';
    box.dataset.sugg = id;
    Object.assign(box.style, { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px' });
    // aperçu de ce qui sera écrit
    if (f.kind === 'check') {
      const g = document.createElement('span');
      g.className = 'pa-sugg-val';
      g.textContent = '✓';
      Object.assign(g.style, { fontSize: Math.min(f.w, f.h) * 0.95 + 'px', lineHeight: f.h + 'px', width: '100%', textAlign: 'center' });
      box.append(g);
    } else if (f.comb?.length) {
      combCells(f).forEach((c, i) => {
        const ch = String(s.value)[i];
        if (!ch || ch === ' ') return;
        const g = document.createElement('span');
        g.className = 'pa-sugg-val';
        g.textContent = ch;
        Object.assign(g.style, { left: c.x0 - f.x + 'px', width: c.x1 - c.x0 + 'px', textAlign: 'center', fontSize: clamp(f.h * 0.75, 5, 13) + 'px', lineHeight: f.h + 'px' });
        box.append(g);
      });
    } else {
      const single = !f.multiline && f.h < 34;
      const size = single ? clamp(Math.round(f.h * 0.74 * 2) / 2, 7, 12) : 11;
      const g = document.createElement('span');
      g.className = 'pa-sugg-val';
      g.textContent = s.value;
      Object.assign(g.style, { left: '2px', right: '2px', fontSize: size + 'px', lineHeight: (single ? f.h : size * 1.2) + 'px', top: single ? 0 : '1.5px' });
      box.append(g);
    }
    // pastille sous le champ (taille constante quel que soit le zoom)
    const chip = document.createElement('div');
    chip.className = 'pa-sugg pa-sugg-chip';
    chip.style.left = f.x + 'px';
    chip.style.top = f.y + f.h + 1 + 'px';
    chip.title = s.title || '';
    const ok = document.createElement('button');
    ok.className = 'sg-ok';
    ok.innerHTML = '<span aria-hidden="true">✨</span> Remplir';
    ok.title = `Écrire « ${s.value === true ? 'coché' : s.value} » (${s.title || 'vos informations'})`;
    const no = document.createElement('button');
    no.className = 'sg-no';
    no.textContent = '×';
    no.title = 'Ne pas remplir ce champ';
    chip.append(ok, no);
    for (const t of ['pointerdown', 'mousedown', 'dblclick', 'contextmenu']) chip.addEventListener(t, (e) => e.stopPropagation());
    ok.addEventListener('click', (e) => { e.stopPropagation(); s.onAccept?.(); });
    no.addEventListener('click', (e) => { e.stopPropagation(); s.onReject?.(); });
    o.ui.append(box, chip);
  }
}
/** Fait défiler jusqu'à un champ et le met brièvement en évidence. */
export async function revealField(fieldId) {
  const f = getAnnot(fieldId);
  if (!f) return;
  let pc = pageCtxById(f.pageId);
  if (!pc) {
    S.viewer.scrollPageIntoView({ pageNumber: S.pages.findIndex((p) => p.id === f.pageId) + 1 });
    for (let k = 0; k < 40 && !(pc = pageCtxById(f.pageId)); k++) await new Promise((r) => setTimeout(r, 50));
    if (!pc) return;
  }
  const el = pc.o.ui.querySelector(`.pa-sugg-box[data-sugg="${f.id}"]`) || pc.o.host.querySelector(`[data-aid="${f.id}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' });
  el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
}

/** Aperçu du filigrane et de la numérotation (réglages du document) */
function docDecorations(pageId) {
  const ds = S.docSettings;
  if (!ds.watermark && !ds.pageNumbers) return '';
  const pc = pageCtxById(pageId);
  if (!pc) return '';
  const { baseW, baseH } = pc.g;
  const dr = rotDelta(pc.meta);
  // Repère « affiché » : on dessine dans un groupe qui annule la rotation supplémentaire
  const W = dr % 180 ? baseH : baseW, H = dr % 180 ? baseW : baseH;
  let inv = '';
  if (dr === 90) inv = `translate(0 ${baseH}) rotate(-90)`;
  else if (dr === 180) inv = `translate(${baseW} ${baseH}) rotate(180)`;
  else if (dr === 270) inv = `translate(${baseW} 0) rotate(90)`;
  let out = `<g transform="${inv}" pointer-events="none">`;
  const wm = ds.watermark;
  if (wm?.text) {
    const ff = FONTS.helv.css;
    out += `<text x="${W / 2}" y="${H / 2 + 0.32 * wm.size}" text-anchor="middle" font-family='${ff}' font-weight="700" font-size="${wm.size}" fill="${wm.color}" fill-opacity="${wm.opacity}" transform="rotate(${-wm.angle} ${W / 2} ${H / 2})">${esc(wm.text)}</text>`;
  }
  const pn = ds.pageNumbers;
  const idx = pc.index;
  if (pn && !(pn.skipFirst && idx === 0)) {
    const txt = pageNumberText(pn, idx, S.pages.length);
    const pos = pageNumberPos(pn, W, H, txt);
    out += `<text x="${pos.x}" y="${pos.y}" font-family='${FONTS.helv.css}' font-size="${pn.size}" fill="${pn.color}" style="white-space:pre">${esc(txt)}</text>`;
  }
  return out + '</g>';
}
export function pageNumberText(pn, idx, total) {
  const n = idx + (pn.start || 1);
  const t = total + (pn.start || 1) - 1;
  return (pn.format || 'Page {n} / {total}').replace('{n}', n).replace('{total}', t);
}
export function pageNumberPos(pn, W, H, txt) {
  const w = (measure(txt, `100px ${FONTS.helv.css}`) * pn.size) / 100;
  const m = pn.margin ?? 28;
  const [v, hpos] = (pn.position || 'bottom-center').split('-');
  const x = hpos === 'left' ? m : hpos === 'right' ? W - m - w : (W - w) / 2;
  const y = v === 'top' ? m + pn.size * 0.75 : H - m;
  return { x, y, w };
}

function renderSelection(pageId) {
  const o = overlays.get(pageId);
  if (!o) return;
  for (const el of [...o.ui.children]) if (!el.classList.contains('pa-editor') && !el.classList.contains('pa-sugg') && !el.classList.contains('pa-ocrline')) el.remove();
  const sel = [...S.selection].map(getAnnot).filter((a) => a && a.pageId === pageId);
  for (const a of sel) {
    const b = bbox(a);
    const box = document.createElement('div');
    box.className = 'selbox';
    const pad = a.type === 'markup' ? 1 : 0;
    Object.assign(box.style, { left: b.x - pad + 'px', top: b.y - pad + 'px', width: b.w + 2 * pad + 'px', height: b.h + 2 * pad + 'px' });
    box.dataset.aidSel = a.id;
    o.ui.append(box);
  }
  if (sel.length === 1 && editing?.id !== sel[0].id) {
    for (const hd of handlesFor(sel[0])) {
      const el = document.createElement('div');
      el.className = 'handle';
      el.dataset.handle = hd.name;
      el.style.left = hd.x + 'px';
      el.style.top = hd.y + 'px';
      el.style.cursor = hd.cursor;
      o.ui.append(el);
    }
  }
}

function handlesFor(a) {
  const b = bbox(a);
  const { x, y, w, h } = b;
  if (a.type === 'line' || a.type === 'arrow') {
    return [{ name: 'p1', x: a.x1, y: a.y1, cursor: 'crosshair' }, { name: 'p2', x: a.x2, y: a.y2, cursor: 'crosshair' }];
  }
  if (a.type === 'markup' || a.type === 'note') return [];
  const corners = [
    { name: 'nw', x, y, cursor: 'nwse-resize' }, { name: 'ne', x: x + w, y, cursor: 'nesw-resize' },
    { name: 'se', x: x + w, y: y + h, cursor: 'nwse-resize' }, { name: 'sw', x, y: y + h, cursor: 'nesw-resize' },
  ];
  if (a.type === 'text' || a.type === 'stamp') return corners;
  return corners.concat([
    { name: 'n', x: x + w / 2, y, cursor: 'ns-resize' }, { name: 'e', x: x + w, y: y + h / 2, cursor: 'ew-resize' },
    { name: 's', x: x + w / 2, y: y + h, cursor: 'ns-resize' }, { name: 'w', x, y: y + h / 2, cursor: 'ew-resize' },
  ]);
}

export function renderAll() {
  for (const id of overlays.keys()) renderOverlay(id);
}
/** Ré-applique les transformations (après rotation de page) */
export function refreshGeometry() {
  geomCache.clear();
  for (const o of overlays.values()) o.host.remove();
  overlays.clear();
  attachAll();
}

function changed(pageIds) {
  const ids = pageIds ? new Set(pageIds) : null;
  for (const id of overlays.keys()) if (!ids || ids.has(id)) renderOverlay(id);
  markDirty();
  emit('annots');
}

// ---------- API ----------
export function addAnnot(a, { select = true, cp = true } = {}) {
  if (cp) checkpoint();
  a.id ||= uid();
  normalize(a);
  S.annots.push(a);
  if (select) setSelection([a.id]);
  changed([a.pageId]);
  return a;
}
export function removeAnnots(ids, { cp = true } = {}) {
  const set = new Set(ids);
  // supprimer aussi le masque associé à un texte modifié
  for (const a of S.annots) if (set.has(a.id) && a.coverId) set.add(a.coverId);
  ids = [...set];
  const pages = new Set(S.annots.filter((a) => set.has(a.id)).map((a) => a.pageId));
  if (!pages.size) return;
  if (cp) checkpoint();
  for (const a of S.annots) if (set.has(a.id) && a.type === 'field') { removedFields.ids.add(a.id); removedFields.keys.add(fieldKey(a)); }
  S.annots = S.annots.filter((a) => !set.has(a.id));
  for (const id of ids) S.selection.delete(id);
  changed([...pages]);
  emit('selection');
}
export function setSelection(ids) {
  const before = new Set(S.selection);
  S.selection = new Set(ids);
  const pages = new Set();
  for (const id of [...before, ...S.selection]) { const a = getAnnot(id); if (a) pages.add(a.pageId); }
  for (const p of pages) renderSelection(p);
  emit('selection');
}
export function clearSelection() { if (S.selection.size) setSelection([]); }
export function selectedAnnots() { return [...S.selection].map(getAnnot).filter(Boolean); }

export function deleteSelection() {
  if (editing) return;
  removeAnnots([...S.selection]);
}
export function nudge(dx, dy) {
  const sel = selectedAnnots();
  if (!sel.length) return false;
  checkpoint();
  for (const a of sel) translateAnnot(a, dx, dy);
  changed([...new Set(sel.map((a) => a.pageId))]);
  return true;
}
export function copySelection() {
  clipboard = selectedAnnots().map((a) => structuredClone(a));
  return clipboard.length;
}
export function cutSelection() {
  if (copySelection()) deleteSelection();
}
export function paste(targetPageId) {
  if (!clipboard.length) return false;
  checkpoint();
  const ids = [];
  const samePage = clipboard.every((a) => a.pageId === targetPageId);
  for (const c of clipboard) {
    const a = structuredClone(c);
    a.id = uid();
    a.pageId = targetPageId;
    if (samePage) translateAnnot(a, 10, 10);
    S.annots.push(normalize(a));
    ids.push(a.id);
  }
  clipboard = clipboard.map((c) => (samePage ? translateAnnot(structuredClone(c), 10, 10) : c));
  setSelection(ids);
  changed([targetPageId]);
  return true;
}
export function duplicateSelection() {
  const sel = selectedAnnots();
  if (!sel.length) return;
  checkpoint();
  const ids = [];
  for (const s of sel) {
    const a = translateAnnot(structuredClone(s), 12, 12);
    a.id = uid();
    S.annots.push(a);
    ids.push(a.id);
  }
  setSelection(ids);
  changed([...new Set(sel.map((a) => a.pageId))]);
}
export function reorderSelection(toFront) {
  const sel = new Set(S.selection);
  if (!sel.size) return;
  checkpoint();
  const picked = S.annots.filter((a) => sel.has(a.id));
  const rest = S.annots.filter((a) => !sel.has(a.id));
  S.annots = toFront ? rest.concat(picked) : picked.concat(rest);
  changed([...new Set(picked.map((a) => a.pageId))]);
}
export function selectAllOnPage(pageId) {
  const fieldsOnly = S.tool === 'field';
  setSelection(S.annots.filter((a) => a.pageId === pageId && (a.type === 'field') === fieldsOnly).map((a) => a.id));
}

/** Applique des propriétés à la sélection (ou aux réglages de l'outil courant). */
export function applyProps(partial, final = true) {
  const sel = selectedAnnots();
  if (sel.length) {
    if (!liveCp) { checkpoint(); liveCp = true; }
    for (const a of sel) {
      const key = propsKeyFor(null, a);
      const allowed = TYPE_PROPS[key] || [];
      for (const [k, v] of Object.entries(partial)) {
        if (!allowed.includes(k)) continue;
        if (a.type === 'symbol' && k === 'size') {
          const c = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
          a.w = a.h = v; a.x = c.x - v / 2; a.y = c.y - v / 2;
        } else a[k] = v;
      }
      normalize(a);
      if (editing?.id === a.id) styleEditor(editing.el, a);
    }
    changed([...new Set(sel.map((a) => a.pageId))]);
    if (final) liveCp = false;
    // mémoriser aussi comme réglage par défaut de ce type
    const key = propsKeyFor(null, sel[sel.length - 1]);
    if (toolProps[key]) Object.assign(toolProps[key], pick(partial, TYPE_PROPS[key] || []));
  } else {
    const key = propsKeyFor(S.tool);
    if (toolProps[key]) Object.assign(toolProps[key], partial);
  }
  if (final) saveToolProps();
}
const pick = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => keys.includes(k)));

// ---------- Outils ----------
export function setTool(tool) {
  commitEditor();
  cancelPlacement();
  closeNotePop();
  const prev = S.tool;
  S.tool = tool;
  const c = container.classList;
  c.remove('tool-draw', 'tool-pan', 'tool-crosshair', 'tool-text', 'tool-edittext', 'tool-eraser', 'tool-markup', 'touch-draw', 'tool-field');
  if (tool === 'field') c.add('tool-field');
  if (DRAW_TOOLS.has(tool)) c.add('tool-draw');
  if (getSettings().touchDraw) c.add('touch-draw');
  if (tool === 'pan') c.add('tool-pan');
  if (SHAPE_TOOLS.has(tool) || tool === 'ink' || tool === 'note' || PLACE_TOOLS.has(tool)) c.add('tool-crosshair');
  if (tool === 'text') c.add('tool-text');
  if (tool === 'edittext') c.add('tool-edittext');
  if (tool === 'eraser') c.add('tool-eraser');
  if (MARKUP_TOOLS.has(tool)) c.add('tool-markup');
  if (tool !== 'select') clearSelection();
  if ((prev === 'field') !== (tool === 'field')) renderAll(); // afficher/masquer les zones
  emit('tool', tool);
}

export function startPlacement(template, { repeat = false } = {}) {
  placing = { template: normalize(structuredClone(template)), repeat };
}
export function cancelPlacement() {
  placing = null;
  clearGhosts();
}
export const isPlacing = () => !!placing;

function clearGhosts() {
  for (const o of overlays.values()) o.ui.querySelector('.pa-ghost')?.remove();
}

function onHover(e) {
  if (!placing || drag) return;
  const pc = pageCtxFromPoint(e.target, e.clientX, e.clientY);
  clearGhosts();
  if (!pc) return;
  const p = toBase(pc, e.clientX, e.clientY);
  const t = positioned(placing.template, p, pc);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'pa-ghost');
  svg.setAttribute('width', pc.g.baseW);
  svg.setAttribute('height', pc.g.baseH);
  svg.style.position = 'absolute';
  svg.style.left = '0';
  svg.style.top = '0';
  svg.style.overflow = 'visible';
  svg.innerHTML = annotSvg({ ...t, id: 'ghost' });
  pc.o.ui.append(svg);
}

function positioned(template, p, pc) {
  const t = structuredClone(template);
  const b = bbox(normalize(t));
  const x = clamp(p.x - b.w / 2, 0, Math.max(0, pc.g.baseW - b.w));
  const y = clamp(p.y - b.h / 2, 0, Math.max(0, pc.g.baseH - b.h));
  return translateAnnot(t, x - b.x, y - b.y);
}

// ---------- Gestion du pointeur ----------
function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0) return;
  if (editing && editing.el.contains(e.target)) return;
  if (notePop && notePop.contains(e.target)) return;
  if (editing) commitEditor();
  closeNotePop();
  const tool = S.tool;
  const isTouch = e.pointerType === 'touch';
  const pc = pageCtxFromPoint(e.target, e.clientX, e.clientY);

  if (placing) {
    if (!pc) return;
    if (isTouch && !getSettings().touchDraw && false) return;
    e.preventDefault(); e.stopPropagation();
    const p = toBase(pc, e.clientX, e.clientY);
    const a = positioned(placing.template, p, pc);
    a.id = uid();
    a.pageId = pc.meta.id;
    const repeat = placing.repeat;
    if (!repeat) { placing = null; clearGhosts(); }
    addAnnot(a, { select: !repeat });
    if (!repeat) emit('placed', a);
    return;
  }

  const handleEl = e.target.closest?.('.handle');
  const annEl = e.target.closest?.('[data-aid]');
  const annot = annEl ? getAnnot(annEl.dataset.aid) : null;

  if (tool === 'pan') {
    if (isTouch) return;
    e.preventDefault();
    drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, sl: container.scrollLeft, st: container.scrollTop };
    container.classList.add('panning');
    return;
  }

  if (isTouch && DRAW_TOOLS.has(tool) && !getSettings().touchDraw && tool !== 'text' && tool !== 'note') return;

  if (handleEl && pc) {
    const a = selectedAnnots()[0];
    if (!a) return;
    e.preventDefault(); e.stopPropagation();
    capture(e);
    drag = { kind: 'resize', pc, id: a.id, handle: handleEl.dataset.handle, orig: structuredClone(a), box: bbox(a), start: toBase(pc, e.clientX, e.clientY), cp: false };
    return;
  }

  // Clic sur une zone de champ : remplir (au relâchement, pour laisser défiler au doigt)
  // (un clic sur le texte ou la coche d'un champ agit aussi sur le champ : modifier / décocher)
  const tapField = annot?.type === 'field' ? annot
    : annot?.fieldId && (annot.type === 'text' || annot.type === 'symbol' || isCover(annot)) ? getAnnot(annot.fieldId) : null;
  if (tool === 'select' && tapField && pc && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
    if (!isTouch) { e.preventDefault(); e.stopPropagation(); }
    drag = { kind: 'fieldtap', id: tapField.id, sx: e.clientX, sy: e.clientY, pt: toBase(pc, e.clientX, e.clientY) };
    return;
  }

  if (tool === 'select' || (tool === 'field' && annot?.type === 'field')) {
    if (annot && pc) {
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey || e.ctrlKey || e.metaKey) {
        const s = new Set(S.selection);
        s.has(annot.id) ? s.delete(annot.id) : s.add(annot.id);
        setSelection([...s].filter((id) => getAnnot(id)?.pageId === annot.pageId));
      } else if (!S.selection.has(annot.id)) {
        setSelection([annot.id]);
      }
      capture(e);
      const ids = [...S.selection];
      drag = { kind: 'move', pc, ids, start: toBase(pc, e.clientX, e.clientY), sx: e.clientX, sy: e.clientY, moved: false };
      return;
    }
    if (!e.shiftKey) clearSelection();
    return; // laisser la sélection de texte / les formulaires fonctionner
  }

  if (!pc) return;
  const p = toBase(pc, e.clientX, e.clientY);

  if (tool === 'eraser') {
    e.preventDefault(); e.stopPropagation();
    capture(e);
    drag = { kind: 'erase', cp: false };
    eraseAt(e.clientX, e.clientY);
    return;
  }

  if (tool === 'text') {
    e.preventDefault(); e.stopPropagation();
    if (annot?.type === 'text') { setSelection([annot.id]); openEditor(annot, false); return; }
    const props = toolProps.text;
    const lh = 1.2 * props.size;
    const a = addAnnot({ type: 'text', pageId: pc.meta.id, x: p.x - TEXT_PAD, y: p.y - lh / 2 - TEXT_PAD, text: '', ...props }, { select: true });
    openEditor(a, true);
    return;
  }

  if (tool === 'edittext') {
    e.preventDefault(); e.stopPropagation();
    if (annot?.type === 'text') { setSelection([annot.id]); openEditor(annot, false); return; }
    editExistingText(pc, p);
    return;
  }

  if (tool === 'note') {
    e.preventDefault(); e.stopPropagation();
    if (annot?.type === 'note') { openNotePop(annot); return; }
    const a = addAnnot({
      type: 'note', pageId: pc.meta.id, x: p.x - NOTE_SIZE / 2, y: p.y - NOTE_SIZE / 2, text: '',
      color: toolProps.note.color, author: getSettings().author || '', date: Date.now(),
    }, { select: false });
    openNotePop(a, true);
    return;
  }

  if (MARKUP_TOOLS.has(tool)) {
    const onText = e.target.closest?.('.textLayer') && e.target.tagName === 'SPAN';
    if (onText) return; // sélection de texte native, traitée au relâchement
    e.preventDefault(); e.stopPropagation();
    capture(e);
    drag = { kind: 'shape', tool: 'markup-rect', pc, start: p, cur: p };
    return;
  }

  if (tool === 'ink') {
    e.preventDefault(); e.stopPropagation();
    capture(e);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', pc.g.baseW);
    svg.setAttribute('height', pc.g.baseH);
    svg.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
    const props = toolProps.ink;
    svg.innerHTML = `<path fill="none" stroke="${props.color}" stroke-width="${props.width}" stroke-opacity="${props.opacity}" stroke-linecap="round" stroke-linejoin="round"/>`;
    pc.o.ui.append(svg);
    drag = { kind: 'ink', pc, points: [[f2(p.x), f2(p.y)]], svg, path: svg.firstChild };
    return;
  }

  if (SHAPE_TOOLS.has(tool)) {
    e.preventDefault(); e.stopPropagation();
    capture(e);
    drag = { kind: 'shape', tool, pc, start: p, cur: p };
  }
}

function capture(e) {
  try { container.setPointerCapture(e.pointerId); } catch {}
}

function onPointerMove(e) {
  if (!drag) return;
  if (drag.kind === 'pan') {
    container.scrollLeft = drag.sl - (e.clientX - drag.sx);
    container.scrollTop = drag.st - (e.clientY - drag.sy);
    return;
  }
  if (drag.kind === 'erase') {
    for (const ce of e.getCoalescedEvents?.() || [e]) eraseAt(ce.clientX, ce.clientY);
    return;
  }
  if (drag.kind === 'fieldtap') {
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) > 8) drag = null;
    return;
  }
  const pc = drag.pc;
  if (drag.kind === 'ink') {
    const evs = e.getCoalescedEvents?.() || [e];
    for (const ce of evs) {
      const p = toBase(pc, ce.clientX, ce.clientY, true);
      const last = drag.points[drag.points.length - 1];
      if (Math.hypot(p.x - last[0], p.y - last[1]) > 0.4) drag.points.push([f2(p.x), f2(p.y)]);
    }
    drag.path.setAttribute('d', inkPath(drag.points));
    return;
  }
  const p = toBase(pc, e.clientX, e.clientY);
  if (drag.kind === 'move') {
    if (!drag.moved && Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 3) return;
    drag.moved = true;
    let dx = p.x - drag.start.x, dy = p.y - drag.start.y;
    if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
    drag.dx = dx; drag.dy = dy;
    const t = `translate(${f2(dx)} ${f2(dy)})`;
    for (const id of drag.ids) {
      for (const el of pc.o.host.querySelectorAll(`[data-aid="${id}"]`)) el.setAttribute('transform', t);
    }
    for (const el of pc.o.ui.children) if (!el.classList.contains('pa-editor') && !el.classList.contains('pa-ocrline')) el.style.transform = `translate(${dx}px, ${dy}px)`;
    return;
  }
  if (drag.kind === 'resize') {
    const a = getAnnot(drag.id);
    if (!a) return;
    if (!drag.cp) { checkpoint(); drag.cp = true; }
    const o = drag.orig;
    let next;
    if (drag.handle === 'p1' || drag.handle === 'p2') {
      next = structuredClone(o);
      let { x, y } = p;
      const [ax, ay] = drag.handle === 'p1' ? [o.x2, o.y2] : [o.x1, o.y1];
      if (e.shiftKey) ({ x, y } = snap45(ax, ay, x, y));
      if (drag.handle === 'p1') { next.x1 = x; next.y1 = y; } else { next.x2 = x; next.y2 = y; }
    } else {
      const nb = resizeBox(drag.box, drag.handle, p.x - drag.start.x, p.y - drag.start.y,
        e.shiftKey || o.type === 'text' || o.type === 'stamp' || (o.type === 'image' && drag.handle.length === 2) || o.type === 'symbol');
      next = transformAnnot(structuredClone(o), drag.box, nb);
    }
    Object.assign(a, next);
    renderOverlay(a.pageId);
    return;
  }
  if (drag.kind === 'shape') {
    let cur = toBase(pc, e.clientX, e.clientY, true);
    if (e.shiftKey) {
      if (drag.tool === 'line' || drag.tool === 'arrow') cur = snap45(drag.start.x, drag.start.y, cur.x, cur.y);
      else {
        const s = Math.max(Math.abs(cur.x - drag.start.x), Math.abs(cur.y - drag.start.y));
        cur = { x: drag.start.x + Math.sign(cur.x - drag.start.x || 1) * s, y: drag.start.y + Math.sign(cur.y - drag.start.y || 1) * s };
      }
    }
    drag.cur = cur;
    drawShapeDraft();
  }
}

function snap45(ax, ay, x, y) {
  const ang = Math.atan2(y - ay, x - ax);
  const step = Math.PI / 4;
  const a = Math.round(ang / step) * step;
  const len = Math.hypot(x - ax, y - ay);
  return { x: ax + Math.cos(a) * len, y: ay + Math.sin(a) * len };
}

function resizeBox(b, handle, dx, dy, keepAspect) {
  let { x, y, w, h } = b;
  const ar = b.w / (b.h || 1);
  if (handle.includes('e')) w = b.w + dx;
  if (handle.includes('s')) h = b.h + dy;
  if (handle.includes('w')) { w = b.w - dx; x = b.x + dx; }
  if (handle.includes('n')) { h = b.h - dy; y = b.y + dy; }
  const MIN = 4;
  if (keepAspect && handle.length === 2) {
    // garder les proportions à partir du coin opposé
    const scale = Math.max(w / b.w, h / (b.h || 1));
    w = Math.max(MIN, b.w * scale);
    h = Math.max(MIN, w / ar);
    if (handle.includes('w')) x = b.x + b.w - w;
    if (handle.includes('n')) y = b.y + b.h - h;
  } else if (keepAspect && (handle === 'n' || handle === 's')) {
    w = h * ar; x = b.x + (b.w - w) / 2;
  } else if (keepAspect && (handle === 'e' || handle === 'w')) {
    h = w / ar; y = b.y + (b.h - h) / 2;
  }
  if (w < MIN) { if (handle.includes('w')) x -= MIN - w; w = MIN; }
  if (h < MIN) { if (handle.includes('n')) y -= MIN - h; h = MIN; }
  return { x, y, w, h };
}

function drawShapeDraft() {
  const { pc, start, cur, tool } = drag;
  let el = drag.draftEl;
  if (tool === 'line' || tool === 'arrow') {
    if (!el) {
      el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      el.setAttribute('width', pc.g.baseW); el.setAttribute('height', pc.g.baseH);
      el.style.cssText = 'position:absolute;left:0;top:0;overflow:visible';
      pc.o.ui.append(el);
      drag.draftEl = el;
    }
    const pr = toolProps[tool];
    el.innerHTML = annotSvg({ id: 'draft', type: tool, x1: start.x, y1: start.y, x2: cur.x, y2: cur.y, color: pr.color, width: pr.width, opacity: pr.opacity });
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.className = tool === 'crop' ? 'crop-draft' : 'draft';
    pc.o.ui.append(el);
    drag.draftEl = el;
  }
  const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
  Object.assign(el.style, { left: x + 'px', top: y + 'px', width: Math.abs(cur.x - start.x) + 'px', height: Math.abs(cur.y - start.y) + 'px' });
  if (tool === 'rect' || tool === 'ellipse') {
    const pr = toolProps[tool];
    el.style.border = `${pr.width}px solid ${pr.color}`;
    el.style.background = pr.fill || 'transparent';
    el.style.borderRadius = tool === 'ellipse' ? '50%' : '0';
    el.style.opacity = pr.opacity;
  } else if (tool === 'whiteout') {
    el.style.background = toolProps.whiteout.color;
    el.style.border = '1px dashed #888';
  } else if (tool === 'redact') {
    el.style.background = '#000';
  } else if (tool === 'markup-rect') {
    const key = S.tool;
    el.style.background = toolProps[key].color;
    el.style.mixBlendMode = 'multiply';
    el.style.opacity = '.6';
  }
}

async function onPointerUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  try { container.releasePointerCapture(e.pointerId); } catch {}
  if (d.kind === 'pan') { container.classList.remove('panning'); return; }
  if (d.kind === 'erase') return;
  if (d.kind === 'fieldtap') {
    const f = e.type !== 'pointercancel' ? getAnnot(d.id) : null;
    if (f) activateField(f, d.pt);
    return;
  }
  if (d.kind === 'move') {
    for (const el of d.pc.o.ui.children) el.style.transform = '';
    if (!d.moved || (!d.dx && !d.dy)) { renderOverlay(d.pc.meta.id); return; }
    checkpoint();
    for (const id of d.ids) { const a = getAnnot(id); if (a) translateAnnot(a, d.dx, d.dy); }
    changed([d.pc.meta.id]);
    return;
  }
  if (d.kind === 'resize') {
    if (d.cp) changed([d.pc.meta.id]);
    return;
  }
  if (d.kind === 'ink') {
    d.svg.remove();
    if (d.points.length < 1) return;
    const pts = simplify(d.points, 0.3);
    addAnnot({ type: 'ink', pageId: d.pc.meta.id, points: pts, ...toolProps.ink }, { select: false });
    return;
  }
  if (d.kind === 'shape') {
    d.draftEl?.remove();
    const { start, cur, tool, pc } = d;
    const x = Math.min(start.x, cur.x), y = Math.min(start.y, cur.y);
    const w = Math.abs(cur.x - start.x), h = Math.abs(cur.y - start.y);
    const pageId = pc.meta.id;
    if (tool === 'line' || tool === 'arrow') {
      if (Math.hypot(w, h) < 3) return;
      addAnnot({ type: tool, pageId, x1: start.x, y1: start.y, x2: cur.x, y2: cur.y, ...toolProps[tool] }, { select: false });
      return;
    }
    if (w < 3 || h < 3) return;
    const rect = { x, y, w, h };
    if (tool === 'rect' || tool === 'ellipse') addAnnot({ type: tool, pageId, ...rect, ...toolProps[tool] }, { select: false });
    else if (tool === 'whiteout') addAnnot({ type: 'whiteout', pageId, ...rect, color: toolProps.whiteout.color }, { select: false });
    else if (tool === 'redact') addAnnot({ type: 'redact', pageId, ...rect }, { select: false });
    else if (tool === 'markup-rect') {
      const mode = S.tool;
      addAnnot({ type: 'markup', mode, pageId, rects: [rect], ...toolProps[mode] }, { select: false });
    } else if (tool === 'field') addAnnot({ type: 'field', kind: guessKind(rect), pageId, ...rect, label: '' }, { select: true });
    else if (tool === 'link') emit('request-link', { pageId, rect });
    else if (tool === 'crop') emit('request-crop', { pageId, rect });
  }
}

function eraseAt(cx, cy) {
  const els = document.elementsFromPoint(cx, cy);
  const ids = new Set();
  for (const el of els) {
    const g = el.closest?.('[data-aid]');
    if (g && viewerDiv.contains(g) && g.dataset.aid !== 'ghost' && getAnnot(g.dataset.aid)?.type !== 'field') ids.add(g.dataset.aid);
  }
  if (!ids.size) return;
  const d = drag;
  removeAnnots([...ids], { cp: !d?.cp });
  if (d) d.cp = true;
}

function onDblClick(e) {
  const annEl = e.target.closest?.('[data-aid]');
  const a = annEl ? getAnnot(annEl.dataset.aid) : null;
  if (!a) return;
  if (a.type === 'text') { e.preventDefault(); e.stopPropagation(); setSelection([a.id]); openEditor(a, false); }
  else if (a.type === 'note') { e.preventDefault(); openNotePop(a); }
  else if (a.type === 'link') { e.preventDefault(); emit('edit-link', a); }
  else if (a.type === 'stamp') { e.preventDefault(); emit('edit-stamp', a); }
}

function onContextMenu(e) {
  const annEl = e.target.closest?.('[data-aid]');
  const a = annEl ? getAnnot(annEl.dataset.aid) : null;
  if (!a) return;
  e.preventDefault();
  if (a.type === 'field') { openMenu(null, fieldMenu(a), { x: e.clientX, y: e.clientY }); return; }
  if (!S.selection.has(a.id)) setSelection([a.id]);
  const items = [];
  if (a.type === 'text') items.push({ label: 'Modifier le texte', icon: 'text', run: () => openEditor(a, false) });
  if (a.type === 'note') items.push({ label: 'Ouvrir le commentaire', icon: 'note', run: () => openNotePop(a) });
  if (a.type === 'link') items.push({ label: 'Modifier le lien', icon: 'link', run: () => emit('edit-link', a) });
  if (a.type === 'stamp') items.push({ label: 'Modifier le tampon', icon: 'stamp', run: () => emit('edit-stamp', a) });
  items.push(
    { label: 'Dupliquer', icon: 'copy', kbd: 'Ctrl+D', run: duplicateSelection },
    { label: 'Copier', icon: 'copy', kbd: 'Ctrl+C', run: copySelection },
    { label: 'Premier plan', icon: 'front', kbd: 'Ctrl+]', run: () => reorderSelection(true) },
    { label: 'Arrière-plan', icon: 'back', kbd: 'Ctrl+[', run: () => reorderSelection(false) },
    '-',
    { label: 'Supprimer', icon: 'trash', kbd: 'Suppr', run: deleteSelection },
  );
  openMenu(null, items, { x: e.clientX, y: e.clientY });
}

// ---------- Surlignage à partir de la sélection de texte ----------
function onSelectionPointerUp() {
  if (!MARKUP_TOOLS.has(S.tool) || drag) return;
  setTimeout(createMarkupFromSelection, 0);
}
function createMarkupFromSelection() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  const range = sel.getRangeAt(0);
  if (!viewerDiv.contains(range.commonAncestorContainer)) return;
  const mode = S.tool;
  const byPage = new Map();
  const hosts = [...overlays.values()].filter((o) => o.host.isConnected).map((o) => ({ o, r: o.host.getBoundingClientRect() }));
  for (const r of range.getClientRects()) {
    if (r.width < 1 || r.height < 1) continue;
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const hit = hosts.find(({ r: hr }) => cx >= hr.left && cx <= hr.right && cy >= hr.top && cy <= hr.bottom);
    if (!hit) continue;
    const pc = pageCtxById(hit.o.pageId);
    if (r.width > hit.r.width * 0.95 && r.height > hit.r.height * 0.3) continue; // bloc parasite
    const a = toBase(pc, r.left, r.top), b = toBase(pc, r.right, r.bottom);
    const box = { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
    if (!byPage.has(pc.meta.id)) byPage.set(pc.meta.id, []);
    byPage.get(pc.meta.id).push(box);
  }
  if (!byPage.size) return;
  checkpoint();
  for (const [pageId, rects] of byPage) {
    const merged = mergeLineRects(rects);
    if (!merged.length) continue;
    const a = { type: 'markup', mode, pageId, rects: merged, ...toolProps[mode], id: uid() };
    S.annots.push(a);
  }
  sel.removeAllRanges();
  changed([...byPage.keys()]);
}
function mergeLineRects(rects) {
  rects = rects.filter((r) => r.w > 0.5 && r.h > 0.5).sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of rects) {
    const last = out.find((o) => {
      const ov = Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y);
      return ov > Math.min(o.h, r.h) * 0.6 && r.x <= o.x + o.w + 3 && r.x + r.w >= o.x - 3;
    });
    if (last) {
      const x0 = Math.min(last.x, r.x), y0 = Math.min(last.y, r.y);
      const x1 = Math.max(last.x + last.w, r.x + r.w), y1 = Math.max(last.y + last.h, r.y + r.h);
      Object.assign(last, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    } else out.push({ ...r });
  }
  return out.map((r) => ({ x: f2(r.x), y: f2(r.y), w: f2(r.w), h: f2(r.h) }));
}

// ---------- Éditeur de texte ----------
function styleEditor(el, a) {
  Object.assign(el.style, {
    left: a.x + 'px', top: a.y + 'px', padding: TEXT_PAD + 'px',
    font: cssFont(a), lineHeight: String(a.lh || 1.2), color: a.color,
    textAlign: a.align || 'left', background: a.bg || 'transparent', opacity: a.opacity ?? 1,
  });
}
export function openEditor(a, isNew) {
  if (editing?.id === a.id) return;
  commitEditor();
  const pc = pageCtxById(a.pageId);
  if (!pc) return;
  const el = document.createElement('div');
  el.className = 'pa-editor';
  el.contentEditable = 'plaintext-only';
  el.spellcheck = true;
  el.textContent = a.text || '';
  styleEditor(el, a);
  editing = { id: a.id, isNew, cp: isNew, el, orig: a.text };
  pc.o.ui.append(el);
  renderOverlay(a.pageId);
  el.addEventListener('input', () => {
    const ann = getAnnot(a.id);
    if (!ann) return;
    if (!editing.cp) { checkpoint(); editing.cp = true; }
    ann.text = el.innerText.replace(/\n$/, '');
    normalize(ann);
  });
  el.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    const fid = getAnnot(a.id)?.fieldId;
    if (fid && ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      ev.preventDefault();
      commitEditor();
      gotoNextField(fid, ev.shiftKey ? -1 : 1);
      return;
    }
    if (fid && ev.key === 'Enter' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
      const f = getAnnot(fid);
      if (f && !f.multiline && f.h < 34) { ev.preventDefault(); commitEditor(); gotoNextField(fid, 1); return; }
    }
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); commitEditor(); }
  });
  el.addEventListener('blur', () => setTimeout(() => { if (editing?.el === el && document.activeElement !== el && !el.contains(document.activeElement)) commitEditor(); }, 120));
  el.addEventListener('pointerdown', (ev) => ev.stopPropagation());
  const focusEditor = () => {
    if (editing?.el !== el || document.activeElement === el) return;
    el.focus({ preventScroll: true });
    const r = document.createRange();
    r.selectNodeContents(el);
    if (isNew) r.collapse(false);
    const s = getSelection();
    s.removeAllRanges();
    s.addRange(r);
  };
  focusEditor(); // immédiat : aucune frappe perdue
  emit('selection');
  setTimeout(focusEditor, 0); // au cas où un re-rendu de la barre de propriétés aurait volé le focus
}
export function commitEditor() { closeComb(); closeEditor(true); }
function closeEditor(keep) {
  if (!editing) return;
  const { id, el, isNew } = editing;
  const a = getAnnot(id);
  editing = null;
  const typed = el.innerText.replace(/\n$/, ''); // lire avant de détacher (innerText perd les sauts de ligne hors DOM)
  el.remove();
  if (a?.fieldId && suggestions.has(a.fieldId)) queueMicrotask(() => renderSuggestions(a.pageId));
  if (!a) return;
  if (keep) {
    a.text = typed;
    normalize(a);
  }
  if (a.injected != null) {
    if (a.text === a.injected) {
      // valeur imprimée ouverte puis laissée telle quelle : retirer le texte et son cache
      const f = getAnnot(a.fieldId);
      const drop = new Set([a.id, ...(f ? fieldContent(f).filter(isCover).map((x) => x.id) : [])]);
      S.annots = S.annots.filter((x) => !drop.has(x.id));
      S.selection.delete(id);
      dropCheckpoint();
      renderOverlay(a.pageId);
      emit('annots');
      emit('selection');
      return;
    }
    delete a.injected;
  }
  if (!String(a.text).trim()) {
    S.annots = S.annots.filter((x) => x.id !== id);
    S.selection.delete(id);
    if (isNew) dropCheckpoint();
    renderOverlay(a.pageId);
    emit('annots');
    emit('selection');
    return;
  }
  changed([a.pageId]);
  const f = a.fieldId && getAnnot(a.fieldId);
  if (f?.type === 'field' && keep) emit('field-filled', { field: f, value: String(a.text) });
}
export const isEditing = () => !!editing || !!combEdit;

// ---------- Commentaires ----------
function openNotePop(a, isNew = false) {
  closeNotePop();
  const pc = pageCtxById(a.pageId);
  if (!pc) return;
  const hostR = pc.o.host.querySelector(`[data-aid="${a.id}"]`)?.getBoundingClientRect() || pc.o.host.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.className = 'note-pop';
  pop.innerHTML = `<div class="meta"></div><textarea placeholder="Votre commentaire…"></textarea>
    <div class="row"><button class="btn sm danger" data-act="del">Supprimer</button><span class="flex"></span><button class="btn sm primary" data-act="ok">OK</button></div>`;
  pop.querySelector('.meta').textContent = `${a.author || 'Commentaire'} · ${formatDate(new Date(a.date || Date.now()), true)}`;
  const ta = pop.querySelector('textarea');
  ta.value = a.text || '';
  document.body.append(pop);
  const left = clamp(hostR.right + 8, 8, innerWidth - 296);
  const top = clamp(hostR.top, 8, innerHeight - pop.offsetHeight - 8);
  Object.assign(pop.style, { left: left + 'px', top: top + 'px' });
  notePop = pop;
  pop._annot = a.id;
  pop._isNew = isNew;
  ta.focus();
  ta.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape' || (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey))) { ev.preventDefault(); closeNotePop(); }
  });
  pop.querySelector('[data-act=ok]').onclick = () => closeNotePop();
  pop.querySelector('[data-act=del]').onclick = () => { pop._delete = true; closeNotePop(); };
}
function closeNotePop() {
  const pop = notePop;
  if (!pop) return;
  notePop = null;
  const a = getAnnot(pop._annot);
  const text = pop.querySelector('textarea').value;
  pop.remove();
  if (!a) return;
  if (pop._delete || (!text.trim() && pop._isNew)) {
    if (pop._isNew) {
      S.annots = S.annots.filter((x) => x.id !== a.id);
      dropCheckpoint();
      renderOverlay(a.pageId);
      emit('annots');
    } else removeAnnots([a.id]);
    return;
  }
  if (text !== a.text) {
    if (!pop._isNew) checkpoint();
    a.text = text;
    changed([a.pageId]);
  }
}

// ---------- Modifier un texte existant du PDF ----------
const textRunsCache = new Map();
const sampleCache = new Map();

async function getTextRuns(pageId) {
  if (textRunsCache.has(pageId)) return textRunsCache.get(pageId);
  const p = (async () => {
    const g = await ensurePageGeom(pageId);
    const tc = await g.pdfPage.getTextContent({ includeMarkedContent: false });
    const vp = g.vp;
    const items = [];
    for (const it of tc.items) {
      if (!it.str || !it.str.trim() || !it.transform) continue;
      const [a, b, c, d, e, f] = it.transform;
      const hgt = it.height || Math.hypot(c, d);
      const len = Math.hypot(a, b) || 1;
      const ux = a / len, uy = b / len;           // direction du texte
      const upl = Math.hypot(c, d) || 1;
      const vx = c / upl, vy = d / upl;           // direction « haut »
      const st = tc.styles[it.fontName] || {};
      const asc = st.ascent || 0.8, desc = st.descent || -0.2;
      const W = it.width;
      const pts = [
        [e + vx * desc * hgt, f + vy * desc * hgt],
        [e + vx * desc * hgt + ux * W, f + vy * desc * hgt + uy * W],
        [e + vx * asc * hgt, f + vy * asc * hgt],
        [e + vx * asc * hgt + ux * W, f + vy * asc * hgt + uy * W],
      ].map(([x, y]) => vp.convertToViewportPoint(x, y));
      const base0 = vp.convertToViewportPoint(e, f);
      const base1 = vp.convertToViewportPoint(e + ux * W, f + uy * W);
      if (Math.abs(base1[1] - base0[1]) > Math.max(1, Math.abs(base1[0] - base0[0]) * 0.1)) continue; // texte non horizontal
      const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
      items.push({
        str: it.str, x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys),
        base: base0[1], size: hgt, fontName: it.fontName, family: st.fontFamily || '',
        rtl: base1[0] < base0[0],
      });
    }
    // Regrouper les morceaux d'une même ligne
    const runs = [];
    for (const it of items) {
      const last = runs[runs.length - 1];
      if (last && Math.abs(last.base - it.base) < it.size * 0.3 && Math.abs(last.size - it.size) < it.size * 0.25 &&
          it.x0 - last.x1 < it.size * 1.2 && it.x0 - last.x1 > -it.size * 0.6) {
        const gap = it.x0 - last.x1;
        const sep = gap > it.size * 0.18 && !last.str.endsWith(' ') && !it.str.startsWith(' ') ? ' ' : '';
        last.str += sep + it.str;
        last.x1 = Math.max(last.x1, it.x1);
        last.y0 = Math.min(last.y0, it.y0);
        last.y1 = Math.max(last.y1, it.y1);
      } else runs.push({ ...it });
    }
    return runs;
  })();
  textRunsCache.set(pageId, p);
  return p;
}

async function getSampleCanvas(pageId) {
  if (sampleCache.has(pageId)) return sampleCache.get(pageId);
  const p = (async () => {
    const g = await ensurePageGeom(pageId);
    const meta = S.pages.find((m) => m.id === pageId);
    return renderPageToCanvas(g.pdfPage, 2, meta.baseRot);
  })();
  sampleCache.set(pageId, p);
  return p;
}

function guessFont(pdfPage, run) {
  let name = '';
  try { name = pdfPage.commonObjs.has(run.fontName) ? (pdfPage.commonObjs.get(run.fontName)?.name || '') : ''; } catch {}
  const s = (name + ' ' + run.family).toLowerCase();
  const font = /courier|mono|consol/.test(s) ? 'courier' : /times|serif(?!-)|georgia|garamond|roman|cambria|minion|book/.test(s) && !/sans/.test(s) ? 'times' : 'helv';
  return { font, bold: /bold|black|heavy|semibold|demi/.test(s), italic: /italic|oblique/.test(s) };
}

function sampleColors(canvas, run, scale) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const x0 = Math.max(0, Math.floor(run.x0 * scale)), y0 = Math.max(0, Math.floor(run.y0 * scale));
  const x1 = Math.min(canvas.width - 1, Math.ceil(run.x1 * scale)), y1 = Math.min(canvas.height - 1, Math.ceil(run.y1 * scale));
  if (x1 <= x0 || y1 <= y0) return { bg: '#ffffff', fg: '#000000' };
  // Fond : couleur la plus fréquente sur le contour élargi
  const counts = new Map();
  const m = 3;
  const add = (x, y) => {
    if (x < 0 || y < 0 || x >= canvas.width || y >= canvas.height) return;
    const d = ctx.getImageData(x, y, 1, 1).data;
    const key = `${d[0] >> 3},${d[1] >> 3},${d[2] >> 3}`;
    const c = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    c.n++; c.r += d[0]; c.g += d[1]; c.b += d[2];
    counts.set(key, c);
  };
  for (let x = x0 - m; x <= x1 + m; x += 3) { add(x, y0 - m); add(x, y1 + m); }
  for (let y = y0 - m; y <= y1 + m; y += 3) { add(x0 - m, y); add(x1 + m, y); }
  let best = null;
  for (const c of counts.values()) if (!best || c.n > best.n) best = c;
  const bg = best ? [best.r / best.n, best.g / best.n, best.b / best.n] : [255, 255, 255];
  // Texte : pixel le plus éloigné du fond à l'intérieur de la boîte
  const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  let far = -1, fg = [0, 0, 0];
  for (let i = 0; i < img.length; i += 4) {
    const dist = Math.abs(img[i] - bg[0]) + Math.abs(img[i + 1] - bg[1]) + Math.abs(img[i + 2] - bg[2]);
    if (dist > far) { far = dist; fg = [img[i], img[i + 1], img[i + 2]]; }
  }
  return { bg: rgbToHex(...bg), fg: far > 60 ? rgbToHex(...fg) : '#000000' };
}

async function editExistingText(pc, p) {
  const pageId = pc.meta.id;
  const runs = await getTextRuns(pageId);
  const tol = 2;
  const run = runs.find((r) => p.x >= r.x0 - tol && p.x <= r.x1 + tol && p.y >= r.y0 - tol && p.y <= r.y1 + tol);
  if (!run) {
    // PDF scanné : le texte est une image, on propose de le convertir (OCR)
    if (await isScannedPage(pageId)) { emit('scan-edit', { pageId, x: p.x, y: p.y }); return; }
    emit('hint', runs.length ? 'Cliquez directement sur un texte du PDF pour le modifier.' : 'Cette page ne contient pas de texte modifiable.');
    return;
  }
  // Ne pas modifier deux fois le même passage
  const already = S.annots.find((a) => a.type === 'text' && a.pageId === pageId && a.srcRun && Math.abs(a.srcRun.x0 - run.x0) < 0.5 && Math.abs(a.srcRun.base - run.base) < 0.5);
  if (already) { setSelection([already.id]); openEditor(already, false); return; }
  const g = pc.g;
  const canvas = await getSampleCanvas(pageId);
  const { bg, fg } = sampleColors(canvas, run, 2);
  const ff = guessFont(g.pdfPage, run);
  const size = Math.max(4, Math.round(run.size * 10) / 10);
  const fdef = FONTS[ff.font];
  const lh = 1.2 * size;
  const baseOff = (lh - (fdef.asc + fdef.desc) * size) / 2 + fdef.asc * size;
  checkpoint();
  const pad = Math.max(0.6, size * 0.08);
  const textId = uid();
  const cover = { id: uid(), type: 'whiteout', pageId, x: run.x0 - pad, y: run.y0 - pad, w: run.x1 - run.x0 + pad * 2, h: run.y1 - run.y0 + pad * 2, color: bg, linked: true, unit: textId };
  const text = {
    id: textId, type: 'text', pageId, x: run.x0 - TEXT_PAD, y: run.base - baseOff - TEXT_PAD, text: run.str.trim(),
    font: ff.font, bold: ff.bold, italic: ff.italic, size, color: fg, align: 'left', bg: null, opacity: 1,
    srcRun: { x0: run.x0, base: run.base }, coverId: cover.id,
  };
  S.annots.push(cover, normalize(text));
  changed([pageId]);
  setSelection([text.id]);
  openEditor(text, false);
  editing.cp = true; // le checkpoint est déjà posé
}

// ---------- PDF scannés : conversion du texte reconnu (OCR) en texte modifiable ----------
const scanCache = new Map();  // pageId -> Promise<boolean>
const ocrCache = new Map();   // pageId -> Promise<lignes>
const ocrDone = new Map();    // pageId -> lignes (reconnaissance terminée)

/**
 * Page scannée : des images couvrent une grande partie de la page (ou la page n'a aucun texte mais des images).
 * Le calcul suit le déterminant de la matrice courante : une image est peinte dans le carré unité.
 */
export function isScannedPage(pageId) {
  if (!scanCache.has(pageId)) {
    const p = (async () => {
      const g = await ensurePageGeom(pageId);
      if (!g) return false;
      const { OPS, AnnotationMode } = S.pdfjsLib;
      const ol = await g.pdfPage.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
      const [vx0, vy0, vx1, vy1] = g.pdfPage.view;
      const pageArea = Math.abs((vx1 - vx0) * (vy1 - vy0)) || 1;
      const IMG = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat, OPS.paintImageMaskXObject, OPS.paintJpegXObject].filter((x) => x != null));
      const det = (m) => (m && m.length >= 4 ? m[0] * m[3] - m[1] * m[2] : 1);
      let cur = 1, area = 0, images = 0;
      const stack = [];
      for (let i = 0; i < ol.fnArray.length; i++) {
        const fn = ol.fnArray[i], args = ol.argsArray[i];
        if (fn === OPS.save) stack.push(cur);
        else if (fn === OPS.restore) cur = stack.length ? stack.pop() : 1;
        else if (fn === OPS.transform) cur *= det(args);
        else if (fn === OPS.paintFormXObjectBegin) { stack.push(cur); const m = args?.[0]; if (m && m.length === 6) cur *= det(m); }
        else if (fn === OPS.paintFormXObjectEnd) cur = stack.length ? stack.pop() : 1;
        else if (IMG.has(fn)) { area += Math.abs(cur); images++; }
      }
      const cover = area / pageArea;
      if (cover >= 0.6) return true; // image pleine page
      if (!images || cover < 0.02) return false;
      const runs = (await getTextRuns(pageId)).length;
      return runs === 0 || (cover >= 0.25 && runs < 5);
    })();
    p.catch(() => scanCache.delete(pageId));
    scanCache.set(pageId, p);
  }
  return scanCache.get(pageId).catch(() => false);
}

/** Pages scannées du document (indices de S.pages) */
export async function scannedPageIds() {
  const out = [];
  for (const m of S.pages) if (await isScannedPage(m.id)) out.push(m.id);
  return out;
}

/** Texte reconnu d'une page (mis en cache). onProgress(0..1) pendant la reconnaissance. */
export function ocrPage(pageId, { onProgress } = {}) {
  let p = ocrCache.get(pageId);
  if (!p) {
    const pdf = S.doc?.pdf;
    p = (async () => {
      const OCR = await import('./ocr.js');
      const g = await ensurePageGeom(pageId);
      const meta = S.pages.find((m) => m.id === pageId);
      if (!g || !meta) return [];
      const scale = OCR.ocrScale(g.baseW, g.baseH);
      const canvas = await renderPageToCanvas(g.pdfPage, scale, meta.baseRot, { annotationMode: S.pdfjsLib.AnnotationMode.DISABLE });
      try {
        return await OCR.recognizePage(canvas, scale, { onProgress });
      } finally { canvas.width = canvas.height = 0; }
    })();
    ocrCache.set(pageId, p);
    p.then((lines) => {
      if (S.doc?.pdf !== pdf || ocrCache.get(pageId) !== p) return;
      ocrDone.set(pageId, lines);
      renderOverlay(pageId);
    }, () => { if (ocrCache.get(pageId) === p) ocrCache.delete(pageId); });
  }
  return p;
}

/** Interrompt la reconnaissance en cours (les pages déjà reconnues restent en cache). */
export async function cancelOcr() {
  for (const [id, p] of ocrCache) if (!ocrDone.has(id)) ocrCache.delete(id);
  const OCR = await import('./ocr.js');
  await OCR.cancelOcr();
}

const isOcrConverted = (pageId, l) => S.annots.some((a) => a.type === 'text' && a.pageId === pageId && a.srcRun &&
  Math.abs(a.srcRun.x0 - l.x0) < 0.5 && Math.abs(a.srcRun.base - l.base) < 0.5);

/** Cache + texte pour une ligne reconnue (même principe que « Modifier le texte » sur un PDF natif). */
function ocrLineAnnots(pageId, l, whole) {
  const fdef = FONTS[l.font] || FONTS.helv;
  const size = l.size;
  const lh = 1.2 * size;
  const baseOff = (lh - (fdef.asc + fdef.desc) * size) / 2 + fdef.asc * size;
  const pad = Math.max(0.8, size * 0.1);
  const textId = uid();
  const cover = { id: uid(), type: 'whiteout', pageId, x: l.x0 - pad, y: l.y0 - pad, w: l.x1 - l.x0 + pad * 2, h: l.y1 - l.y0 + pad * 2, color: l.bg, linked: true, ocr: true, unit: textId };
  const text = normalize({
    id: textId, type: 'text', pageId, x: l.ox - TEXT_PAD, y: l.base - baseOff - TEXT_PAD, text: l.str,
    font: l.font, bold: l.bold, italic: l.italic, size, color: l.color, align: 'left', bg: null, opacity: 1,
    srcRun: { x0: l.x0, base: l.base }, coverId: cover.id, ocr: whole ? 'page' : 'line',
  });
  return [cover, text];
}

function lineAt(lines, p) {
  const tol = 2;
  const hit = lines.filter((l) => p.x >= l.x0 - tol && p.x <= l.x1 + tol && p.y >= l.y0 - tol && p.y <= l.y1 + tol);
  if (hit.length) return hit.sort((a, b) => Math.abs(p.y - (a.y0 + a.y1) / 2) - Math.abs(p.y - (b.y0 + b.y1) / 2))[0];
  // tolérance verticale pour les petites lignes
  return lines.find((l) => p.x >= l.x0 - tol && p.x <= l.x1 + tol && p.y >= l.y0 - l.size * 0.35 && p.y <= l.y1 + l.size * 0.35) || null;
}

/** Une ligne de page entièrement convertie mais ignorée (reconnaissance peu fiable) peut être convertie à la demande. */
const reliable = (l) => l.conf >= 55 && (l.y1 - l.y0) < 80;

export const isPageOcrConverted = (pageId) => S.annots.some((a) => a.pageId === pageId && a.ocr === 'page');

/**
 * Convertit le texte reconnu de plusieurs pages (une seule étape d'annulation).
 * onPage(i, n, progress) suit l'avancement. Renvoie le nombre de lignes converties.
 */
export async function convertScanPages(pageIds, { onPage } = {}) {
  const pdf = S.doc?.pdf;
  const results = [];
  for (let i = 0; i < pageIds.length; i++) {
    onPage?.(i, pageIds.length, 0);
    const lines = await ocrPage(pageIds[i], { onProgress: (q) => onPage?.(i, pageIds.length, q) });
    results.push([pageIds[i], lines]);
  }
  if (S.doc?.pdf !== pdf) return 0;
  const add = [];
  for (const [pageId, lines] of results) {
    if (!S.pages.some((m) => m.id === pageId)) continue;
    for (const l of lines) if (reliable(l) && !isOcrConverted(pageId, l)) add.push(...ocrLineAnnots(pageId, l, true));
  }
  if (!add.length) return 0;
  checkpoint();
  S.annots.push(...add);
  changed([...new Set(add.map((a) => a.pageId))]);
  return add.length / 2;
}

/**
 * Ouvre à l'édition la ligne reconnue sous le point p (la convertit si besoin).
 * Renvoie 'opened' | 'none' (aucun texte reconnu à cet endroit) | 'stale'.
 */
export async function editScanLineAt(pageId, p, { onProgress } = {}) {
  const pdf = S.doc?.pdf;
  const lines = await ocrPage(pageId, { onProgress });
  if (S.doc?.pdf !== pdf || !S.pages.some((m) => m.id === pageId)) return 'stale';
  const l = lineAt(lines, p);
  if (!l) return 'none';
  const existing = S.annots.find((a) => a.type === 'text' && a.pageId === pageId && a.srcRun &&
    Math.abs(a.srcRun.x0 - l.x0) < 0.5 && Math.abs(a.srcRun.base - l.base) < 0.5);
  if (existing) { setSelection([existing.id]); openEditor(existing, false); return 'opened'; }
  commitEditor();
  checkpoint();
  const [cover, text] = ocrLineAnnots(pageId, l, false);
  S.annots.push(cover, text);
  changed([pageId]);
  setSelection([text.id]);
  openEditor(text, false);
  if (editing?.id === text.id) editing.cp = true; // le point d'annulation est déjà posé
  return 'opened';
}

/** Contour des lignes reconnues non encore converties (visible avec l'outil « Modifier le texte ») */
function renderOcrLines(pageId) {
  const o = overlays.get(pageId);
  if (!o) return;
  for (const el of [...o.ui.querySelectorAll('.pa-ocrline')]) el.remove();
  const lines = ocrDone.get(pageId);
  if (!lines?.length) return;
  const frag = document.createDocumentFragment();
  for (const l of lines) {
    if (isOcrConverted(pageId, l)) continue;
    const d = document.createElement('div');
    d.className = 'pa-ocrline';
    Object.assign(d.style, { left: l.x0 + 'px', top: l.y0 + 'px', width: (l.x1 - l.x0) + 'px', height: (l.y1 - l.y0) + 'px' });
    frag.append(d);
  }
  o.ui.append(frag);
}

export { translateAnnot as translateAnnotPublic };
export function clientToBase(pageId, clientX, clientY) {
  const pc = pageCtxById(pageId);
  return pc ? toBase(pc, clientX, clientY) : { x: 0, y: 0 };
}

// ---------- Champs de formulaire (zones détectées ou tracées) ----------
const FIELD_KINDS = { text: 'Texte', check: 'Case à cocher', sig: 'Signature' };
// Champs supprimés par l'utilisateur : pour l'annulation et pour ne pas les re-détecter
const removedFields = { ids: new Set(), keys: new Set() };
function fieldKey(f) { return `${f.pageId}|${Math.round(f.x / 4)}|${Math.round(f.y / 4)}|${Math.round(f.w / 4)}|${Math.round(f.h / 4)}`; }
export function resetFieldMemory() { removedFields.ids.clear(); removedFields.keys.clear(); }
export function wasFieldRemoved(id) { return removedFields.ids.has(id); }

function fieldTitle(f) {
  const what = f.kind === 'check' ? 'Cliquez pour cocher / décocher' : f.kind === 'sig' ? 'Cliquez pour signer' : 'Cliquez pour écrire (Tab : champ suivant)';
  return (f.label ? f.label + ' — ' : '') + what;
}
const fieldContent = (f) => S.annots.filter((x) => x.fieldId === f.id);

// ---------- Valeurs déjà imprimées dans un champ (formulaire déjà rempli) ----------
// La détection fournit f.value / f.valueRuns (texte), f.printedMark (coche ou signature présente).
// Pour modifier, la valeur imprimée est masquée par un cache (rectangle de la couleur du fond) lié au champ.
const isCover = (x) => x?.type === 'whiteout' && !!x.fieldCover;
const isCovered = (f) => fieldContent(f).some(isCover);
function fieldFilled(f, contents) {
  if (contents.some((x) => !isCover(x))) return true;
  return !!(f.value || f.printedMark) && !contents.some(isCover);
}
function innerBox(f, k = Math.max(1.2, Math.min(f.w, f.h) * 0.14)) {
  return { x: f.x + k, y: f.y + k, w: Math.max(1, f.w - 2 * k), h: Math.max(1, f.h - 2 * k) };
}
/** Couleur dominante d'une zone de la page (fond sous une coche ou une signature) */
function dominantColor(canvas, r, scale) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const x0 = Math.max(0, Math.floor(r.x * scale)), y0 = Math.max(0, Math.floor(r.y * scale));
  const x1 = Math.min(canvas.width, Math.ceil((r.x + r.w) * scale)), y1 = Math.min(canvas.height, Math.ceil((r.y + r.h) * scale));
  if (x1 <= x0 || y1 <= y0) return '#ffffff';
  const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
  const counts = new Map();
  let best = null;
  for (let i = 0; i < d.length; i += 4) {
    const key = (d[i] >> 3) << 10 | (d[i + 1] >> 3) << 5 | (d[i + 2] >> 3);
    const c = counts.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    c.n++; c.r += d[i]; c.g += d[i + 1]; c.b += d[i + 2];
    counts.set(key, c);
    if (!best || c.n > best.n) best = c;
  }
  return rgbToHex(best.r / best.n, best.g / best.n, best.b / best.n);
}
async function coverBox(f, r) {
  const canvas = await getSampleCanvas(f.pageId);
  return { id: uid(), type: 'whiteout', pageId: f.pageId, ...r, color: dominantColor(canvas, r, 2), linked: true, fieldId: f.id, fieldCover: true };
}
/** Caches couvrant le texte imprimé d'un champ (sans déborder sur la ligne ou les « ____ » dessous) */
async function coverRuns(f) {
  const canvas = await getSampleCanvas(f.pageId);
  const bottomLimit = f.cut ?? f.y + f.h;
  return (f.valueRuns || []).map((r) => {
    const pad = Math.max(0.5, r.size * 0.06);
    const y0 = r.y0 - pad, y1 = Math.max(r.y0 + r.size * 0.5, Math.min(r.y1 + pad, bottomLimit));
    const box = { x0: r.x0, y0: r.y0, x1: r.x1, y1: Math.min(r.y1, bottomLimit) };
    return {
      id: uid(), type: 'whiteout', pageId: f.pageId, x: r.x0 - pad, y: y0, w: r.x1 - r.x0 + 2 * pad, h: y1 - y0,
      color: sampleColors(canvas, box, 2).bg, linked: true, fieldId: f.id, fieldCover: true,
    };
  });
}
/** Rend modifiable la valeur imprimée d'un champ texte : cache + texte identique, ouvert à l'édition. */
async function injectTextValue(f) {
  const runs = f.valueRuns || [];
  if (!runs.length) return;
  const g = await ensurePageGeom(f.pageId);
  const canvas = await getSampleCanvas(f.pageId);
  const first = runs[0];
  const { fg } = sampleColors(canvas, { ...first, y1: Math.min(first.y1, f.cut ?? first.y1) }, 2);
  const ff = guessFont(g.pdfPage, first);
  const size = Math.max(4, Math.round(first.size * 10) / 10);
  const fdef = FONTS[ff.font] || FONTS.helv;
  const lh = 1.2 * size;
  const baseOff = (lh - (fdef.asc + fdef.desc) * size) / 2 + fdef.asc * size;
  const covers = await coverRuns(f);
  if (getAnnot(f.id) !== f || isCovered(f)) return; // champ supprimé ou déjà ouvert entre-temps
  checkpoint();
  const text = normalize({
    id: uid(), type: 'text', pageId: f.pageId, x: Math.min(...runs.map((r) => r.x0)) - TEXT_PAD, y: first.base - baseOff - TEXT_PAD,
    text: f.value, font: ff.font, bold: ff.bold, italic: ff.italic, size, color: fg, align: 'left', bg: null, opacity: 1,
    fieldId: f.id, injected: f.value,
  });
  S.annots.push(...covers, text);
  changed([f.pageId]);
  setSelection([text.id]);
  openEditor(text, false);
  if (editing?.id === text.id) editing.cp = true; // le point d'annulation est déjà posé
}
/** Vide un champ : contenu ajouté retiré, valeur imprimée masquée. */
async function clearField(f) {
  const printed = !!(f.value || f.printedMark);
  let covers = [];
  if (printed && !isCovered(f)) covers = f.kind === 'text' ? await coverRuns(f) : [await coverBox(f, innerBox(f, f.kind === 'sig' ? 1.5 : undefined))];
  checkpoint();
  const drop = new Set(fieldContent(f).filter((x) => !isCover(x)).map((x) => x.id));
  S.annots = S.annots.filter((x) => !drop.has(x.id));
  S.annots.push(...covers);
  changed([f.pageId]);
}

/** @param pt point cliqué (repère de base), facultatif : place le curseur dans la case visée d'un peigne */
export function activateField(f, pt) {
  if (f.kind === 'check') toggleCheckField(f);
  else if (f.kind === 'sig') emit('sign-field', f);
  else fillTextField(f, pt);
}

function fillTextField(f, pt) {
  if (f.comb?.length) { openCombEditor(f, pt); return; }
  const existing = fieldContent(f).find((x) => x.type === 'text');
  if (existing) { setSelection([existing.id]); openEditor(existing, false); return; }
  if (f.value && !isCovered(f)) { injectTextValue(f).catch((e) => console.error(e)); return; }
  const single = !f.multiline && f.h < 34;
  const size = single ? clamp(Math.round(f.h * 0.74 * 2) / 2, 7, 12) : 11;
  const lh = 1.2 * size;
  const y = single ? f.y + (f.h - lh) / 2 - TEXT_PAD : f.y + 1.5 - TEXT_PAD;
  const a = addAnnot({
    type: 'text', pageId: f.pageId, x: f.x + 2 - TEXT_PAD, y, text: '', font: toolProps.text.font || 'helv', size,
    color: '#000000', bold: false, italic: false, align: 'left', bg: null, opacity: 1, fieldId: f.id,
  }, { select: true });
  openEditor(a, true);
}

function checkSymbol(f, kind) {
  const s = Math.max(5, Math.min(f.w, f.h) * 0.9);
  return { type: 'symbol', kind, pageId: f.pageId, x: f.x + f.w / 2 - s / 2, y: f.y + f.h / 2 - s / 2, w: s, h: s, color: '#111827', fieldId: f.id };
}
function isChecked(f) {
  const ex = fieldContent(f);
  return ex.some((x) => x.type === 'symbol') || (!!f.printedMark && !ex.some(isCover));
}
async function toggleCheckField(f) {
  const ex = fieldContent(f);
  const covers = ex.filter(isCover);
  if (isChecked(f)) {
    const cover = f.printedMark && !covers.length ? await coverBox(f, innerBox(f)) : null;
    checkpoint();
    const drop = new Set(ex.filter((x) => x.type === 'symbol').map((x) => x.id));
    S.annots = S.annots.filter((x) => !drop.has(x.id));
    if (cover) S.annots.push(cover); // coche imprimée : masquée
  } else {
    checkpoint();
    if (f.printedMark && covers.length) {
      const drop = new Set(covers.map((x) => x.id)); // la coche imprimée réapparaît
      S.annots = S.annots.filter((x) => !drop.has(x.id));
    } else {
      S.annots.push(normalize({ ...checkSymbol(f, toolProps.field.mark || 'check'), id: uid() }));
    }
    changed([f.pageId]);
    emit('field-filled', { field: f, value: true });
    return;
  }
  changed([f.pageId]);
}
function setCheckMark(f, mark) {
  toolProps.field.mark = mark;
  saveToolProps();
  const ex = fieldContent(f).filter((x) => x.type === 'symbol');
  if (!ex.length) return;
  checkpoint();
  for (const x of ex) x.kind = mark;
  changed([f.pageId]);
}

/** Place une image (signature) ajustée dans la zone, en remplaçant l'éventuelle signature précédente. */
export async function placeInField(f, tpl) {
  const cover = f.printedMark && !isCovered(f) ? await coverBox(f, innerBox(f, 1.5)) : null;
  checkpoint();
  const old = new Set(fieldContent(f).filter((x) => !isCover(x)).map((x) => x.id));
  S.annots = S.annots.filter((x) => !old.has(x.id));
  if (cover) S.annots.push(cover);
  const pad = Math.min(3, f.h * 0.08);
  const sc = Math.min((f.w - 2 * pad) / tpl.w, (f.h - 2 * pad) / tpl.h);
  const w = tpl.w * sc, h = tpl.h * sc;
  const a = { ...tpl, id: uid(), pageId: f.pageId, x: f.x + (f.w - w) / 2, y: f.y + (f.h - h) / 2, w, h, fieldId: f.id };
  S.annots.push(a);
  changed([f.pageId]);
  setSelection([a.id]);
  return a;
}

function setFieldKind(f, kind) {
  if (f.kind === kind) return;
  checkpoint();
  f.kind = kind;
  f.auto = false;
  changed([f.pageId]);
}

function fieldMenu(f) {
  const has = fieldFilled(f, fieldContent(f));
  const items = [
    { label: f.kind === 'check' ? (isChecked(f) ? 'Décocher' : 'Cocher') : f.kind === 'sig' ? (has ? 'Changer la signature…' : 'Signer…') : 'Écrire dans ce champ',
      icon: f.kind === 'check' ? 'check' : f.kind === 'sig' ? 'signature' : 'text', run: () => activateField(f) },
  ];
  if (f.kind === 'check') {
    items.push(
      { label: 'Cocher avec ✓', checked: (toolProps.field.mark || 'check') === 'check', run: () => setCheckMark(f, 'check') },
      { label: 'Cocher avec ✗', checked: toolProps.field.mark === 'cross', run: () => setCheckMark(f, 'cross') },
    );
  }
  if (f.kind === 'text' && (f.comb || f.combOff)) {
    items.push({ label: `Une lettre par case (${(f.comb || f.combOff).length} cases)`, checked: !!f.comb, run: () => toggleComb(f) });
  }
  items.push(
    '-', { header: 'Type de champ' },
    ...Object.entries(FIELD_KINDS).map(([k, l]) => ({ label: l, icon: { text: 'text', check: 'check', sig: 'signature' }[k], checked: f.kind === k, run: () => setFieldKind(f, k) })),
    '-',
    { label: 'Effacer le contenu', icon: 'eraser', disabled: !has, run: () => clearField(f).catch((e) => console.error(e)) },
    { label: 'Supprimer ce champ', icon: 'trash', run: () => removeAnnots([f.id]) },
    { label: 'Ajuster les champs (outil Champs)', icon: 'form', kbd: 'F', run: () => emit('request-tool', 'field') },
  );
  return items;
}

/** Champs dans l'ordre de lecture (page, ligne, colonne) */
function orderedFields(kind) {
  const idx = new Map(S.pages.map((p, i) => [p.id, i]));
  return S.annots.filter((a) => a.type === 'field' && (!kind || a.kind === kind) && idx.has(a.pageId))
    .sort((p, q) => idx.get(p.pageId) - idx.get(q.pageId) ||
      (Math.abs(p.y + p.h / 2 - (q.y + q.h / 2)) > Math.min(p.h, q.h) * 0.6 ? p.y - q.y : p.x - q.x));
}
async function gotoNextField(fromId, dir) {
  const list = orderedFields('text');
  if (!list.length) return;
  const i = list.findIndex((f) => f.id === fromId);
  const f = list[(i + dir + list.length) % list.length];
  if (!f || f.id === fromId) return;
  // s'assurer que la page est affichée
  let pc = pageCtxById(f.pageId);
  if (!pc) {
    S.viewer.scrollPageIntoView({ pageNumber: S.pages.findIndex((p) => p.id === f.pageId) + 1 });
    for (let k = 0; k < 40 && !(pc = pageCtxById(f.pageId)); k++) await new Promise((r) => setTimeout(r, 50));
    if (!pc) return;
  }
  const el = pc.o.host.querySelector(`[data-aid="${f.id}"]`);
  if (el) {
    const r = el.getBoundingClientRect(), cr = container.getBoundingClientRect();
    if (r.top < cr.top + 20 || r.bottom > cr.bottom - 20) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
  fillTextField(f);
}

/** Ajoute des champs détectés automatiquement (sans point d'annulation ni modification du document). */
export function addDetectedFields(pageId, list, { force = false } = {}) {
  const existing = S.annots.filter((a) => a.pageId === pageId && a.type === 'field');
  let n = 0;
  for (const f of list) {
    const a = { type: 'field', id: uid(), pageId, kind: f.kind, x: f2(f.x), y: f2(f.y), w: f2(f.w), h: f2(f.h), label: f.label || '', auto: true };
    if (f.multiline) a.multiline = true;
    if (f.native) a.native = true;
    if (f.comb?.length) a.comb = f.comb.map(([p, q]) => [Math.round(p * 1e4) / 1e4, Math.round(q * 1e4) / 1e4]);
    if (f.value) { a.value = f.value; a.valueRuns = f.valueRuns; }
    if (f.cut != null) a.cut = f2(f.cut);
    if (f.printedMark) a.printedMark = true;
    if (existing.some((e) => overlapRatio(e, a) > 0.4)) continue;
    if (!force && removedFields.keys.has(fieldKey(a))) continue;
    S.annots.push(a);
    existing.push(a);
    n++;
  }
  if (n) { renderOverlay(pageId); emit('annots'); }
  return n;
}
export function fieldCount() { return S.annots.filter((a) => a.type === 'field').length; }

// ---------- Remplissage automatique (« Mes informations ») ----------
/** Le champ n'a encore aucune valeur (ni imprimée, ni ajoutée) */
export function isFieldEmpty(f) { return !fieldFilled(f, fieldContent(f)); }
/** Nombre de cases d'un peigne (0 si champ libre) */
export function combSize(f) { return f.comb?.length || 0; }
/** Écrit les valeurs dans des champs vides (texte, ou true pour cocher), en une seule étape annulable. entries : [{ field, value }] */
export function autofillFields(entries) {
  const list = entries.filter(({ field, value }) => getAnnot(field.id) === field && (field.kind === 'text' || field.kind === 'check') && value && isFieldEmpty(field));
  if (!list.length) return 0;
  checkpoint();
  const pages = new Set();
  for (const { field: f, value } of list) {
    pages.add(f.pageId);
    if (f.kind === 'check') { S.annots.push(normalize({ ...checkSymbol(f, toolProps.field.mark || 'check'), id: uid() })); continue; }
    if (f.comb?.length) { layoutComb(f, value); continue; }
    const font = toolProps.text.font || 'helv';
    const single = !f.multiline && f.h < 34;
    let size = single ? clamp(Math.round(f.h * 0.74 * 2) / 2, 7, 12) : 11;
    // réduire la taille si la valeur déborde de la zone
    while (size > 6 && measure(value, cssFont({ font, size })) > f.w - 4) size -= 0.5;
    const lh = 1.2 * size;
    const y = single ? f.y + (f.h - lh) / 2 - TEXT_PAD : f.y + 1.5 - TEXT_PAD;
    S.annots.push(normalize({
      id: uid(), type: 'text', pageId: f.pageId, x: f.x + 2 - TEXT_PAD, y, text: value, font, size,
      color: '#000000', bold: false, italic: false, align: 'left', bg: null, opacity: 1, fieldId: f.id,
    }));
  }
  changed([...pages]);
  return list.length;
}

// ---------- Champs « en peigne » : un caractère par case ----------
let combEdit = null;
function combCells(f) { return (f.comb || []).map(([p, q]) => ({ x0: f.x + p * f.w, x1: f.x + q * f.w })); }

/** Valeur actuelle du peigne, reconstituée à partir des caractères posés dans les cases. */
function combValue(f) {
  const cells = combCells(f);
  const out = cells.map(() => ' ');
  for (const c of fieldContent(f)) {
    const ch = c.type === 'text' ? String(c.text || '').trim() : '';
    if (!ch) continue;
    const cx = c.x + c.w / 2;
    let i = cells.findIndex((k) => cx >= k.x0 - 0.5 && cx <= k.x1 + 0.5);
    if (i < 0) i = cells.reduce((b, k, j) => (Math.abs((k.x0 + k.x1) / 2 - cx) < Math.abs((cells[b].x0 + cells[b].x1) / 2 - cx) ? j : b), 0);
    out[i] = ch[0];
  }
  return out.join('').replace(/\s+$/, '');
}

/** Pose un caractère centré dans chaque case (remplace le contenu précédent). */
function layoutComb(f, value) {
  const old = new Set(fieldContent(f).filter((x) => x.type === 'text').map((x) => x.id));
  S.annots = S.annots.filter((x) => !old.has(x.id));
  const cells = combCells(f);
  const minW = Math.min(...cells.map((c) => c.x1 - c.x0));
  const size = clamp(Math.round(Math.min(f.h * 0.9, minW * 1.15) * 2) / 2, 5, 14);
  const font = toolProps.text.font || 'helv';
  const fd = FONTS[font] || FONTS.helv;
  const lh = 1.2 * size;
  // ligne de base placée pour centrer verticalement une majuscule / un chiffre dans la case
  const baseOff = (lh - (fd.asc + fd.desc) * size) / 2 + fd.asc * size;
  const y = f.y + f.h / 2 + 0.36 * size - baseOff - TEXT_PAD;
  for (let i = 0; i < cells.length && i < value.length; i++) {
    const ch = value[i];
    if (!ch.trim()) continue;
    const cw = measure(ch, cssFont({ font, size }));
    const c = cells[i];
    S.annots.push(normalize({
      id: uid(), type: 'text', pageId: f.pageId, x: (c.x0 + c.x1) / 2 - cw / 2 - TEXT_PAD, y,
      text: ch, font, size, color: '#000000', bold: false, italic: false, align: 'left', bg: null, opacity: 1, fieldId: f.id,
    }));
  }
  changed([f.pageId]);
}

async function openCombEditor(f, pt) {
  const cellAt = (x, len) => {
    let i = combCells(f).findIndex((c) => x < c.x1);
    if (i < 0) i = f.comb.length - 1;
    return Math.min(i, len);
  };
  if (combEdit?.f.id === f.id) {
    const inp = combEdit.input;
    inp.focus({ preventScroll: true });
    if (pt) { const i = cellAt(pt.x, inp.value.length); inp.setSelectionRange(i, i); combEdit.place(); }
    return;
  }
  commitEditor();
  const pc = pageCtxById(f.pageId);
  if (!pc) return;
  clearSelection();
  const n = f.comb.length;
  const wrap = document.createElement('div');
  wrap.className = 'pa-editor pa-comb';
  Object.assign(wrap.style, { left: f.x + 'px', top: f.y + 'px', width: f.w + 'px', height: f.h + 'px' });
  const cur = document.createElement('div');
  cur.className = 'pa-comb-cur';
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', (f.label ? f.label + ' — ' : '') + `${n} cases`);
  let injected = null;
  if (f.value && !fieldContent(f).some((x) => x.type === 'text') && !isCovered(f)) {
    // valeur imprimée : masquée et recréée case par case (annulé si rien ne change)
    const covers = await coverRuns(f);
    checkpoint();
    S.annots.push(...covers);
    layoutComb(f, f.value);
    injected = combValue(f);
  }
  input.value = combValue(f);
  wrap.append(cur, input);
  pc.o.ui.append(wrap);
  const place = () => {
    const c = combCells(f)[clamp(input.selectionStart ?? input.value.length, 0, n - 1)];
    if (!c) return;
    cur.style.left = (c.x0 - f.x) + 'px';
    cur.style.width = (c.x1 - c.x0) + 'px';
  };
  const ce = combEdit = { f, wrap, input, cp: injected != null, place, injected };
  renderSuggestions(f.pageId);
  // Au milieu du peigne, la frappe remplace le caractère de la case (comme sur papier)
  input.addEventListener('beforeinput', (e) => {
    if (e.inputType !== 'insertText' || !e.data || e.data.length !== 1) return;
    const s = input.selectionStart, t = input.selectionEnd;
    if (s !== t || s >= input.value.length) return;
    e.preventDefault();
    input.value = input.value.slice(0, s) + e.data + input.value.slice(s + 1);
    input.setSelectionRange(s + 1, s + 1);
    input.dispatchEvent(new Event('input'));
  });
  input.addEventListener('input', () => {
    let v = input.value, pos = input.selectionStart ?? v.length;
    if (v.length > n) {
      // collé avec des séparateurs : « 06 12 34 56 78 », « 12/03/1990 »
      const stripped = v.replace(/[\s./\-–_]/g, '');
      v = (stripped.length <= n ? stripped : v).slice(0, n);
      pos = Math.min(pos, v.length);
    }
    if (v !== input.value) { input.value = v; input.setSelectionRange(pos, pos); }
    if (!ce.cp) { checkpoint(); ce.cp = true; }
    layoutComb(f, v);
    place();
  });
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) { e.preventDefault(); closeComb(); gotoNextField(f.id, e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Enter') { e.preventDefault(); closeComb(); gotoNextField(f.id, 1); return; }
    if (e.key === 'Escape') { e.preventDefault(); closeComb(); return; }
    setTimeout(place, 0);
  });
  input.addEventListener('select', place);
  // Clic sur une case : le curseur s'y place
  wrap.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const i = cellAt(toBase(pc, e.clientX, e.clientY).x, input.value.length);
    input.focus({ preventScroll: true });
    input.setSelectionRange(i, i);
    place();
  });
  input.addEventListener('blur', () => setTimeout(() => { if (combEdit === ce && document.activeElement !== input) closeComb(); }, 120));
  const start = pt ? cellAt(pt.x, input.value.length) : input.value.length;
  const focus = () => {
    if (combEdit !== ce || document.activeElement === input) return;
    input.focus({ preventScroll: true });
    input.setSelectionRange(start, start);
    place();
  };
  focus();
  setTimeout(focus, 0);
  emit('selection');
}
function closeComb() {
  if (!combEdit) return;
  const { wrap, f, injected } = combEdit;
  combEdit = null;
  wrap.remove();
  renderSuggestions(f.pageId);
  const value = combValue(f);
  if (injected != null && value === injected) {
    const drop = new Set(fieldContent(f).map((x) => x.id));
    S.annots = S.annots.filter((x) => !drop.has(x.id));
    dropCheckpoint();
    renderOverlay(f.pageId);
    emit('annots');
  } else if (value.trim() && getAnnot(f.id) === f) {
    emit('field-filled', { field: f, value });
  }
  emit('selection');
}
function toggleComb(f) {
  checkpoint();
  if (f.comb) { f.combOff = f.comb; delete f.comb; } else if (f.combOff) { f.comb = f.combOff; delete f.combOff; }
  changed([f.pageId]);
}
