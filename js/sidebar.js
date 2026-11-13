// Panneau latéral : miniatures (réorganisation par glisser-déposer), signets, liste des annotations
import { S, on, unsavedByPage } from './state.js';
import { $, $$, h, openMenu, escapeHtml } from './util.js';
import { icon } from './icons.js';
import { TYPE_LABELS, TYPE_ICONS } from './geom.js';
import * as A from './annotations.js';

let actions = null;
let thumbSel = new Set();
let anchor = 0;
let io = null;
let renderQueue = [];
let rendering = false;
let generation = 0;
const THUMB_W = 150;

export function initSidebar(acts) {
  actions = acts;
  for (const b of $$('.side-tabs .st')) {
    b.onclick = () => showPane(b.dataset.pane);
  }
  for (const b of $$('[data-pageop]')) {
    b.onclick = () => runPageOp(b.dataset.pageop);
  }
  const thumbs = $('#thumbs');
  thumbs.addEventListener('keydown', (e) => {
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); runPageOp('delete'); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); clickThumb(Math.min(S.pages.length - 1, anchor + 1), {}); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); clickThumb(Math.max(0, anchor - 1), {}); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') { e.preventDefault(); e.stopPropagation(); thumbSel = new Set(S.pages.map((_, i) => i)); updateThumbSel(); }
  });
  // Dépôt de fichiers sur la liste des miniatures : insertion
  thumbs.addEventListener('dragover', (e) => {
    if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); e.stopPropagation(); }
  });
  thumbs.addEventListener('drop', (e) => {
    if (!e.dataTransfer.files.length) return;
    e.preventDefault(); e.stopPropagation();
    clearDropMarks();
    const target = dropTargetIndex(e);
    actions.insertFiles([...e.dataTransfer.files], target);
  });
  // Redimensionnement du panneau
  const rs = $('#sideResize');
  rs.addEventListener('pointerdown', (e) => {
    rs.setPointerCapture(e.pointerId);
    const sx = e.clientX, sw = $('#sidebar').offsetWidth;
    const mv = (ev) => { const w = Math.max(150, Math.min(520, sw + ev.clientX - sx)); document.documentElement.style.setProperty('--side-w', w + 'px'); };
    const up = () => { rs.removeEventListener('pointermove', mv); rs.removeEventListener('pointerup', up); actions.sideResized?.($('#sidebar').offsetWidth); };
    rs.addEventListener('pointermove', mv);
    rs.addEventListener('pointerup', up);
  });

  on('annots', () => { refreshBadges(); if (!$('#pane-annots').hidden) buildAnnotList(); });
  on('saved', refreshBadges);
  on('selection', () => { if (!$('#pane-annots').hidden) markAnnotSel(); });
}

export function showPane(name) {
  for (const b of $$('.side-tabs .st')) b.classList.toggle('active', b.dataset.pane === name);
  for (const p of ['thumbs', 'outline', 'annots']) $('#pane-' + p).hidden = p !== name;
  if (name === 'annots') buildAnnotList();
}

// ---------- Miniatures ----------
export function buildThumbs() {
  generation++;
  const gen = generation;
  const box = $('#thumbs');
  box.innerHTML = '';
  io?.disconnect();
  renderQueue = [];
  thumbSel = new Set([...thumbSel].filter((i) => i < S.pages.length));
  if (!S.doc) return;
  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (en.isIntersecting) {
        const i = +en.target.dataset.index;
        if (!en.target._rendered) enqueue(i, gen);
      }
    }
  }, { root: box, rootMargin: '300px 0px' });
  const firstVp = S.viewer.getPageView(0)?.viewport;
  const ratio = firstVp ? firstVp.height / firstVp.width : 1.414;
  for (let i = 0; i < S.pages.length; i++) {
    const frame = h('div', { class: 'tframe', style: { width: THUMB_W + 'px', height: Math.round(THUMB_W * ratio) + 'px' } });
    const item = h('div', { class: 'thumb', draggable: 'true', 'data-index': i, title: `Page ${i + 1}` }, frame, h('div', { class: 'tnum' }, String(i + 1)));
    item.addEventListener('click', (e) => clickThumb(i, e));
    item.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!thumbSel.has(i)) clickThumb(i, {}); thumbMenu(e); });
    item.addEventListener('dragstart', (e) => {
      if (!thumbSel.has(i)) { thumbSel = new Set([i]); updateThumbSel(); }
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-pa-pages', JSON.stringify([...thumbSel]));
      setTimeout(() => $$('.thumb').forEach((t) => t.classList.toggle('dragging', thumbSel.has(+t.dataset.index))), 0);
    });
    item.addEventListener('dragend', () => { $$('.thumb.dragging').forEach((t) => t.classList.remove('dragging')); clearDropMarks(); });
    item.addEventListener('dragover', (e) => {
      const internal = e.dataTransfer.types.includes('application/x-pa-pages');
      if (!internal && !e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      clearDropMarks();
      const r = item.getBoundingClientRect();
      item.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
    });
    item.addEventListener('drop', (e) => {
      const data = e.dataTransfer.getData('application/x-pa-pages');
      if (!data) return; // fichiers : géré par le conteneur
      e.preventDefault(); e.stopPropagation();
      const r = item.getBoundingClientRect();
      const target = i + (e.clientY < r.top + r.height / 2 ? 0 : 1);
      clearDropMarks();
      actions.movePages(JSON.parse(data), target);
    });
    box.append(item);
    io.observe(item);
  }
  refreshBadges();
  updateThumbSel();
  markCurrent(S.viewer.currentPageNumber || 1);
}

function dropTargetIndex(e) {
  const items = $$('.thumb');
  for (const it of items) {
    const r = it.getBoundingClientRect();
    if (e.clientY < r.top + r.height / 2) return +it.dataset.index;
  }
  return items.length;
}
function clearDropMarks() { $$('.thumb.drop-before, .thumb.drop-after').forEach((t) => t.classList.remove('drop-before', 'drop-after')); }

function enqueue(i, gen) {
  if (renderQueue.some((q) => q.i === i)) return;
  renderQueue.push({ i, gen });
  pump();
}
async function pump() {
  if (rendering) return;
  rendering = true;
  while (renderQueue.length) {
    const { i, gen } = renderQueue.shift();
    if (gen !== generation) continue;
    const item = $(`.thumb[data-index="${i}"]`);
    if (!item || item._rendered) continue;
    try {
      const page = await S.doc.pdf.getPage(i + 1);
      if (gen !== generation) break;
      const vp1 = page.getViewport({ scale: 1 });
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const scale = (THUMB_W / vp1.width) * dpr;
      const vp = page.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      c.style.width = THUMB_W + 'px';
      c.style.height = Math.round(vp.height / dpr) + 'px';
      const ctx = c.getContext('2d', { alpha: false });
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp, annotationMode: S.pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
      if (gen !== generation) break;
      const frame = item.querySelector('.tframe');
      frame.style.height = c.style.height;
      frame.querySelector('canvas')?.remove();
      frame.prepend(c);
      item._rendered = true;
    } catch (e) {
      if (e?.name !== 'RenderingCancelledException') console.warn('miniature', e);
    }
  }
  rendering = false;
}

/** Re-rendre certaines miniatures (après modification) */
export function invalidateThumbs(indices) {
  for (const i of indices) {
    const it = $(`.thumb[data-index="${i}"]`);
    if (it) { it._rendered = false; enqueue(i, generation); }
  }
}

/** Pastille : nombre de modifications pas encore enregistrées sur la page (disparaît à l'enregistrement). */
function refreshBadges() {
  const counts = unsavedByPage();
  for (const it of $$('.thumb')) {
    const meta = S.pages[+it.dataset.index];
    const n = meta ? counts.get(meta.id) || 0 : 0;
    let b = it.querySelector('.tbadge');
    if (!n) { b?.remove(); continue; }
    if (!b) { b = h('span', { class: 'tbadge' }); it.querySelector('.tframe').append(b); }
    const s = n > 1 ? 's' : '';
    b.title = `${n} modification${s} non enregistrée${s} sur cette page`;
    b.textContent = n;
  }
}

function clickThumb(i, e) {
  if (e.shiftKey) {
    const [a, b] = [Math.min(anchor, i), Math.max(anchor, i)];
    thumbSel = new Set([...Array(b - a + 1).keys()].map((k) => a + k));
  } else if (e.ctrlKey || e.metaKey) {
    thumbSel.has(i) ? thumbSel.delete(i) : thumbSel.add(i);
    anchor = i;
  } else {
    thumbSel = new Set([i]);
    anchor = i;
    actions.goToPage(i + 1);
  }
  updateThumbSel();
  $(`.thumb[data-index="${i}"]`)?.scrollIntoView({ block: 'nearest' });
}

function updateThumbSel() {
  for (const it of $$('.thumb')) it.classList.toggle('selected', thumbSel.has(+it.dataset.index) && thumbSel.size > 0);
  const n = thumbSel.size;
  $('#thumbSelInfo').textContent = n > 1 ? `${n} pages` : n === 1 ? `Page ${[...thumbSel][0] + 1}` : `${S.pages.length} pages`;
}

export function markCurrent(pageNumber) {
  for (const it of $$('.thumb.current')) it.classList.remove('current');
  const it = $(`.thumb[data-index="${pageNumber - 1}"]`);
  if (!it) return;
  it.classList.add('current');
  if (!$('#sidebar').hidden && !$('#pane-thumbs').hidden) {
    const box = $('#thumbs');
    const r = it.getBoundingClientRect(), br = box.getBoundingClientRect();
    if (r.top < br.top || r.bottom > br.bottom) it.scrollIntoView({ block: 'nearest' });
  }
  if (thumbSel.size <= 1) { thumbSel = new Set([pageNumber - 1]); anchor = pageNumber - 1; updateThumbSel(); }
}

export function selectedPages() {
  const s = [...thumbSel].filter((i) => i < S.pages.length).sort((a, b) => a - b);
  return s.length ? s : [Math.max(0, (S.viewer.currentPageNumber || 1) - 1)];
}
export function setSelectedPages(list) { thumbSel = new Set(list); updateThumbSel(); }

function runPageOp(op) {
  if (!S.doc) return;
  const sel = selectedPages();
  switch (op) {
    case 'rotl': return actions.rotatePages(sel, -90);
    case 'rotr': return actions.rotatePages(sel, 90);
    case 'dup': return actions.duplicatePages(sel);
    case 'extract': return actions.extractPages(sel);
    case 'blank': return actions.insertBlank(sel[sel.length - 1] + 1);
    case 'delete': return actions.deletePages(sel);
  }
}

function thumbMenu(e) {
  const sel = selectedPages();
  const many = sel.length > 1;
  openMenu(null, [
    { header: many ? `${sel.length} pages` : `Page ${sel[0] + 1}` },
    { label: 'Pivoter à droite', icon: 'rotcw', run: () => actions.rotatePages(sel, 90) },
    { label: 'Pivoter à gauche', icon: 'rotccw', run: () => actions.rotatePages(sel, -90) },
    { label: 'Dupliquer', icon: 'copy', run: () => actions.duplicatePages(sel) },
    { label: 'Extraire en nouveau PDF…', icon: 'extract', run: () => actions.extractPages(sel) },
    { label: 'Exporter en image PNG…', icon: 'image', run: () => actions.exportImages(sel) },
    '-',
    { label: 'Insérer une page vierge avant', icon: 'blank', run: () => actions.insertBlank(sel[0]) },
    { label: 'Insérer une page vierge après', icon: 'blank', run: () => actions.insertBlank(sel[sel.length - 1] + 1) },
    { label: 'Insérer un PDF ou une image après…', icon: 'merge', run: () => actions.pickInsert(sel[sel.length - 1] + 1) },
    '-',
    { label: many ? 'Supprimer ces pages' : 'Supprimer la page', icon: 'trash', kbd: 'Suppr', run: () => actions.deletePages(sel) },
  ], { x: e.clientX, y: e.clientY });
}

// ---------- Signets ----------
export async function buildOutline() {
  const box = $('#outline');
  box.innerHTML = '';
  if (!S.doc) return;
  let outline = null;
  try { outline = await S.doc.pdf.getOutline(); } catch {}
  if (!outline?.length) {
    box.append(h('div', { class: 'empty' }, 'Ce document ne contient pas de signets.'));
    return;
  }
  const build = (items, depth) => {
    const wrap = h('div', { class: depth ? 'ol-children' + (depth > 1 ? ' collapsed' : '') : '' });
    for (const it of items) {
      const kids = it.items?.length ? build(it.items, depth + 1) : null;
      const toggle = h('button', { class: 'ol-toggle', html: kids ? icon(depth >= 1 ? 'right' : 'down') : '' });
      const link = h('div', { class: 'ol-link', style: { fontWeight: it.bold ? '600' : '', fontStyle: it.italic ? 'italic' : '' } }, it.title || '(sans titre)');
      link.onclick = () => {
        if (it.dest) S.linkService.goToDestination(it.dest);
        else if (it.url) window.open(it.url, '_blank', 'noopener');
      };
      if (kids) toggle.onclick = () => { kids.classList.toggle('collapsed'); toggle.innerHTML = icon(kids.classList.contains('collapsed') ? 'right' : 'down'); };
      wrap.append(h('div', { class: 'ol-item' }, toggle, link));
      if (kids) wrap.append(kids);
    }
    return wrap;
  };
  box.append(build(outline, 0));
}

// ---------- Liste des annotations ----------
export function buildAnnotList() {
  const box = $('#annotList');
  box.innerHTML = '';
  if (!S.annots.some((a) => a.type !== 'field')) {
    box.append(h('div', { class: 'empty' }, 'Aucune annotation pour le moment. Utilisez les outils de la barre d\'édition.'));
    return;
  }
  const byPage = new Map();
  for (const a of S.annots) {
    if ((a.type === 'whiteout' && a.linked) || a.type === 'field') continue;
    const i = S.pages.findIndex((p) => p.id === a.pageId);
    if (!byPage.has(i)) byPage.set(i, []);
    byPage.get(i).push(a);
  }
  for (const i of [...byPage.keys()].sort((x, y) => x - y)) {
    box.append(h('div', { class: 'al-page' }, `Page ${i + 1}`));
    for (const a of byPage.get(i)) {
      const label = describe(a);
      const item = h('div', { class: 'al-item', 'data-aid': a.id, html: icon(TYPE_ICONS[a.type] || 'info') });
      item.append(h('span', { class: 'al-text' }, label));
      if (a.color) item.append(h('span', { class: 'al-color', style: { background: a.color } }));
      item.onclick = () => actions.focusAnnot(a.id);
      box.append(item);
    }
  }
  markAnnotSel();
}
function describe(a) {
  const t = TYPE_LABELS[a.type] || a.type;
  if (a.type === 'text' || a.type === 'note') return a.text ? `${a.type === 'note' ? '💬 ' : ''}${a.text}` : t;
  if (a.type === 'stamp') return `Tampon « ${a.text} »`;
  if (a.type === 'link') return a.page ? `Lien vers la page ${a.page}` : `Lien ${a.url}`;
  if (a.type === 'markup') return { highlight: 'Surlignage', underline: 'Soulignement', strike: 'Texte barré' }[a.mode];
  if (a.type === 'symbol') return { check: 'Coche ✓', cross: 'Croix ✗', dot: 'Point ●' }[a.kind];
  return t;
}
function markAnnotSel() {
  for (const it of $$('#annotList .al-item')) it.classList.toggle('on', S.selection.has(it.dataset.aid));
}

export { escapeHtml, A };
