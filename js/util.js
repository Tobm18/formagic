// Utilitaires généraux
import { icon, applyIcons } from './icons.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  if (el.dataset?.icon && !el.querySelector(':scope > svg.ico')) el.insertAdjacentHTML('afterbegin', icon(el.dataset.icon));
  applyIcons(el);
  return el;
}

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const isMac = navigator.platform.includes('Mac');

export function debounce(fn, ms) {
  let t;
  const d = (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  d.flush = (...a) => { clearTimeout(t); fn(...a); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function hexToRgb01(hex) {
  let s = String(hex || '#000').replace('#', '');
  if (s.length === 3) s = s.split('').map((c) => c + c).join('');
  const n = parseInt(s.slice(0, 6), 16) || 0;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
export function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map((v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
}

export function formatBytes(n) {
  if (!Number.isFinite(n)) return '';
  const u = ['o', 'Ko', 'Mo', 'Go'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0).replace('.', ',')} ${u[i]}`;
}

export function formatDate(d = new Date(), withTime = false) {
  const o = { day: '2-digit', month: '2-digit', year: 'numeric' };
  if (withTime) Object.assign(o, { hour: '2-digit', minute: '2-digit' });
  return new Intl.DateTimeFormat('fr-FR', o).format(d);
}

export function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 7) return `il y a ${Math.floor(s / 86400)} j`;
  return formatDate(new Date(ts));
}

export function baseName(name) {
  return String(name || 'document').replace(/\.pdf$/i, '');
}

export function fileNameFromUrl(url) {
  try {
    const u = new URL(url);
    const seg = decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || '');
    if (seg) return /\.pdf$/i.test(seg) ? seg : seg + '.pdf';
    return (u.hostname || 'document') + '.pdf';
  } catch {
    return 'document.pdf';
  }
}

export async function readFile(file) {
  return new Uint8Array(await file.arrayBuffer());
}

/** Charge une URL en Uint8Array (http, blob, data, file) avec progression. */
export async function fetchBytes(url, onProgress) {
  if (url.startsWith('file:')) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url);
      xhr.responseType = 'arraybuffer';
      xhr.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => (xhr.response && (xhr.status === 0 || xhr.status === 200))
        ? resolve({ bytes: new Uint8Array(xhr.response), filename: null })
        : reject(new Error('Lecture du fichier local impossible'));
      xhr.onerror = () => reject(new Error("Accès au fichier local refusé. Activez « Autoriser l'accès aux URL de fichier » pour Formagic dans chrome://extensions."));
      xhr.send();
    });
  }
  const res = await fetch(url, { credentials: 'include' });
  if (!res.ok) throw new Error(`Le serveur a répondu ${res.status} ${res.statusText}`);
  let filename = null;
  const cd = res.headers.get('content-disposition');
  if (cd) {
    const m = /filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i.exec(cd);
    if (m) { try { filename = decodeURIComponent((m[1] || m[2]).trim()); } catch { filename = (m[1] || m[2]).trim(); } }
  }
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !total || !onProgress) {
    return { bytes: new Uint8Array(await res.arrayBuffer()), filename };
  }
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress(Math.min(1, loaded / total));
  }
  const out = new Uint8Array(loaded);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return { bytes: out, filename };
}

export function isPdfBytes(bytes) {
  const n = Math.min(bytes.length, 1024);
  for (let i = 0; i < n - 4; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46) return true; // %PDF
  }
  return false;
}

/** Téléchargement classique (repli si l'API File System Access n'est pas disponible) */
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/** Enregistrer avec le sélecteur de fichier natif. Renvoie le handle ou null. */
/**
 * Demande où enregistrer. Renvoie la poignée choisie, 'cancel', ou null si le sélecteur est indisponible
 * (le fichier sera alors téléchargé). `startIn` : une poignée dont le dossier sert de point de départ.
 */
export async function pickSaveFile(suggestedName, types, startIn = null) {
  if (!window.showSaveFilePicker) return null;
  try {
    return await window.showSaveFilePicker({ suggestedName, types, ...(startIn ? { startIn } : {}) });
  } catch (e) {
    if (e.name === 'AbortError') return 'cancel';
    if (startIn) return pickSaveFile(suggestedName, types); // dossier de départ disparu
    console.warn(e);
    return null;
  }
}

export async function writeHandle(handle, blob) {
  const w = await handle.createWritable();
  await w.write(blob);
  await w.close();
}

export async function saveWithPicker(blob, suggestedName, types) {
  const handle = await pickSaveFile(suggestedName, types);
  if (handle === 'cancel') return 'cancel';
  if (!handle) { downloadBlob(blob, suggestedName); return null; }
  await writeHandle(handle, blob);
  return handle;
}

export const PDF_TYPES = [{ description: 'Document PDF', accept: { 'application/pdf': ['.pdf'] } }];

export function canvasToBlob(canvas, type = 'image/png', q = 0.92) {
  return new Promise((r) => canvas.toBlob(r, type, q));
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Image illisible"));
    img.src = src;
  });
}

/** Convertit n'importe quelle image en PNG ou JPEG supporté par pdf-lib */
export async function normalizeImage(bytes, mime) {
  if (mime === 'image/png' || mime === 'image/jpeg') return { bytes, mime };
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    const img = await loadImage(url);
    const c = document.createElement('canvas');
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    c.getContext('2d').drawImage(img, 0, 0);
    const blob = await canvasToBlob(c, 'image/png');
    return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function sniffImageMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) return 'image/webp';
  if (bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp';
  return 'application/octet-stream';
}

// ---------- Notifications ----------
export function toast(msg, { type = 'info', actions = [], timeout = 4200 } = {}) {
  const t = document.createElement('div');
  t.className = 'toast' + (type === 'error' ? ' error' : '');
  const span = document.createElement('span');
  span.textContent = msg;
  t.append(span);
  for (const a of actions) {
    const b = document.createElement('button');
    b.textContent = a.label;
    b.onclick = () => { a.run(); t.remove(); };
    t.append(b);
  }
  document.getElementById('toasts').append(t);
  if (timeout) setTimeout(() => t.remove(), timeout + actions.length * 4000);
  return t;
}

// ---------- Menus déroulants ----------
let menuCloser = null;
export function openMenu(anchor, items, { x, y } = {}) {
  const m = document.getElementById('menu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.append(document.createElement('hr')); continue; }
    if (it.header) { const d = document.createElement('div'); d.className = 'mh'; d.textContent = it.header; m.append(d); continue; }
    if (it.hidden) continue;
    const b = document.createElement('button');
    b.className = 'mi' + (it.checked ? ' checked' : '');
    b.disabled = !!it.disabled;
    b.innerHTML = (it.icon ? icon(it.icon) : '<span style="width:16px;flex:none"></span>') + `<span></span>` + (it.kbd ? `<span class="kbd">${it.kbd}</span>` : '');
    b.children[1].textContent = it.label;
    b.onclick = () => { closeMenu(); it.run?.(); };
    m.append(b);
  }
  m.hidden = false;
  const r = anchor ? anchor.getBoundingClientRect() : { left: x, bottom: y, right: x, top: y };
  const mw = m.offsetWidth, mh = m.offsetHeight;
  let left = anchor ? Math.min(r.left, innerWidth - mw - 8) : x;
  let top = anchor ? r.bottom + 4 : y;
  if (left + mw > innerWidth - 8) left = innerWidth - mw - 8;
  if (top + mh > innerHeight - 8) top = Math.max(8, (anchor ? r.top - mh - 4 : innerHeight - mh - 8));
  m.style.left = Math.max(8, left) + 'px';
  m.style.top = top + 'px';
  setTimeout(() => {
    menuCloser = (e) => { if (!m.contains(e.target)) closeMenu(); };
    document.addEventListener('pointerdown', menuCloser, true);
  });
  m.querySelector('.mi:not(:disabled)')?.focus();
}
export function closeMenu() {
  const m = document.getElementById('menu');
  m.hidden = true;
  if (menuCloser) document.removeEventListener('pointerdown', menuCloser, true);
  menuCloser = null;
}

// ---------- Paramètres ----------
const DEFAULTS = {
  theme: 'auto',
  night: false,
  quality: 'auto',          // auto | balanced | performance
  workerRendering: true,
  hwa: true,
  touchDraw: false,
  author: '',
  defaultZoom: 'auto',
  sidebar: true,
  sideWidth: 220,
  restorePosition: true,
  formDetect: true,         // détecter les champs des formulaires « à plat »
  showFields: true,
};
let settingsCache = null;
export function getSettings() {
  if (!settingsCache) {
    try { settingsCache = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('pa-settings') || '{}') }; }
    catch { settingsCache = { ...DEFAULTS }; }
  }
  return settingsCache;
}
export function setSetting(k, v) {
  getSettings()[k] = v;
  try { localStorage.setItem('pa-settings', JSON.stringify(settingsCache)); } catch {}
}

export const hasChrome = typeof chrome !== 'undefined' && !!chrome.runtime?.id;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
