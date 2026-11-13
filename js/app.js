// Formagic — contrôleur principal
import { S, on, emit, checkpoint, clearHistory, undo, redo, canUndo, canRedo, setRestoreHandler, defaultDocSettings, markDirty, markSaved } from './state.js';
import {
  $, $$, h, uid, clamp, debounce, toast, openMenu, closeMenu, getSettings, setSetting, hasChrome, readFile, fetchBytes,
  isPdfBytes, fileNameFromUrl, baseName, saveWithPicker, pickSaveFile, writeHandle, downloadBlob, PDF_TYPES, formatBytes, formatDate, relTime,
  sniffImageMime, canvasToBlob, loadImage,
} from './util.js';
import { applyIcons, icon } from './icons.js';
import { createViewer, loadPdf, loadTempPdf, renderPageToCanvas, pdfjsLib, pdfjsViewer, nativeDpr, destroyPdf } from './pdfcore.js';
import * as A from './annotations.js';
import * as SB from './sidebar.js';
import { initProps, render as renderProps } from './props.js';
import * as D from './dialogs.js';
import * as OPS from './pdfops.js';
import * as FD from './formdetect.js';
import * as P from './profile.js';
import { addRecent, getRecent, removeRecent, saveSession, loadSession, deleteSession, idbSet, idbGet, getFileHandle, setFileHandle, getDirHint } from './store.js';
import { bbox, normalize } from './geom.js';

const container = $('#viewerContainer');
const viewerDiv = $('#viewer');
const settings = getSettings();

// ---------- Thème ----------
function applyTheme() {
  const t = settings.theme === 'auto' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : settings.theme;
  document.documentElement.dataset.theme = t;
  $('#btnTheme').innerHTML = icon(t === 'dark' ? 'sun' : 'moon');
  document.body.classList.toggle('night', !!settings.night);
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

applyIcons();
applyTheme();
document.documentElement.style.setProperty('--side-w', (settings.sideWidth || 220) + 'px');

// ---------- Visionneuse ----------
const viewer = createViewer(container, viewerDiv);
A.init(container, viewerDiv);
initProps();

const bus = S.eventBus;
let pendingInit = null;
bus.on('pagesinit', () => {
  const fn = pendingInit;
  pendingInit = null;
  if (fn) fn();
  else viewer.currentScaleValue = settings.defaultZoom || 'auto';
  $('#pageInput').value = viewer.currentPageNumber;
  SB.buildThumbs();
  SB.markCurrent(viewer.currentPageNumber);
});
bus.on('pagechanging', ({ pageNumber }) => {
  $('#pageInput').value = pageNumber;
  SB.markCurrent(pageNumber);
  savePosition();
});
bus.on('scalechanging', ({ scale, presetValue }) => {
  const sel = $('#zoomSelect');
  const opt = $('#zoomCustom');
  if (presetValue && [...sel.options].some((o) => o.value === String(presetValue))) {
    sel.value = String(presetValue);
    opt.hidden = true;
  } else {
    const match = [...sel.options].find((o) => Math.abs(parseFloat(o.value) - scale) < 0.001);
    if (match) { sel.value = match.value; opt.hidden = true; }
    else { opt.textContent = `${Math.round(scale * 100)} %`; opt.hidden = false; sel.value = 'custom'; }
  }
  savePosition();
});

// ---------- Chargement ----------
function showLoading(text, p = null) {
  $('#loading').hidden = false;
  $('#loadingText').textContent = text;
  $('#loadingBar').parentNode.hidden = p == null;
  if (p != null) $('#loadingBar').style.width = Math.round(p * 100) + '%';
}
function hideLoading() { $('#loading').hidden = true; }
async function withLoading(text, fn) {
  showLoading(text);
  try { return await fn((p) => showLoading(text, p)); }
  finally { hideLoading(); }
}

function showWelcome(errorInfo) {
  $('#welcome').hidden = false;
  const card = $('.welcome-card');
  card.querySelector('.load-error')?.remove();
  if (errorInfo) {
    const box = h('div', { class: 'tip load-error', style: { background: 'var(--accent-soft)' } },
      h('b', {}, 'Impossible d\'ouvrir ce document. '), errorInfo.message,
      errorInfo.url ? h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn sm', onclick: () => openUrl(errorInfo.url) }, 'Réessayer'),
        hasChrome && /^https?:/.test(errorInfo.url) ? h('button', { class: 'btn sm', onclick: () => openInChrome(errorInfo.url) }, 'Ouvrir avec le lecteur de Chrome') : null) : null);
    card.insertBefore(box, card.querySelector('.welcome-actions'));
  }
  refreshRecent();
  if (hasChrome && chrome.extension?.isAllowedFileSchemeAccess) {
    chrome.extension.isAllowedFileSchemeAccess((ok) => { $('#fileAccessTip').hidden = ok; });
  }
  document.title = 'Formagic';
}

async function refreshRecent() {
  const list = await getRecent();
  const ul = $('#recentList');
  ul.innerHTML = '';
  $('#recentWrap').hidden = !list.length;
  for (const r of list) {
    const del = h('button', { class: 'ib sm rdel', 'data-icon': 'x', title: 'Retirer de la liste' });
    const li = h('li', { title: r.url || r.name, html: icon(r.url ? 'link' : 'blank') },
      h('span', { class: 'rname' }, r.name), h('span', { class: 'rdate' }, relTime(r.time)), del);
    li.onclick = async (e) => {
      if (del.contains(e.target)) { await removeRecent(r.id); refreshRecent(); return; }
      if (r.url) openUrl(r.url);
      else if (r.handle) {
        try {
          if ((await r.handle.queryPermission?.({ mode: 'read' })) !== 'granted') await r.handle.requestPermission({ mode: 'read' });
          const f = await r.handle.getFile();
          await openBytes(await readFile(f), { name: f.name, handle: r.handle });
        } catch (err) {
          toast('Fichier introuvable ou accès refusé.', { type: 'error' });
        }
      }
    };
    ul.append(li);
  }
}

async function openUrl(url) {
  let hashPage = null;
  const m = /#.*page=(\d+)/.exec(url);
  if (m) hashPage = +m[1];
  try {
    showLoading('Téléchargement du document…', 0);
    const { bytes, filename } = await fetchBytes(url, (p) => showLoading('Téléchargement du document…', p));
    if (!isPdfBytes(bytes)) throw new Error("Le fichier reçu n'est pas un PDF (page de connexion ou lien expiré ?).");
    // Fichier local déjà enregistré une fois depuis Formagic : on retrouve sa poignée pour que Ctrl+S l'écrase
    const handle = /^file:/i.test(url) ? await getFileHandle(url) : null;
    await openBytes(bytes, { name: filename || fileNameFromUrl(url), url, page: hashPage, handle });
  } catch (e) {
    console.error(e);
    hideLoading();
    showWelcome({ message: e.message || String(e), url });
  }
}

function openInChrome(url) {
  chrome.runtime.sendMessage({ type: 'bypass', url }, () => { location.href = url; });
}

async function pageRotations(pdf) {
  return Promise.all([...Array(pdf.numPages).keys()].map((i) => pdf.getPage(i + 1).then((p) => p.rotate)));
}

/** Ouvre un document à partir de ses octets. */
async function openBytes(bytes, info = {}) {
  if (S.dirty && S.doc && !(await D.confirmDialog('Le document actuel contient des modifications non enregistrées. Les abandonner ?', { title: 'Ouvrir un autre document', ok: 'Abandonner', danger: true }))) return false;
  showLoading('Ouverture…');
  let res;
  try {
    res = await loadPdf(bytes, { askPassword: (reason) => { hideLoading(); return D.passwordDialog(reason, info.name); } });
  } catch (e) {
    hideLoading();
    if (e?.name === 'PasswordException' || /password/i.test(e?.message)) { if (!S.doc) showWelcome(); return false; }
    console.error(e);
    showWelcome({ message: e.message || String(e), url: info.url });
    return false;
  }
  const { pdf, password } = res;
  const old = S.doc?.pdf;
  A.resetForNewDocument();
  const rots = await pageRotations(pdf);
  S.doc = {
    bytes, origBytes: bytes, name: info.name || 'document.pdf', url: info.url || null, handle: info.handle || null,
    pdf, password, encrypted: password != null, size: bytes.length,
    sessionKey: (pdf.fingerprints?.[0] || uid()) + ':' + bytes.length,
  };
  S.pages = rots.map((r) => ({ id: uid(), baseRot: r, rot: r }));
  S.annots = [];
  markSaved();
  S.images.clear();
  S.docSettings = defaultDocSettings();
  // Un document protégé reste protégé par le même mot de passe à l'enregistrement (modifiable via ⋮ › Protéger)
  if (password) S.docSettings.protect = { userPassword: password, ownerPassword: '' };
  S.selection.clear();
  S.dirty = !!info.dirty;
  resetFormDetection();
  clearHistory();
  emit('dirty');
  $('#welcome').hidden = true;
  updateTitle();
  const pos = settings.restorePosition ? readPosition() : null;
  pendingInit = () => {
    viewer.currentScaleValue = pos?.scale || settings.defaultZoom || 'auto';
    const page = info.page || pos?.page;
    if (page && page <= pdf.numPages) viewer.currentPageNumber = page;
  };
  viewer.setDocument(pdf);
  S.linkService.setDocument(pdf, null);
  $('#pageCount').textContent = `/ ${pdf.numPages}`;
  destroyPdf(old);
  SB.buildOutline();
  emit('annots');
  hideLoading();
  if (S.tool !== 'select') setTool('select');
  container.focus({ preventScroll: true });

  if (!info.noRecent) {
    addRecent({ id: uid(), name: S.doc.name, url: S.doc.url && !S.doc.url.startsWith('blob:') ? S.doc.url : null, handle: S.doc.handle || null, size: bytes.length });
  }
  if (password != null) toast('Document protégé ouvert. Il restera protégé par le même mot de passe à l’enregistrement (modifiable dans ⋮ › Protéger).');
  if (!info.skipSession) checkSession();
  return true;
}

function updateTitle() {
  const name = S.doc?.name || 'Formagic';
  $('#docTitle').textContent = name;
  $('#docTitle').title = S.doc?.url || name;
  document.title = (S.dirty ? '• ' : '') + name + ' — Formagic';
}

/** Recharge le document après une opération sur les pages (en gardant les annotations). */
async function reloadDocument(bytes, pages, { page } = {}) {
  const keepPage = page ?? viewer.currentPageNumber;
  const keepScale = viewer.currentScaleValue;
  const { pdf } = await loadPdf(bytes, { password: S.doc.password });
  const old = S.doc.pdf;
  const annots = S.annots;
  A.resetForNewDocument();
  S.annots = annots;
  S.doc.pdf = pdf;
  S.doc.bytes = bytes;
  S.pages = pages;
  await new Promise((resolve) => {
    pendingInit = () => {
      viewer.currentScaleValue = keepScale || 'auto';
      viewer.currentPageNumber = clamp(keepPage, 1, pdf.numPages);
      resolve();
    };
    viewer.setDocument(pdf);
    S.linkService.setDocument(pdf, null);
  });
  $('#pageCount').textContent = `/ ${pdf.numPages}`;
  destroyPdf(old);
  SB.buildOutline();
  emit('annots');
}

setRestoreHandler(async (snap) => {
  A.commitEditor();
  // Les champs détectés automatiquement après ce point d'annulation doivent survivre à l'annulation
  const autoFields = S.annots.filter((a) => a.type === 'field' && a.auto);
  if (snap.bytes !== S.doc.bytes) {
    S.annots = snap.annots;
    await reloadDocument(snap.bytes, snap.pages);
  } else {
    const rotChanged = JSON.stringify(snap.pages) !== JSON.stringify(S.pages);
    S.pages = snap.pages;
    S.annots = snap.annots;
    if (rotChanged) A.refreshGeometry();
  }
  const ids = new Set(S.annots.map((a) => a.id));
  const pageIds = new Set(S.pages.map((p) => p.id));
  for (const f of autoFields) if (!ids.has(f.id) && pageIds.has(f.pageId) && !A.wasFieldRemoved(f.id)) S.annots.push(f);
  S.docSettings = snap.docSettings;
  S.selection = new Set([...S.selection].filter((id) => S.annots.some((a) => a.id === id)));
  A.renderAll();
  emit('annots');
  emit('selection');
});

// ---------- Position de lecture ----------
const savePosition = debounce(() => {
  if (!S.doc) return;
  try {
    localStorage.setItem('pa-pos:' + S.doc.sessionKey, JSON.stringify({ page: viewer.currentPageNumber, scale: viewer.currentScaleValue, t: Date.now() }));
  } catch {}
}, 600);
function readPosition() {
  try { return JSON.parse(localStorage.getItem('pa-pos:' + S.doc.sessionKey) || 'null'); } catch { return null; }
}

// ---------- Session (récupération des modifications) ----------
const autosave = debounce(async () => {
  if (!S.doc || !S.dirty) return;
  const used = new Set(S.annots.filter((a) => a.imageId).map((a) => a.imageId));
  const images = [...S.images].filter(([id]) => used.has(id)).map(([id, im]) => ({ id, bytes: im.bytes, mime: im.mime }));
  await saveSession(S.doc.sessionKey, {
    name: S.doc.name, annots: S.annots, pages: S.pages, docSettings: S.docSettings, images,
    bytes: S.doc.bytes !== S.doc.origBytes ? S.doc.bytes : null,
  });
}, 1500);
on('annots', autosave);
on('dirty', () => { $('#dirtyDot').hidden = !S.dirty; updateTitle(); autosave(); });

async function checkSession() {
  const key = S.doc.sessionKey;
  const s = await loadSession(key);
  if (!s || (!s.annots?.length && !s.bytes)) return;
  toast(`Des modifications non enregistrées de ce document ont été retrouvées (${relTime(s.savedAt)}).`, {
    timeout: 12000,
    actions: [
      { label: 'Restaurer', run: () => restoreSession(s) },
      { label: 'Ignorer', run: () => deleteSession(key) },
    ],
  });
}
async function restoreSession(s) {
  checkpoint();
  for (const im of s.images || []) registerImage(im.bytes, im.mime, im.id);
  S.annots = s.annots || [];
  S.docSettings = s.docSettings || defaultDocSettings();
  if (s.bytes) await reloadDocument(s.bytes, s.pages);
  else if (s.pages?.length === S.pages.length) { S.pages = s.pages; A.refreshGeometry(); }
  A.renderAll();
  markDirty();
  emit('annots');
  toast('Modifications restaurées.');
}

// ---------- Images ----------
function registerImage(bytes, mime, id = uid()) {
  if (S.images.has(id)) return id;
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  S.images.set(id, { bytes, mime, url });
  return id;
}
async function imageTemplate(bytes, mime, maxW = 240, maxH = 240) {
  const id = registerImage(bytes, mime);
  const img = await loadImage(S.images.get(id).url);
  const s = Math.min(maxW / img.naturalWidth, maxH / img.naturalHeight, 1);
  return { type: 'image', imageId: id, x: 0, y: 0, w: img.naturalWidth * s || 100, h: img.naturalHeight * s || 100, opacity: 1 };
}

// ---------- Outils ----------
async function setTool(tool) {
  if (!S.doc && tool !== 'select') { toast('Ouvrez d\'abord un document.'); return; }
  A.setTool(tool);
  for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  try {
    if (tool === 'image') {
      const f = await pickFile('#imageInput');
      if (!f) return setTool('select');
      const bytes = await readFile(f);
      A.startPlacement(await imageTemplate(bytes, f.type || sniffImageMime(bytes)));
      toast("Cliquez sur la page pour placer l'image.");
    } else if (tool === 'signature') {
      const sig = await D.signatureDialog();
      if (!sig) return setTool('select');
      const t = await imageTemplate(sig.bytes, 'image/png', 160, 70);
      A.startPlacement(t);
      toast('Cliquez à l\'endroit où signer.');
    } else if (tool === 'stamp') {
      const st = await D.stampDialog();
      if (!st) return setTool('select');
      A.startPlacement({ type: 'stamp', ...st, size: 16, x: 0, y: 0, opacity: A.toolProps.stamp.opacity });
    } else if (tool === 'date') {
      A.startPlacement({ type: 'text', x: 0, y: 0, text: formatDate(), ...A.toolProps.text });
    } else if (['check', 'cross', 'dot'].includes(tool)) {
      const p = A.toolProps.symbol;
      A.startPlacement({ type: 'symbol', kind: tool, x: 0, y: 0, w: p.size, h: p.size, color: p.color }, { repeat: true });
    }
  } catch (e) {
    console.error(e);
    toast('Erreur : ' + e.message, { type: 'error' });
  }
}
on('placed', () => {
  const t = S.tool;
  if (['image', 'signature', 'stamp', 'date'].includes(t)) {
    A.setTool('select');
    for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === 'select');
  }
});
on('tool', (t) => { for (const b of $$('[data-tool]')) b.classList.toggle('active', b.dataset.tool === t); });
on('request-tool', (t) => setTool(t));
on('sign-field', async (f) => {
  try {
    const sig = await D.signatureDialog();
    if (!sig) return;
    A.placeInField(f, await imageTemplate(sig.bytes, sig.mime || 'image/png', 4000, 4000));
  } catch (e) {
    console.error(e);
    toast('Erreur : ' + e.message, { type: 'error' });
  }
});

// ---------- Détection des formulaires ----------
let formScanned = new Set();
let formQueue = [];
let formBusy = false;
let formToastShown = false;
function resetFormDetection() {
  formScanned = new Set();
  formQueue = [];
  formToastShown = false;
  A.resetFieldMemory();
  resetProfileState();
}
const idle = () => new Promise((r) => (window.requestIdleCallback ? requestIdleCallback(r, { timeout: 1200 }) : setTimeout(r, 30)));
/** Analyse une page et ajoute les champs trouvés. Renvoie le nombre de champs ajoutés. */
async function scanPageForFields(pageId, force = false) {
  const pdf = S.doc?.pdf;
  if (!pdf || !S.pages.some((p) => p.id === pageId)) return 0;
  try {
    const g = await A.ensurePageGeom(pageId);
    const meta = S.pages.find((p) => p.id === pageId);
    if (!g || !meta) return 0;
    const found = await FD.detectFields(g.pdfPage, g.vp, meta.baseRot);
    if (S.doc?.pdf !== pdf) { formScanned.delete(pageId); return 0; }
    return A.addDetectedFields(pageId, found, { force });
  } catch (e) {
    console.warn('Détection des champs impossible sur cette page', e);
    return 0;
  }
}
function queueFormScan(pageId) {
  if (!pageId || formScanned.has(pageId)) return;
  formScanned.add(pageId);
  formQueue.push(pageId);
  if (!formBusy) runFormQueue();
}
async function runFormQueue() {
  formBusy = true;
  try {
    while (formQueue.length) {
      const id = formQueue.shift();
      await idle();
      const n = await scanPageForFields(id);
      if (n) onFieldsDetected();
    }
  } finally { formBusy = false; }
}
async function onFieldsDetected() {
  // Vos informations peuvent remplir ce formulaire : cette proposition remplace le message d'aide
  if (await offerAutofill()) { formToastShown = true; return; }
  if (formToastShown || getSettings().showFields === false) return;
  formToastShown = true;
  toast('Formulaire détecté : cliquez dans une zone bleue pour écrire, sur une case pour la cocher, sur une zone jaune pour signer. Tab passe au champ suivant.', {
    timeout: 10000,
    actions: [{ label: 'Ajuster les champs', run: () => setTool('field') }, { label: 'Masquer', run: () => setFieldsVisible(false) }],
  });
}
S.eventBus.on('pagerendered', ({ pageNumber }) => {
  if (!S.doc || getSettings().formDetect === false) return;
  queueFormScan(S.pages[pageNumber - 1]?.id);
});
async function detectAllFields() {
  if (!S.doc) return;
  A.commitEditor();
  let n = 0;
  await withLoading('Recherche des champs de formulaire…', async (p) => {
    for (let i = 0; i < S.pages.length; i++) {
      p(i / S.pages.length);
      formScanned.add(S.pages[i].id);
      n += await scanPageForFields(S.pages[i].id, true);
    }
  });
  if (getSettings().showFields === false) setFieldsVisible(true);
  const total = A.fieldCount();
  toast(n ? `${n} nouveau${n > 1 ? 'x' : ''} champ${n > 1 ? 's' : ''} détecté${n > 1 ? 's' : ''} (${total} au total).`
    : total ? `Aucun nouveau champ (${total} déjà présent${total > 1 ? 's' : ''}). Utilisez l'outil Champs (F) pour en tracer.`
      : 'Aucun champ trouvé. Utilisez l\'outil Champs (F) pour tracer les zones à remplir.');
}
// ---------- Mes informations : mémoriser ce qui est saisi, remplir les prochains formulaires ----------
// Deux cartes en haut à droite : « Mémoriser vos informations ? » et « Remplir avec vos informations ? ».
// Le remplissage n'est jamais silencieux : chaque champ concerné montre un aperçu de la valeur et une
// pastille « Remplir » ; la carte liste tout et propose « Tout remplir ».
const freshProfileState = () => ({
  declined: false, learnDeclined: false, scan: null, done: new Set(), entries: [],
  pending: new Map(), unchecked: new Set(), timer: 0, learnCard: null, fillCard: null, cardTimer: 0,
});
let pf = freshProfileState();
function resetProfileState() {
  clearTimeout(pf.timer); clearTimeout(pf.cardTimer);
  pf.learnCard?.remove(); pf.fillCard?.remove();
  A.setSuggestions([]);
  pf = freshProfileState();
}
const profileEnabled = () => getSettings().profile !== false;

/** Information attendue par un champ ({ key, option? }) ou null. Les colonnes de tableau sont ignorées. */
function profileKeyOf(f) {
  if (f.type !== 'field' || f.native || (f.kind !== 'text' && f.kind !== 'check')) return null;
  let c = P.classifyField(f.label, f.kind);
  if (f.kind === 'check') return c;
  if (!c) c = contextKey(f);
  if (!c) return null;
  // « date et lieu de naissance » posé sur des cases à chiffres : c'est la date (le lieu suit, sur la ligne « à »)
  if (c.key === 'birthDatePlace' && f.comb?.length) c = { key: 'birthDate' };
  const column = S.annots.some((o) => o !== f && o.type === 'field' && o.pageId === f.pageId &&
    Math.abs(o.x - f.x) < 2 && Math.abs(o.w - f.w) < 2 && o.y > f.y && o.y - (f.y + f.h) < 4);
  return column ? null : c;
}
/**
 * Champ sans libellé parlant, compris d'après le champ qui le précède :
 * « Vos date et lieu de naissance : |__|__|… » puis, ligne suivante, « à ______ » → lieu de naissance.
 */
function contextKey(f) {
  if (!/^\s*(a|à|né\(?e?\)? à|née? à|lieu)\s*:?\s*$/i.test(f.label || '')) return null;
  const list = fieldsInReadingOrder();
  const prev = list[list.indexOf(f) - 1];
  if (!prev || prev.pageId !== f.pageId || f.y - (prev.y + prev.h) > 30) return null;
  const pc = P.classifyField(prev.label, prev.kind);
  if (pc && (pc.key === 'birthDatePlace' || pc.key === 'birthDate')) return { key: 'birthPlace' };
  return null;
}
const slotOf = (c) => c.key + (c.option ? ':' + c.option : '');
function fieldsInReadingOrder() {
  const idx = new Map(S.pages.map((p, i) => [p.id, i]));
  return S.annots.filter((a) => a.type === 'field' && idx.has(a.pageId))
    .sort((p, q) => idx.get(p.pageId) - idx.get(q.pageId) || (Math.abs(p.y - q.y) > 4 ? p.y - q.y : p.x - q.x));
}
/** Champs vides à remplir : seulement la 1re occurrence de chaque information (un second partenaire, un tiers… restent vides). */
function autofillCandidates(profile) {
  const vals = P.fillValues(profile);
  const seen = new Set();
  const out = [];
  for (const f of fieldsInReadingOrder()) {
    const c = profileKeyOf(f);
    if (!c || seen.has(slotOf(c))) continue;
    seen.add(slotOf(c));
    if (pf.done.has(f.id) || !vals[c.key] || !A.isFieldEmpty(f)) continue;
    if (c.option) { if (vals[c.key] === c.option) out.push({ field: f, key: c.key, value: true, display: `☑ ${c.option}` }); continue; }
    const value = P.valueForField(c.key, vals[c.key], A.combSize(f));
    out.push({ field: f, key: c.key, value, display: vals[c.key].length <= 40 ? vals[c.key] : value });
  }
  return out;
}
/** Analyse les pages pas encore vues (la 1re occurrence d'une information doit être connue avant de proposer). */
async function scanRemainingPages(max = 40) {
  if (S.pages.length > max) return;
  const pdf = S.doc?.pdf;
  for (const p of S.pages.slice()) {
    if (S.doc?.pdf !== pdf) return;
    if (formScanned.has(p.id)) continue;
    formScanned.add(p.id);
    await scanPageForFields(p.id);
  }
  // pages déjà en file d'attente d'analyse : attendre qu'elles soient faites
  for (let k = 0; k < 300 && (formBusy || formQueue.length) && S.doc?.pdf === pdf; k++) await new Promise((r) => setTimeout(r, 100));
}

// ----- Cartes en haut à droite -----
function profileCard(slot, { icon: ic, title, onClose }) {
  let el = pf[slot];
  $('#cards').style.top = Math.max(60, container.getBoundingClientRect().top + 12) + 'px'; // sous les barres d'outils affichées
  if (!el?.isConnected) {
    el = h('div', { class: 'pcard', role: 'dialog', 'aria-label': title });
    $('#cards').append(el);
    pf[slot] = el;
  }
  el.replaceChildren(h('div', { class: 'pcard-head' },
    h('span', { class: 'ic', 'aria-hidden': 'true' }, ic), h('span', {}, title),
    h('button', { class: 'x', title: 'Fermer', onclick: onClose }, '×')));
  return el;
}
function closeCard(slot) { pf[slot]?.remove(); pf[slot] = null; }
const plural = (n, s, p = s + 's') => (n > 1 ? p : s);
const pageNo = (f) => S.pages.findIndex((p) => p.id === f.pageId) + 1;

// ----- Remplir : suggestions visibles dans le document -----
function liveEntries() {
  return pf.entries.filter((e) => !pf.done.has(e.field.id) && S.annots.includes(e.field) && A.isFieldEmpty(e.field));
}
function showSuggestions(entries) {
  pf.entries = entries;
  A.setSuggestions(entries.map((e) => ({
    field: e.field, value: e.value, title: P.keyLabel(e.key),
    onAccept: () => acceptSuggestions([e]),
    onReject: () => { pf.done.add(e.field.id); refreshSuggestions(); },
  })));
  renderFillCard();
}
function refreshSuggestions() {
  if (!pf.entries.length && !pf.fillCard) return;
  showSuggestions(liveEntries());
}
on('annots', () => { if (pf.entries.length) refreshSuggestionsSoon(); });
const refreshSuggestionsSoon = debounce(refreshSuggestions, 150);

function acceptSuggestions(list) {
  A.commitEditor();
  for (const e of list) pf.done.add(e.field.id);
  const n = A.autofillFields(list);
  refreshSuggestions();
  return n;
}
function renderFillCard() {
  const list = pf.entries;
  if (!list.length) { closeCard('fillCard'); return; }
  const dismiss = () => { pf.declined = true; showSuggestions([]); };
  const el = profileCard('fillCard', { icon: '✨', title: 'Remplir avec vos informations ?', onClose: dismiss });
  const n = list.length;
  el.append(
    h('p', { class: 'pcard-sub' }, `${n} ${plural(n, 'champ')} de ce document ${plural(n, 'correspond', 'correspondent')} à vos informations. `,
      `${plural(n, 'Il est encadré', 'Ils sont encadrés')} en violet avec un aperçu : cliquez sur une ligne pour ${plural(n, 'le', 'les')} voir, « Remplir » sous un champ pour le remplir seul.`),
    h('ul', { class: 'pcard-list' }, list.map((e) => h('li', { class: 'link', title: 'Afficher ce champ dans le document', onclick: () => A.revealField(e.field.id) },
      h('span', { class: 'k' }, P.keyLabel(e.key)),
      h('span', { class: 'v' }, e.display),
      h('span', { class: 'pg' }, `p. ${pageNo(e.field)}`),
      h('button', { class: 'rm', title: 'Ne pas remplir ce champ', onclick: (ev) => { ev.stopPropagation(); pf.done.add(e.field.id); refreshSuggestions(); } }, '×')))),
    h('div', { class: 'pcard-actions' },
      h('button', { onclick: dismiss }, 'Ignorer'),
      h('button', { class: 'primary', onclick: () => {
        const k = acceptSuggestions(list.slice());
        if (k) toast(`${k} ${plural(k, 'champ rempli', 'champs remplis')} avec vos informations. Ctrl+Z pour annuler.`);
      } }, n > 1 ? `Tout remplir (${n})` : 'Remplir')),
  );
}
/** Propose de remplir le formulaire. Renvoie true si une proposition est (ou a été) faite. */
async function offerAutofill() {
  if (!S.doc || !profileEnabled() || pf.declined) return false;
  const pdf = S.doc.pdf;
  const profile = await P.getProfile();
  if (!Object.keys(profile).length) return false;
  pf.scan ||= scanRemainingPages();
  await pf.scan;
  if (S.doc?.pdf !== pdf || pf.declined) return false;
  const entries = autofillCandidates(profile);
  // rien que la date du jour ou le lieu de signature : pas de quoi proposer
  if (!pf.fillCard && !entries.some((e) => !['today', 'signPlace'].includes(e.key))) return false;
  showSuggestions(entries);
  return true;
}
async function fillWithProfile() {
  if (!S.doc) return;
  A.commitEditor();
  const profile = await P.getProfile();
  if (!Object.keys(profile).length) { editProfile(); return; }
  pf.declined = false;
  pf.done.clear();
  await scanRemainingPages(200);
  const entries = autofillCandidates(profile);
  if (!entries.length) { toast('Aucun champ vide correspondant à vos informations dans ce document.'); return; }
  showSuggestions(entries);
  A.revealField(entries[0].field.id);
}
async function editProfile() {
  const r = await D.profileDialog(await P.getProfile(), profileEnabled());
  if (!r) return;
  setSetting('profile', r.enabled);
  if (!r.enabled) { showSuggestions([]); closeCard('learnCard'); }
  if (r.clear) { await P.saveProfile({}); toast('Vos informations ont été effacées.'); return; }
  await P.saveProfile(r.values);
  toast('Vos informations sont enregistrées (uniquement sur cet ordinateur).');
}

// ----- Mémoriser : une valeur saisie dans un champ reconnu -----
on('field-filled', ({ field, value }) => {
  if (!profileEnabled() || pf.learnDeclined) return;
  const c = profileKeyOf(field);
  if (!c) return;
  const learned = P.learnValues(c.key, c.option ? (value === true ? c.option : '') : value);
  if (!Object.keys(learned).length) return;
  // seule la 1re occurrence d'une information concerne la personne qui remplit (pas le second partenaire…)
  const first = fieldsInReadingOrder().find((f) => { const o = profileKeyOf(f); return o && slotOf(o) === slotOf(c); });
  if (first && first !== field) return;
  for (const [k, v] of Object.entries(learned)) pf.pending.set(k, v);
  clearTimeout(pf.timer);
  pf.timer = setTimeout(proposeLearn, 700);
});
async function proposeLearn() {
  const profile = await P.getProfile();
  const changes = [...pf.pending].filter(([k, v]) => profile[k] !== v);
  if (!changes.length) { pf.pending.clear(); if (pf.learnCard && !pf.learnCard.dataset.done) closeCard('learnCard'); return; }
  clearTimeout(pf.cardTimer);
  const update = changes.every(([k]) => profile[k]);
  const later = () => { pf.pending.clear(); pf.unchecked.clear(); closeCard('learnCard'); };
  const el = profileCard('learnCard', { icon: '💾', title: update ? 'Mettre à jour vos informations ?' : 'Mémoriser vos informations ?', onClose: later });
  delete el.dataset.done;
  const checked = () => changes.filter(([k]) => !pf.unchecked.has(k));
  const okBtn = h('button', { class: 'primary' }, update ? 'Mettre à jour' : 'Mémoriser');
  const sync = () => { const k = checked().length; okBtn.disabled = !k; };
  okBtn.onclick = async () => {
    const keep = checked();
    await P.mergeProfile(Object.fromEntries(keep));
    for (const [k] of changes) pf.pending.delete(k);
    pf.unchecked.clear();
    const done = profileCard('learnCard', { icon: '✅', title: 'C’est noté !', onClose: () => closeCard('learnCard') });
    done.dataset.done = '1';
    done.append(h('p', { class: 'pcard-sub' }, `${keep.length} ${plural(keep.length, 'information mémorisée', 'informations mémorisées')}, uniquement sur cet ordinateur. `,
      'Elles vous seront proposées sur vos prochains formulaires (menu ⋮ › Formulaire › Mes informations… pour les modifier).'));
    pf.cardTimer = setTimeout(() => closeCard('learnCard'), 5000);
  };
  el.append(
    h('p', { class: 'pcard-sub' }, 'Formagic a reconnu ce que vous venez de saisir. Mémorisez-le pour remplir vos prochains PDF en un clic : ',
      h('b', {}, 'les données restent uniquement sur cet ordinateur.')),
    h('ul', { class: 'pcard-list' }, changes.map(([k, v]) => {
      const cb = h('input', { type: 'checkbox', checked: !pf.unchecked.has(k), 'aria-label': P.keyLabel(k) });
      cb.onchange = () => { if (cb.checked) pf.unchecked.delete(k); else pf.unchecked.add(k); sync(); };
      return h('li', {}, h('label', { style: { display: 'contents', cursor: 'pointer' } }, cb,
        h('span', { class: 'k' }, P.keyLabel(k)),
        h('span', { class: 'v', title: v }, v, profile[k] ? h('span', { class: 'old', title: 'Valeur mémorisée actuellement' }, 'avant : ' + profile[k]) : null)));
    })),
    h('div', { class: 'pcard-actions' },
      h('button', { onclick: () => { pf.learnDeclined = true; later(); }, title: 'Ne plus proposer pour ce document' }, 'Non merci'),
      okBtn),
  );
  sync();
}

function setFieldsVisible(v) {
  setSetting('showFields', v);
  A.renderAll();
  if (!v) toast('Zones de champ masquées. Menu ⋮ › Afficher les zones de champ pour les revoir.');
}
function removeDetectedFields() {
  const ids = S.annots.filter((a) => a.type === 'field').map((a) => a.id);
  if (!ids.length) { toast('Aucun champ à supprimer.'); return; }
  A.removeAnnots(ids);
  toast(`${ids.length} zone${ids.length > 1 ? 's' : ''} de champ supprimée${ids.length > 1 ? 's' : ''} (le texte saisi est conservé).`, { actions: [{ label: 'Annuler', run: () => undo() }] });
}
on('hint', (msg) => toast(msg));

function pickFile(sel, multiple = false) {
  return new Promise((resolve) => {
    const input = $(sel);
    input.value = '';
    input.multiple = multiple;
    const done = () => { window.removeEventListener('focus', onFocus); };
    const onFocus = () => setTimeout(() => { if (!input.files.length) { done(); resolve(null); } }, 400);
    input.onchange = () => { done(); resolve(multiple ? [...input.files] : input.files[0] || null); };
    window.addEventListener('focus', onFocus);
    input.click();
  });
}

for (const b of $$('[data-tool]')) b.addEventListener('click', () => setTool(b.dataset.tool));

// Liens / tampons / rognage demandés par la couche d'annotations
on('request-link', async ({ pageId, rect }) => {
  const r = await D.linkDialog({}, S.pages.length);
  if (!r) return;
  A.addAnnot({ type: 'link', pageId, ...rect, ...r });
});
on('edit-link', async (a) => {
  const r = await D.linkDialog(a, S.pages.length);
  if (!r) return;
  checkpoint();
  delete a.url; delete a.page;
  Object.assign(a, r);
  A.renderOverlay(a.pageId);
  emit('annots');
});
on('edit-stamp', async (a) => {
  const r = await D.stampDialog(a);
  if (!r) return;
  checkpoint();
  Object.assign(a, r);
  normalize(a);
  A.renderOverlay(a.pageId);
  emit('annots');
});
on('request-crop', async ({ pageId, rect }) => {
  const choice = await D.choiceDialog('Rogner', 'Appliquer le rognage à :', [{ label: 'Toutes les pages', value: 'all' }, { label: 'Cette page', value: 'one' }]);
  if (!choice) return;
  const idx = S.pages.findIndex((p) => p.id === pageId);
  await cropPages(choice === 'all' ? S.pages.map((_, i) => i) : [idx], rect);
});

// ---------- Opérations sur les pages ----------
const norm = (r) => (((r % 360) + 360) % 360);

async function bakedBytes() {
  if (S.doc.pdf.annotationStorage?.size > 0) {
    try { return await S.doc.pdf.saveDocument(); } catch (e) { console.warn(e); }
  }
  return S.doc.bytes;
}

async function applyPlan(plan, newPages, { ext = [], page, label = 'Mise à jour des pages…' } = {}) {
  await withLoading(label, async () => {
    const bytes = await bakedBytes();
    checkpoint();
    const out = await OPS.rebuildPages(bytes, S.doc.password, plan, ext);
    const keep = new Set(newPages.map((p) => p.id));
    S.annots = S.annots.filter((a) => keep.has(a.pageId));
    await reloadDocument(out, newPages, { page });
  });
}

async function rotatePages(indices, delta) {
  if (!S.doc) return;
  const set = new Set(indices);
  const plan = S.pages.map((m, i) => ({ src: 'self', index: i, rot: set.has(i) ? norm(m.rot + delta) : m.rot }));
  const pages = S.pages.map((m, i) => ({ ...m, rot: plan[i].rot }));
  await applyPlan(plan, pages, { label: 'Rotation…' });
  SB.setSelectedPages(indices);
}

async function deletePages(indices) {
  if (!S.doc) return;
  const set = new Set(indices);
  if (set.size >= S.pages.length) { toast('Impossible de supprimer toutes les pages.', { type: 'error' }); return; }
  const plan = [], pages = [];
  S.pages.forEach((m, i) => { if (!set.has(i)) { plan.push({ src: 'self', index: i, rot: m.rot }); pages.push(m); } });
  await applyPlan(plan, pages, { page: Math.min(...indices) + 1, label: 'Suppression…' });
  SB.setSelectedPages([]);
  toast(`${set.size} page${set.size > 1 ? 's supprimées' : ' supprimée'}.`, { actions: [{ label: 'Annuler', run: () => undo() }] });
}

async function duplicatePages(indices) {
  const set = new Set(indices);
  const plan = [], pages = [], copies = [];
  S.pages.forEach((m, i) => {
    plan.push({ src: 'self', index: i, rot: m.rot });
    pages.push(m);
    if (set.has(i)) {
      const nm = { ...m, id: uid() };
      plan.push({ src: 'self', index: i, rot: m.rot });
      pages.push(nm);
      copies.push([m.id, nm.id]);
    }
  });
  await applyPlan(plan, pages, { label: 'Duplication…' });
  // dupliquer aussi les annotations
  for (const [from, to] of copies) {
    for (const a of S.annots.filter((x) => x.pageId === from)) S.annots.push({ ...structuredClone(a), id: uid(), pageId: to });
  }
  A.renderAll();
  emit('annots');
}

async function movePages(indices, target) {
  const set = new Set(indices);
  const moving = S.pages.map((m, i) => i).filter((i) => set.has(i));
  const before = moving.filter((i) => i < target).length;
  const rest = S.pages.map((m, i) => i).filter((i) => !set.has(i));
  const at = target - before;
  const order = [...rest.slice(0, at), ...moving, ...rest.slice(at)];
  if (order.every((v, i) => v === i)) return;
  const plan = order.map((i) => ({ src: 'self', index: i, rot: S.pages[i].rot }));
  const pages = order.map((i) => S.pages[i]);
  await applyPlan(plan, pages, { page: at + 1, label: 'Réorganisation…' });
  SB.setSelectedPages(moving.map((_, k) => at + k));
}

async function insertBlank(at) {
  const ref = S.pages[Math.max(0, Math.min(at - 1, S.pages.length - 1))];
  const g = ref ? await A.ensurePageGeom(ref.id) : null;
  let size = g ? [g.baseW, g.baseH] : [595.28, 841.89];
  const plan = S.pages.map((m, i) => ({ src: 'self', index: i, rot: m.rot }));
  const pages = [...S.pages];
  plan.splice(at, 0, { blank: size, rot: 0 });
  pages.splice(at, 0, { id: uid(), baseRot: 0, rot: 0 });
  await applyPlan(plan, pages, { page: at + 1, label: 'Insertion…' });
}

/** Insère des PDF et/ou des images à la position donnée */
async function insertFiles(files, at = S.pages.length) {
  if (!S.doc) return openFiles(files);
  const ext = [];
  try {
    await withLoading('Préparation des fichiers…', async () => {
      const images = [];
      for (const f of files) {
        const bytes = await readFile(f);
        if (isPdfBytes(bytes)) ext.push(bytes);
        else if (/^image\//.test(f.type || sniffImageMime(bytes))) images.push({ bytes, mime: f.type || sniffImageMime(bytes) });
      }
      if (images.length) ext.push(await OPS.imagesToPdf(images, { fit: 'a4' }));
    });
  } catch (e) { toast('Fichier illisible : ' + e.message, { type: 'error' }); return; }
  if (!ext.length) { toast('Aucun PDF ni image reconnu.', { type: 'error' }); return; }
  const plan = S.pages.map((m, i) => ({ src: 'self', index: i, rot: m.rot }));
  const pages = [...S.pages];
  const add = [], addPages = [];
  for (let k = 0; k < ext.length; k++) {
    let rots;
    try { rots = await OPS.pageRotations(ext[k]); } catch (e) { toast('Un des PDF est protégé ou endommagé : ' + e.message, { type: 'error' }); return; }
    rots.forEach((r, j) => { add.push({ src: 'ext', doc: k, index: j, rot: r }); addPages.push({ id: uid(), baseRot: r, rot: r }); });
  }
  plan.splice(at, 0, ...add);
  pages.splice(at, 0, ...addPages);
  await applyPlan(plan, pages, { ext, page: at + 1, label: 'Fusion…' });
  toast(`${add.length} page${add.length > 1 ? 's ajoutées' : ' ajoutée'}.`);
}
async function pickInsert(at) {
  const files = await pickFile('#fileInput', true);
  if (files?.length) insertFiles(files, at);
}

async function cropPages(indices, rect) {
  await withLoading('Rognage…', async () => {
    const bytes = await bakedBytes();
    checkpoint();
    const doc = await OPS.loadLibDoc(bytes, S.doc.password);
    for (const i of indices) {
      const meta = S.pages[i];
      const g = await A.ensurePageGeom(meta.id);
      const r = { x: clamp(rect.x, 0, g.baseW), y: clamp(rect.y, 0, g.baseH) };
      r.w = clamp(rect.w, 1, g.baseW - r.x);
      r.h = clamp(rect.h, 1, g.baseH - r.y);
      const [x0, y0, x1, y1] = OPS.baseRectToUser(g.vp, r);
      doc.getPage(i).setCropBox(x0, y0, x1 - x0, y1 - y0);
      for (const a of S.annots) if (a.pageId === meta.id) A.translateAnnotPublic(a, -r.x, -r.y);
    }
    const out = await doc.save({ addDefaultPage: false, useObjectStreams: false });
    await reloadDocument(out, S.pages.map((p) => ({ ...p })));
  });
  setTool('select');
}

async function extractPages(indices) {
  const bytes = await withLoading('Extraction…', (p) => OPS.exportPdf({ pagesSubset: indices, onProgress: p }));
  const label = indices.length === 1 ? `page ${indices[0] + 1}` : `pages ${compactRanges(indices)}`;
  await saveBytes(bytes, `${baseName(S.doc.name)} (${label}).pdf`);
}
function compactRanges(list) {
  const out = [];
  let s = null, prev = null;
  for (const i of [...list].sort((a, b) => a - b)) {
    if (s === null) { s = prev = i; continue; }
    if (i === prev + 1) { prev = i; continue; }
    out.push(s === prev ? `${s + 1}` : `${s + 1}-${prev + 1}`);
    s = prev = i;
  }
  if (s !== null) out.push(s === prev ? `${s + 1}` : `${s + 1}-${prev + 1}`);
  return out.join(',');
}

SB.initSidebar({
  goToPage: (n) => { viewer.currentPageNumber = n; },
  rotatePages, deletePages, duplicatePages, movePages, insertBlank, insertFiles, pickInsert, extractPages,
  exportImages: (sel) => exportImages(sel),
  focusAnnot: (id) => focusAnnot(id),
  sideResized: (w) => setSetting('sideWidth', w),
});

function focusAnnot(id) {
  const a = S.annots.find((x) => x.id === id);
  if (!a) return;
  const idx = S.pages.findIndex((p) => p.id === a.pageId);
  if (S.tool !== 'select') setTool('select');
  const b = bbox(a);
  viewer.scrollPageIntoView({ pageNumber: idx + 1 });
  setTimeout(() => {
    const el = viewerDiv.querySelector(`[data-aid="${id}"]`);
    el?.scrollIntoView({ block: 'center', inline: 'nearest' });
    A.setSelection([id]);
    if (a.type === 'note') setTimeout(() => el?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })), 50);
  }, 80);
  void b;
}

// ---------- Enregistrement ----------
function suggestedName(suffix = '') {
  const n = baseName(S.doc?.name || 'document');
  return n + suffix + '.pdf';
}

async function saveBytes(bytes, name) {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const r = await saveWithPicker(blob, name, PDF_TYPES);
  if (r === 'cancel') return null;
  toast(`Enregistré : ${r?.name || name} (${formatBytes(bytes.length)})`);
  return r || true;
}

async function save({ as = false, flatten = false } = {}) {
  if (!S.doc) return;
  A.commitEditor();
  const doc = S.doc;
  const isLocal = /^file:/i.test(doc.url || '');
  // 1) Destination, choisie AVANT de générer le PDF : les autorisations de Chrome exigent un geste
  //    récent de l'utilisateur, qui aurait expiré après une longue génération.
  let target = null, picked = false;
  if (!as && !flatten && doc.handle) {
    try {
      let perm = await doc.handle.queryPermission?.({ mode: 'readwrite' });
      if (perm !== 'granted') perm = await doc.handle.requestPermission({ mode: 'readwrite' });
      if (perm === 'granted') target = doc.handle;
    } catch (e) { console.warn(e); }
  }
  if (!target) {
    const first = !as && !flatten && isLocal && !doc.handle;
    if (first) toast('Chrome ne laisse pas une extension modifier un fichier ouvert par son adresse : sélectionnez une fois ce même fichier pour l’écraser. Les Ctrl+S suivants l’enregistreront directement.', { timeout: 9000 });
    const hint = doc.handle || (isLocal ? await getDirHint(doc.url) : null);
    const r = await pickSaveFile(suggestedName(flatten ? ' (aplati)' : ''), PDF_TYPES, hint);
    if (r === 'cancel') return;
    target = r; // null : téléchargement
    picked = true;
  }
  // Fichier désigné = fichier d'origine (file:///) ? Le sélecteur ne donne pas de chemin : on le vérifie
  // au contenu, AVANT de l'écraser (même nom ET mêmes octets que le fichier ouvert par son chemin).
  let sameFile = false;
  if (picked && target && !flatten && isLocal && target.name.toLowerCase() === fileNameFromUrl(doc.url).toLowerCase()) {
    try {
      const f = await target.getFile();
      const orig = doc.origBytes;
      if (orig?.length && f.size === orig.length) {
        const cur = new Uint8Array(await f.arrayBuffer());
        sameFile = cur.every((b, i) => b === orig[i]);
      }
    } catch (e) { console.warn(e); }
  }
  // 2) Génération et écriture
  const savedAnnots = structuredClone(S.annots); // état réellement écrit (des retouches pendant l'export restent « non enregistrées »)
  let bytes;
  try {
    bytes = await withLoading('Enregistrement…', (p) => OPS.exportPdf({ flattenForms: flatten, onProgress: p }));
    const blob = new Blob([bytes], { type: 'application/pdf' });
    if (target) await writeHandle(target, blob);
    else downloadBlob(blob, suggestedName(flatten ? ' (aplati)' : ''));
  } catch (e) {
    console.error(e);
    toast("L'enregistrement a échoué : " + e.message, { type: 'error', timeout: 8000 });
    return;
  }
  if (S.doc !== doc) return;
  if (picked && target && !flatten) {
    // Le fichier d'origine a été désigné : il sera réécrit directement, y compris à la prochaine ouverture
    if (sameFile) setFileHandle(doc.url, target);
    doc.handle = target;
    doc.name = target.name;
    // le fichier d'origine réécrit reste une seule ligne des récents (chemin + poignée)
    addRecent({ id: uid(), name: target.name, handle: target, url: sameFile ? doc.url : null, size: bytes.length });
  }
  if (!flatten) {
    S.dirty = false;
    emit('dirty');
    markSaved(savedAnnots);
    deleteSession(doc.sessionKey);
  }
  updateTitle();
  toast(`Enregistré : ${target?.name || doc.name} (${formatBytes(bytes.length)})`);
}

async function exportImages(indices) {
  if (!S.doc) return;
  const bytes = await withLoading('Préparation…', () => OPS.exportPdf({ noEncrypt: true }));
  const pdf = await loadTempPdf(bytes);
  const files = [];
  await withLoading('Export des images…', async (p) => {
    for (let k = 0; k < indices.length; k++) {
      p(k / indices.length);
      const page = await pdf.getPage(indices[k] + 1);
      const c = await renderPageToCanvas(page, 200 / 72, undefined, { annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE });
      files.push({ name: `${baseName(S.doc.name)} - page ${indices[k] + 1}.png`, blob: await canvasToBlob(c, 'image/png') });
    }
  });
  destroyPdf(pdf);
  await saveMany(files, 'image/png');
}

async function saveMany(files, mime) {
  if (files.length === 1) {
    const ext = files[0].name.split('.').pop();
    const r = await saveWithPicker(files[0].blob, files[0].name, [{ description: ext.toUpperCase(), accept: { [mime]: ['.' + ext] } }]);
    if (r !== 'cancel') toast('Fichier enregistré.');
    return;
  }
  if (window.showDirectoryPicker) {
    let dir;
    try { dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
    for (const f of files) {
      const fh = await dir.getFileHandle(f.name, { create: true });
      const w = await fh.createWritable();
      await w.write(f.blob);
      await w.close();
    }
    toast(`${files.length} fichiers enregistrés dans « ${dir.name} ».`);
  } else {
    for (const f of files) downloadBlob(f.blob, f.name);
  }
}

async function exportText() {
  const pdf = S.doc.pdf;
  let out = '';
  await withLoading('Extraction du texte…', async (p) => {
    for (let i = 1; i <= pdf.numPages; i++) {
      p(i / pdf.numPages);
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      let line = '';
      const lines = [];
      for (const it of tc.items) {
        line += it.str ?? '';
        if (it.hasEOL) { lines.push(line); line = ''; }
      }
      if (line) lines.push(line);
      out += `\n\n——— Page ${i} ———\n\n` + lines.join('\n');
    }
  });
  const blob = new Blob([out.trim() + '\n'], { type: 'text/plain;charset=utf-8' });
  const r = await saveWithPicker(blob, baseName(S.doc.name) + '.txt', [{ description: 'Texte', accept: { 'text/plain': ['.txt'] } }]);
  if (r !== 'cancel') toast('Texte exporté.');
}

async function splitDocument() {
  const groups = await D.splitDialog(S.pages.length);
  if (!groups) return;
  const bytes = await withLoading('Préparation…', () => OPS.exportPdf({ noEncrypt: true }));
  const parts = await withLoading('Découpage…', () => OPS.splitPdf(bytes, groups));
  await saveMany(parts.map((b, k) => ({ name: `${baseName(S.doc.name)} - partie ${k + 1} (p. ${compactRanges(groups[k])}).pdf`, blob: new Blob([b], { type: 'application/pdf' }) })), 'application/pdf');
}

// ---------- Impression ----------
async function printDoc() {
  if (!S.doc) return;
  A.commitEditor();
  const pc = $('#printContainer');
  try {
    const bytes = await withLoading('Préparation de l\'impression…', () => OPS.exportPdf({ noEncrypt: true }));
    const pdf = await loadTempPdf(bytes);
    pc.innerHTML = '';
    const urls = [];
    const sizes = new Map(); // "LxH" -> nom de page CSS (pages de formats différents, paysage…)
    await withLoading('Préparation de l\'impression…', async (p) => {
      for (let i = 1; i <= pdf.numPages; i++) {
        p(i / pdf.numPages);
        const page = await pdf.getPage(i);
        const vp = page.getViewport({ scale: 1 });
        const key = `${Math.round(vp.width * 10) / 10}pt ${Math.round(vp.height * 10) / 10}pt`;
        if (!sizes.has(key)) sizes.set(key, 'pa' + sizes.size);
        const c = await renderPageToCanvas(page, 150 / 72, undefined, { annotationMode: pdfjsLib.AnnotationMode.ENABLE_STORAGE });
        const blob = await canvasToBlob(c, 'image/jpeg', 0.92);
        const u = URL.createObjectURL(blob);
        urls.push(u);
        // Une feuille = une boîte de la hauteur exacte de la page ; l'image s'y ajuste sans jamais déborder
        // (un débordement d'une fraction de pixel suffisait à créer une page blanche entre chaque page)
        // (dimensions en points et non en vw/vh : en impression, vh suit toujours le format de la 1re page)
        pc.append(h('div', { class: 'psheet', style: { page: sizes.get(key), width: `${Math.floor(vp.width) - 1}pt`, height: `${Math.floor(vp.height) - 1}pt` } }, h('img', { src: u })));
      }
    });
    destroyPdf(pdf);
    let style = $('#printPageStyle');
    if (!style) { style = h('style', { id: 'printPageStyle' }); document.head.append(style); }
    const first = [...sizes.keys()][0];
    style.textContent = `@page { size: ${first}; margin: 0; }\n` +
      [...sizes].map(([size, name]) => `@page ${name} { size: ${size}; margin: 0; }`).join('\n');
    await Promise.all([...pc.querySelectorAll('img')].map((im) => im.decode().catch(() => {})));
    const cleanup = () => { pc.innerHTML = ''; urls.forEach((u) => URL.revokeObjectURL(u)); window.removeEventListener('afterprint', cleanup); };
    window.addEventListener('afterprint', cleanup);
    window.print();
  } catch (e) {
    console.error(e);
    toast("Impression impossible : " + e.message, { type: 'error' });
  }
}

// ---------- Recherche ----------
const findInput = $('#findInput');
function openFind() {
  if (!S.doc) return;
  $('#findbar').hidden = false;
  const sel = getSelection()?.toString().trim();
  if (sel && sel.length < 80 && !sel.includes('\n')) findInput.value = sel;
  findInput.focus();
  findInput.select();
  if (findInput.value) doFind('');
}
function closeFind() {
  $('#findbar').hidden = true;
  bus.dispatch('findbarclose', { source: null });
  container.focus({ preventScroll: true });
}
function doFind(type, prev = false) {
  bus.dispatch('find', {
    source: null, type, query: findInput.value, caseSensitive: $('#findCase').checked, entireWord: $('#findWord').checked,
    highlightAll: true, findPrevious: prev, matchDiacritics: $('#findDiac').checked,
  });
}
findInput.addEventListener('input', () => doFind(''));
findInput.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.key === 'Enter') { e.preventDefault(); doFind('again', e.shiftKey); }
  else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
});
for (const id of ['#findCase', '#findWord', '#findDiac']) $(id).addEventListener('change', () => doFind('casesensitivitychange'));
$('#findNext').onclick = () => doFind('again', false);
$('#findPrev').onclick = () => doFind('again', true);
$('#findClose').onclick = closeFind;
$('#btnSearch').onclick = () => ($('#findbar').hidden ? openFind() : closeFind());
bus.on('updatefindmatchescount', ({ matchesCount }) => updateFindCount(matchesCount));
bus.on('updatefindcontrolstate', ({ state, matchesCount }) => {
  findInput.classList.toggle('notfound', state === 1 && !!findInput.value);
  if (matchesCount) updateFindCount(matchesCount);
});
function updateFindCount({ current, total }) {
  $('#findCount').textContent = !findInput.value ? '' : total ? `${current} / ${total}` : 'Aucun résultat';
}

// ---------- Zoom & navigation ----------
$('#zoomSelect').addEventListener('change', (e) => {
  const v = e.target.value;
  if (v !== 'custom') viewer.currentScaleValue = v;
  container.focus({ preventScroll: true });
});
$('#btnZoomIn').onclick = () => viewer.increaseScale();
$('#btnZoomOut').onclick = () => viewer.decreaseScale();
$('#btnPrev').onclick = () => viewer.previousPage();
$('#btnNext').onclick = () => viewer.nextPage();
$('#pageInput').addEventListener('change', (e) => {
  const n = parseInt(e.target.value, 10);
  if (n >= 1 && n <= viewer.pagesCount) viewer.currentPageNumber = n;
  else e.target.value = viewer.currentPageNumber;
});
$('#pageInput').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') e.target.blur(); });
$('#pageInput').addEventListener('focus', (e) => e.target.select());

container.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !S.doc) return;
  e.preventDefault();
  const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  const factor = Math.exp(-delta * 0.0022);
  viewer.updateScale({ scaleFactor: factor, origin: [e.clientX, e.clientY], drawingDelay: 300 });
}, { passive: false });

// ---------- Panneau latéral ----------
function toggleSidebar(force) {
  const sb = $('#sidebar');
  const show = force ?? sb.hidden;
  sb.hidden = !show;
  $('#btnSidebar').classList.toggle('on', show);
  setSetting('sidebar', show);
  if (show) SB.markCurrent(viewer.currentPageNumber || 1);
}
$('#btnSidebar').onclick = () => toggleSidebar();
toggleSidebar(settings.sidebar !== false);

// ---------- Mode présentation ----------
let presState = null;
async function presentation() {
  if (!S.doc) return;
  presState = { scroll: viewer.scrollMode, spread: viewer.spreadMode, scale: viewer.currentScaleValue };
  try { await container.requestFullscreen(); } catch { presState = null; return; }
  viewer.scrollMode = pdfjsViewer.ScrollMode.PAGE;
  viewer.spreadMode = pdfjsViewer.SpreadMode.NONE;
  setTimeout(() => { viewer.currentScaleValue = 'page-fit'; }, 60);
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && presState) {
    viewer.scrollMode = presState.scroll;
    viewer.spreadMode = presState.spread;
    viewer.currentScaleValue = presState.scale;
    presState = null;
  } else if (document.fullscreenElement === container && presState) {
    setTimeout(() => { viewer.currentScaleValue = 'page-fit'; }, 120);
  }
});
container.addEventListener('click', (e) => {
  if (presState && document.fullscreenElement && S.tool === 'select' && !e.target.closest('a, .annotationLayer section, [data-aid]')) viewer.nextPage();
});

// ---------- Menus ----------
$('#btnFile').onclick = (e) => {
  const dis = !S.doc;
  openMenu(e.currentTarget, [
    { label: 'Ouvrir…', icon: 'open', kbd: 'Ctrl+O', run: openPicker },
    { label: 'Nouveau document vierge', icon: 'fileplus', run: newDocument },
    '-',
    { label: 'Enregistrer', icon: 'save', kbd: 'Ctrl+S', disabled: dis, run: () => save() },
    { label: 'Enregistrer sous…', icon: 'download', kbd: 'Ctrl+Maj+S', disabled: dis, run: () => save({ as: true }) },
    { label: 'Enregistrer une copie aplatie (formulaires figés)…', icon: 'layers', disabled: dis, run: () => save({ flatten: true }) },
    { label: 'Télécharger l\'original (sans modifications)', icon: 'download', disabled: dis, run: () => downloadBlob(new Blob([S.doc.origBytes], { type: 'application/pdf' }), S.doc.name) },
    '-',
    { label: 'Exporter la page actuelle en PNG…', icon: 'image', disabled: dis, run: () => exportImages([viewer.currentPageNumber - 1]) },
    { label: 'Exporter toutes les pages en PNG…', icon: 'image', disabled: dis, run: () => exportImages(S.pages.map((_, i) => i)) },
    { label: 'Exporter le texte (.txt)…', icon: 'txt', disabled: dis, run: exportText },
    { label: 'Diviser en plusieurs PDF…', icon: 'split', disabled: dis, run: splitDocument },
    '-',
    { label: 'Imprimer…', icon: 'print', kbd: 'Ctrl+P', disabled: dis, run: printDoc },
    { label: 'Ouvrir avec le lecteur de Chrome', icon: 'external', hidden: !(hasChrome && S.doc?.url && /^(https?|file):/.test(S.doc.url)), run: () => openInChrome(S.doc.url) },
    { label: 'Fermer le document', icon: 'x', disabled: dis, run: closeDocument },
  ]);
};

$('#btnMore').onclick = (e) => {
  const dis = !S.doc;
  const sm = viewer.scrollMode, sp = viewer.spreadMode;
  const { ScrollMode, SpreadMode } = pdfjsViewer;
  openMenu(e.currentTarget, [
    { header: 'Affichage' },
    { label: 'Défilement vertical', checked: sm === ScrollMode.VERTICAL, run: () => { viewer.scrollMode = ScrollMode.VERTICAL; } },
    { label: 'Défilement horizontal', checked: sm === ScrollMode.HORIZONTAL, run: () => { viewer.scrollMode = ScrollMode.HORIZONTAL; } },
    { label: 'Mosaïque', checked: sm === ScrollMode.WRAPPED, run: () => { viewer.scrollMode = ScrollMode.WRAPPED; } },
    { label: 'Page par page', checked: sm === ScrollMode.PAGE, run: () => { viewer.scrollMode = ScrollMode.PAGE; } },
    { label: 'Pages simples', checked: sp === SpreadMode.NONE, run: () => { viewer.spreadMode = SpreadMode.NONE; } },
    { label: 'Pages doubles (impaires à gauche)', checked: sp === SpreadMode.ODD, run: () => { viewer.spreadMode = SpreadMode.ODD; } },
    { label: 'Pages doubles (paires à gauche)', checked: sp === SpreadMode.EVEN, run: () => { viewer.spreadMode = SpreadMode.EVEN; } },
    { label: 'Mode nuit (pages sombres)', checked: !!settings.night, run: () => { setSetting('night', !settings.night); applyTheme(); } },
    { label: 'Mode présentation', icon: 'present', kbd: 'F5', disabled: dis, run: presentation },
    '-',
    { header: 'Document' },
    { label: 'Propriétés et métadonnées…', icon: 'info', disabled: dis, run: showProperties },
    { label: 'Filigrane…', icon: 'droplet', disabled: dis, checked: !!S.docSettings.watermark, run: editWatermark },
    { label: 'Numéros de page…', icon: 'hash', disabled: dis, checked: !!S.docSettings.pageNumbers, run: editPageNumbers },
    { label: 'Protéger par mot de passe…', icon: 'lock', disabled: dis, checked: !!S.docSettings.protect, run: editProtection },
    '-',
    { header: 'Formulaire' },
    { label: 'Détecter les champs à remplir', icon: 'form', disabled: dis, run: detectAllFields },
    { label: 'Tracer / ajuster les champs', icon: 'form', kbd: 'F', disabled: dis, run: () => setTool('field') },
    { label: 'Afficher les zones de champ', checked: getSettings().showFields !== false, disabled: dis, run: () => setFieldsVisible(getSettings().showFields === false) },
    { label: 'Supprimer toutes les zones de champ', icon: 'trash', disabled: dis || !A.fieldCount(), run: removeDetectedFields },
    { label: 'Remplir avec mes informations', icon: 'text', disabled: dis || !A.fieldCount(), run: fillWithProfile },
    { label: 'Mes informations…', icon: 'info', run: editProfile },
    '-',
    { header: 'Pages' },
    { label: 'Insérer un PDF ou des images…', icon: 'merge', disabled: dis, run: () => pickInsert(viewer.currentPageNumber) },
    { label: 'Insérer une page vierge', icon: 'blank', disabled: dis, run: () => insertBlank(viewer.currentPageNumber) },
    { label: 'Pivoter la page actuelle', icon: 'rotcw', disabled: dis, run: () => rotatePages([viewer.currentPageNumber - 1], 90) },
    { label: 'Pivoter tout le document', icon: 'rotcw', disabled: dis, run: () => rotatePages(S.pages.map((_, i) => i), 90) },
    { label: 'Supprimer la page actuelle', icon: 'trash', disabled: dis, run: () => deletePages([viewer.currentPageNumber - 1]) },
    { label: 'Diviser le document…', icon: 'split', disabled: dis, run: splitDocument },
    '-',
    { label: 'Paramètres…', icon: 'settings', run: openSettings },
    { label: 'Raccourcis clavier', icon: 'keyboard', kbd: '?', run: D.shortcutsDialog },
  ]);
};

async function showProperties() {
  let md = {};
  try { md = await S.doc.pdf.getMetadata(); } catch {}
  const inf = md.info || {};
  const pg = await S.doc.pdf.getPage(viewer.currentPageNumber || 1);
  const vp = pg.getViewport({ scale: 1 });
  const mm = (pt) => Math.round((pt / 72) * 25.4);
  const pdfDate = (d) => { const x = pdfjsLib.PDFDateString.toDateObject(d); return x ? formatDate(x, true) : null; };
  const info = [
    ['Fichier', S.doc.name], ['Taille', formatBytes(S.doc.size)], ['Pages', String(S.pages.length)],
    ['Format de la page', `${mm(vp.width)} × ${mm(vp.height)} mm`], ['Version PDF', inf.PDFFormatVersion],
    ['Créé avec', inf.Creator], ['Producteur', inf.Producer], ['Création', pdfDate(inf.CreationDate)], ['Modification', pdfDate(inf.ModDate)],
    ['Formulaire', inf.IsAcroFormPresent ? 'Oui' : 'Non'], ['Protégé', S.doc.encrypted ? 'Oui' : 'Non'],
  ];
  const cur = S.docSettings.meta || { title: inf.Title || '', author: inf.Author || '', subject: inf.Subject || '', keywords: inf.Keywords || '' };
  const r = await D.propertiesDialog(info, cur);
  if (!r) return;
  checkpoint();
  S.docSettings.meta = r;
  toast('Métadonnées mises à jour (appliquées à l\'enregistrement).');
}
async function editWatermark() {
  const r = await D.watermarkDialog(S.docSettings.watermark);
  if (r == null) return;
  checkpoint();
  S.docSettings.watermark = r === 'remove' ? null : r;
  A.renderAll();
}
async function editPageNumbers() {
  const r = await D.pageNumbersDialog(S.docSettings.pageNumbers);
  if (r == null) return;
  checkpoint();
  S.docSettings.pageNumbers = r === 'remove' ? null : r;
  A.renderAll();
}
async function editProtection() {
  const r = await D.protectDialog(S.docSettings.protect, S.doc.encrypted);
  if (r == null) return;
  checkpoint();
  S.docSettings.protect = r === 'remove' ? null : r;
  toast(r === 'remove' ? 'Protection retirée.' : 'Le document sera chiffré à l\'enregistrement.');
}
async function openSettings() {
  let intercept = true;
  if (hasChrome) intercept = (await chrome.storage.local.get({ intercept: true })).intercept;
  const r = await D.settingsDialog({ hasChrome, intercept });
  if (!r) return;
  if (hasChrome) chrome.storage.local.set({ intercept: r.intercept });
  applyTheme();
  A.setTool(S.tool);
  if (r.needsReload) {
    toast('Les nouveaux réglages de rendu seront actifs après rechargement.', {
      actions: [{ label: 'Recharger', run: () => { if (!S.dirty || confirm('Modifications non enregistrées : recharger quand même ? (elles pourront être restaurées)')) location.reload(); } }],
    });
  }
}

$('#btnTheme').onclick = () => {
  const cur = document.documentElement.dataset.theme;
  setSetting('theme', cur === 'dark' ? 'light' : 'dark');
  applyTheme();
};
$('#btnOpen').onclick = openPicker;
$('#btnSave').onclick = () => save();
$('#btnPrint').onclick = printDoc;
$('#btnUndo').onclick = () => undo();
$('#btnRedo').onclick = () => redo();
$('#wOpen').onclick = openPicker;
$('#wNew').onclick = newDocument;
$('#openExtDetails').onclick = (e) => { e.preventDefault(); if (hasChrome) chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id }); };
on('history', () => { $('#btnUndo').disabled = !canUndo(); $('#btnRedo').disabled = !canRedo(); });
emit('history');

// ---------- Ouverture de fichiers ----------
async function openPicker() {
  if (window.showOpenFilePicker) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({
        multiple: true,
        types: [{ description: 'PDF ou images', accept: { 'application/pdf': ['.pdf'], 'image/*': ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'] } }],
      });
    } catch { return; }
    const files = await Promise.all(handles.map((hd) => hd.getFile()));
    return openFiles(files, handles);
  }
  const files = await pickFile('#fileInput', true);
  if (files?.length) openFiles(files);
}

/** Ouvre un ou plusieurs fichiers : 1 PDF → ouverture ; plusieurs PDF/images → un seul document */
async function openFiles(files, handles = []) {
  if (!files.length) return;
  const items = [];
  for (const f of files) {
    const bytes = await readFile(f);
    items.push({ f, bytes, pdf: isPdfBytes(bytes), mime: f.type || sniffImageMime(bytes) });
  }
  if (items.length === 1 && items[0].pdf) {
    return openBytes(items[0].bytes, { name: items[0].f.name, handle: handles[0] || items[0].handle || null });
  }
  const imgs = items.filter((i) => !i.pdf && /^image\//.test(i.mime));
  const pdfs = items.filter((i) => i.pdf);
  if (!imgs.length && !pdfs.length) { toast('Format non pris en charge : ouvrez un PDF ou des images.', { type: 'error' }); return; }
  const parts = [];
  const result = await withLoading('Assemblage…', async () => {
    for (const it of items) {
      if (it.pdf) parts.push(it.bytes);
      else if (/^image\//.test(it.mime)) parts.push(await OPS.imagesToPdf([{ bytes: it.bytes, mime: it.mime }], { fit: imgs.length > 1 || pdfs.length ? 'a4' : 'image' }));
    }
    if (parts.length === 1) return parts[0];
    const rots = await Promise.all(parts.map((p) => OPS.pageRotations(p)));
    const plan = [];
    rots.forEach((r, k) => r.forEach((rot, j) => plan.push({ src: 'ext', doc: k, index: j, rot })));
    const blank = await OPS.createBlankPdf();
    const out = await OPS.rebuildPages(blank, null, plan, parts);
    return out;
  });
  const name = pdfs.length ? baseName(pdfs[0].f.name) + ' (fusion).pdf' : (imgs.length === 1 ? baseName(imgs[0].f.name.replace(/\.[^.]+$/, '')) + '.pdf' : 'Images.pdf');
  await openBytes(result, { name, dirty: true, noRecent: true, skipSession: true });
}

async function newDocument() {
  const bytes = await OPS.createBlankPdf();
  await openBytes(bytes, { name: 'Nouveau document.pdf', dirty: true, noRecent: true, skipSession: true });
  setTool('text');
  toast('Document vierge créé : cliquez pour écrire. Ajoutez des pages depuis le panneau Pages.');
}

async function closeDocument() {
  if (S.dirty && !(await D.confirmDialog('Fermer sans enregistrer les modifications ? (elles restent récupérables à la réouverture)', { title: 'Fermer', ok: 'Fermer', danger: true }))) return;
  A.resetForNewDocument();
  const old = S.doc?.pdf;
  S.doc = null; S.pages = []; S.annots = []; S.dirty = false;
  markSaved();
  viewer.setDocument(null);
  S.linkService.setDocument(null);
  destroyPdf(old);
  $('#thumbs').innerHTML = '';
  $('#outline').innerHTML = '';
  $('#pageCount').textContent = '/ 0';
  emit('dirty');
  clearHistory();
  showWelcome();
}

// ---------- Glisser-déposer ----------
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer.types.includes('Files')) return;
  dragDepth++;
  $('#dropHint').hidden = false;
});
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropHint').hidden = true; } });
window.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  dragDepth = 0;
  $('#dropHint').hidden = true;
  if (!e.dataTransfer.files.length) return;
  e.preventDefault();
  const files = [...e.dataTransfer.files];
  // Les éléments du glisser-déposer ne sont lisibles que pendant l'événement : on demande toutes les poignées d'un coup
  const pending = [...(e.dataTransfer.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFileSystemHandle?.()?.catch(() => null));
  const handles = (await Promise.all(pending)).filter((hd) => hd?.kind === 'file');
  if (!S.doc) return openFiles(files, handles);
  // Image déposée sur une page : insertion à l'endroit du dépôt
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  const pageDiv = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('.page');
  if (imgs.length === files.length && pageDiv) {
    const meta = S.pages[+pageDiv.dataset.pageNumber - 1];
    for (const f of imgs) {
      const bytes = await readFile(f);
      const t = await imageTemplate(bytes, f.type);
      const host = pageDiv.querySelector('.pa-host');
      if (host) {
        const pcPoint = A.clientToBase(meta.id, e.clientX, e.clientY);
        t.x = pcPoint.x - t.w / 2; t.y = pcPoint.y - t.h / 2;
      }
      A.addAnnot({ ...t, pageId: meta.id });
    }
    setTool('select');
    return;
  }
  const choice = await D.choiceDialog('Fichiers déposés', `${files.length} fichier(s). Que voulez-vous faire ?`, [
    { label: 'Ajouter à la fin du document', value: 'append' },
    { label: 'Ouvrir', value: 'open' },
  ]);
  if (choice === 'open') openFiles(files, handles);
  else if (choice === 'append') insertFiles(files, S.pages.length);
});

// ---------- Coller ----------
document.addEventListener('paste', async (e) => {
  if (!S.doc || isTyping(e.target) || A.isEditing()) return;
  const items = [...(e.clipboardData?.items || [])];
  const img = items.find((i) => i.type.startsWith('image/'));
  const pageId = S.pages[viewer.currentPageNumber - 1].id;
  if (img) {
    e.preventDefault();
    const f = img.getAsFile();
    const bytes = await readFile(f);
    const t = await imageTemplate(bytes, f.type);
    const g = await A.ensurePageGeom(pageId);
    t.x = (g.baseW - t.w) / 2; t.y = (g.baseH - t.h) / 3;
    A.addAnnot({ ...t, pageId });
    setTool('select');
    return;
  }
  if (A.paste(pageId)) { e.preventDefault(); return; }
  const text = e.clipboardData?.getData('text/plain');
  if (text && S.tool === 'text') {
    e.preventDefault();
    const g = await A.ensurePageGeom(pageId);
    A.addAnnot({ type: 'text', pageId, x: g.baseW / 4, y: g.baseH / 4, text, ...A.toolProps.text });
  }
});
document.addEventListener('copy', (e) => {
  if (isTyping(e.target) || A.isEditing() || !S.selection.size) return;
  if (getSelection()?.toString()) return;
  A.copySelection();
  e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (isTyping(e.target) || A.isEditing() || !S.selection.size) return;
  A.cutSelection();
  e.preventDefault();
});

// ---------- Clavier ----------
function isTyping(t) {
  return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
}
const TOOL_KEYS = { v: 'select', h: 'pan', t: 'text', m: 'edittext', u: 'highlight', d: 'ink', e: 'eraser', r: 'rect', o: 'ellipse', l: 'line', a: 'arrow', i: 'image', s: 'signature', n: 'note', k: 'link', w: 'whiteout', c: 'crop', f: 'field' };

// Raccourcis « document » interceptés en phase de capture : ils fonctionnent même pendant la saisie
// dans un champ, un éditeur de texte ou un peigne (qui arrêtent la propagation), et Chrome ne doit
// jamais enregistrer / imprimer la page HTML de l'application à la place du PDF.
window.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k !== 's' && k !== 'p' && k !== 'o') return;
  e.preventDefault();
  e.stopPropagation();
  if (e.repeat || document.querySelector('dialog[open]')) return; // dialogue ouvert : on bloque seulement l'action de Chrome
  if (k === 's') save({ as: e.shiftKey });
  else if (k === 'p') printDoc();
  else openPicker();
}, true);

document.addEventListener('keydown', (e) => {
  if (document.getElementById('dlg').open) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && k === 'f') { e.preventDefault(); openFind(); return; }
  if (ctrl && (k === '=' || k === '+')) { e.preventDefault(); viewer.increaseScale(); return; }
  if (ctrl && k === '-') { e.preventDefault(); viewer.decreaseScale(); return; }
  if (ctrl && k === '0') { e.preventDefault(); viewer.currentScaleValue = 'auto'; return; }
  if (e.key === 'F4') { e.preventDefault(); toggleSidebar(); return; }
  if (e.key === 'F5') { e.preventDefault(); presentation(); return; }
  if (isTyping(e.target)) return;
  if (ctrl && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (ctrl && k === 'y') { e.preventDefault(); redo(); return; }
  if (!S.doc) return;
  if (ctrl && k === 'd') { e.preventDefault(); A.duplicateSelection(); return; }
  if (ctrl && k === 'a' && S.tool === 'select') {
    e.preventDefault();
    A.selectAllOnPage(S.pages[viewer.currentPageNumber - 1].id);
    return;
  }
  if (ctrl && (k === 'b' || k === 'i') && S.selection.size) {
    e.preventDefault();
    const prop = k === 'b' ? 'bold' : 'italic';
    const first = A.selectedAnnots().find((a) => a.type === 'text');
    if (first) { A.applyProps({ [prop]: !first[prop] }); renderProps(); }
    return;
  }
  if (ctrl && (e.key === ']' || e.key === '[')) { e.preventDefault(); A.reorderSelection(e.key === ']'); return; }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (S.selection.size) { e.preventDefault(); A.deleteSelection(); }
    return;
  }
  if (e.key === 'Escape') {
    if (A.isPlacing()) { A.cancelPlacement(); setTool('select'); return; }
    if (presState) return;
    if (!$('#findbar').hidden) { closeFind(); return; }
    if (S.selection.size) { A.clearSelection(); return; }
    if (S.tool !== 'select') setTool('select');
    return;
  }
  if (e.key.startsWith('Arrow') && S.selection.size) {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (A.nudge(dx, dy)) e.preventDefault();
    return;
  }
  if (presState && (e.key === ' ' || e.key === 'ArrowRight' || e.key === 'ArrowDown' || e.key === 'PageDown')) { e.preventDefault(); viewer.nextPage(); return; }
  if (presState && (e.key === 'ArrowLeft' || e.key === 'ArrowUp' || e.key === 'PageUp')) { e.preventDefault(); viewer.previousPage(); return; }
  if (e.key === 'Home' && !ctrl) { e.preventDefault(); viewer.currentPageNumber = 1; return; }
  if (e.key === 'End' && !ctrl) { e.preventDefault(); viewer.currentPageNumber = viewer.pagesCount; return; }
  if (e.key === '?') { D.shortcutsDialog(); return; }
  if (!ctrl && !e.altKey && TOOL_KEYS[k] && e.key.length === 1) { e.preventDefault(); setTool(TOOL_KEYS[k]); }
});

window.addEventListener('beforeunload', (e) => {
  if (S.dirty) { autosave.flush(); e.preventDefault(); e.returnValue = ''; }
});

// ---------- Démarrage ----------
(async function start() {
  const href = location.href;
  const i = href.indexOf('?file=');
  const params = new URLSearchParams(location.search);
  if (i >= 0) {
    const fileUrl = href.slice(i + 6);
    await openUrl(/^(https?|file|blob|data)%3A/i.test(fileUrl) ? decodeURIComponent(fileUrl) : fileUrl);
  } else if (params.get('action') === 'new') {
    await newDocument();
  } else {
    showWelcome();
    if (params.get('action') === 'open') $('#wOpen').focus();
    if (params.get('welcome')) {
      toast('Formagic est installé : les PDF du web s\'ouvriront désormais ici. Épinglez l\'extension pour y accéder rapidement.', { timeout: 9000 });
    }
  }
  if (nativeDpr() >= 2.5 && settings.quality === 'auto' && !localStorage.getItem('pa-hint-4k')) {
    localStorage.setItem('pa-hint-4k', '1');
    toast('Écran très haute résolution détecté. Si le défilement manque de fluidité, choisissez la qualité « Équilibrée » dans les paramètres.', {
      timeout: 10000, actions: [{ label: 'Paramètres', run: openSettings }],
    });
  }
})();

// Exposé pour le débogage et les tests
window.PA = { S, A, OPS, save, openBytes, openFiles, exportPdf: OPS.exportPdf, rotatePages, deletePages, movePages, insertBlank, duplicatePages, cropPages };
