// Boîtes de dialogue
import { h, uid, getSettings, setSetting, canvasToBlob, readFile, loadImage, formatDate, formatBytes, escapeHtml } from './util.js';
import { icon, applyIcons } from './icons.js';
import { getSignatures, saveSignatures } from './store.js';
import { STORED_KEYS } from './profile.js';

const dlg = () => document.getElementById('dlg');
let current = null;

/**
 * Ouvre un dialogue. buttons: [{ label, value, primary, danger, validate }]
 * Renvoie une promesse résolue avec la valeur du bouton (ou null si fermé).
 */
export function openDialog({ title, body, buttons = [{ label: 'Fermer', value: null }], width, onOpen, onClose }) {
  if (current) current.resolve(null);
  const d = dlg();
  d.innerHTML = '';
  d.style.width = width ? `min(${width}px, calc(100vw - 32px))` : '';
  const head = h('div', { class: 'dlg-head' }, h('h3', {}, title), h('button', { class: 'ib sm', 'data-icon': 'x', title: 'Fermer', onclick: () => finish(null) }));
  const bodyEl = h('div', { class: 'dlg-body' });
  if (typeof body === 'string') bodyEl.innerHTML = body; else if (body) bodyEl.append(body);
  applyIcons(bodyEl);
  const foot = h('div', { class: 'dlg-foot' });
  let resolveFn;
  const p = new Promise((r) => { resolveFn = r; });
  const finish = async (value, btn) => {
    if (btn?.validate) {
      const ok = await btn.validate();
      if (ok === false) return;
    }
    current = null;
    onClose?.();
    d.close();
    resolveFn(typeof value === 'function' ? value() : value);
  };
  for (const b of buttons) {
    const el = h('button', { class: 'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : ''), type: 'button' }, b.label);
    el.onclick = () => finish(b.value, b);
    foot.append(el);
  }
  d.append(head, bodyEl, foot);
  d.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      const prim = buttons.find((b) => b.primary);
      if (prim) { e.preventDefault(); finish(prim.value, prim); }
    }
  };
  d.oncancel = (e) => { e.preventDefault(); finish(null); };
  current = { resolve: (v) => { d.close(); resolveFn(v); } };
  d.showModal();
  onOpen?.(bodyEl);
  const first = bodyEl.querySelector('input:not([type=checkbox]):not([type=radio]), textarea, select');
  if (first) setTimeout(() => { first.focus(); first.select?.(); }, 30);
  return p;
}

export async function confirmDialog(message, { title = 'Confirmer', ok = 'OK', danger = false, cancel = 'Annuler' } = {}) {
  const r = await openDialog({
    title, body: h('p', { style: { margin: '4px 0' } }, message),
    buttons: [{ label: cancel, value: false }, { label: ok, value: true, primary: !danger, danger }],
  });
  return !!r;
}

export async function choiceDialog(title, message, choices) {
  return openDialog({
    title, body: h('p', { style: { margin: '4px 0' } }, message),
    buttons: [{ label: 'Annuler', value: null }, ...choices.map((c, i) => ({ label: c.label, value: c.value, primary: i === choices.length - 1 }))],
  });
}

export async function promptDialog(title, label, value = '', { type = 'text', placeholder = '' } = {}) {
  const input = h('input', { type, value, placeholder });
  const body = h('div', { class: 'frow' }, h('label', {}, label), input);
  return openDialog({ title, body, buttons: [{ label: 'Annuler', value: null }, { label: 'OK', primary: true, value: () => input.value }] });
}

export async function passwordDialog(reason, filename) {
  const input = h('input', { type: 'password', autocomplete: 'off' });
  const wrong = reason === 2; // PasswordResponses.INCORRECT_PASSWORD
  const body = h('div', { class: 'frow' },
    h('p', { style: { margin: '0 0 6px' } }, wrong ? 'Mot de passe incorrect, réessayez.' : `« ${filename || 'Ce document'} » est protégé par un mot de passe.`),
    h('label', {}, 'Mot de passe'), input);
  return openDialog({ title: 'Document protégé', body, buttons: [{ label: 'Annuler', value: null }, { label: 'Ouvrir', primary: true, value: () => input.value }] });
}

// ---------- Lien ----------
export async function linkDialog(initial = {}, pageCount = 1) {
  const kind = initial.page ? 'page' : 'url';
  const url = h('input', { type: 'url', placeholder: 'https://…', value: initial.url || '' });
  const page = h('input', { type: 'number', min: 1, max: pageCount, value: initial.page || 1 });
  const rUrl = h('input', { type: 'radio', name: 'lk', checked: kind === 'url' });
  const rPage = h('input', { type: 'radio', name: 'lk', checked: kind === 'page' });
  const body = h('div', {},
    h('label', { class: 'check-row' }, rUrl, 'Adresse web'), h('div', { class: 'frow', style: { margin: '4px 0 12px 24px' } }, url),
    h('label', { class: 'check-row' }, rPage, `Page de ce document (1 – ${pageCount})`), h('div', { class: 'frow', style: { margin: '4px 0 0 24px' } }, page));
  url.onfocus = () => { rUrl.checked = true; };
  page.onfocus = () => { rPage.checked = true; };
  return openDialog({
    title: 'Lien', body,
    buttons: [{ label: 'Annuler', value: null }, {
      label: 'OK', primary: true,
      value: () => {
        if (rPage.checked) return { page: Math.min(pageCount, Math.max(1, parseInt(page.value, 10) || 1)) };
        let u = url.value.trim();
        if (!u) return null;
        if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = (u.includes('@') && !u.includes('/') ? 'mailto:' : 'https://') + u;
        return { url: u };
      },
    }],
  });
}

// ---------- Signature ----------
const SIG_FONTS = ['Segoe Script', 'Brush Script MT', 'Lucida Handwriting', 'Ink Free', 'Freestyle Script', 'Mistral', 'Segoe Print', 'cursive'];

function trimCanvas(c, pad = 6) {
  const ctx = c.getContext('2d');
  const { width: w, height: hh } = c;
  const d = ctx.getImageData(0, 0, w, hh).data;
  let x0 = w, y0 = hh, x1 = -1, y1 = -1;
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 8) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad); x1 = Math.min(w - 1, x1 + pad); y1 = Math.min(hh - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

async function canvasToSig(c) {
  const t = trimCanvas(c);
  if (!t) return null;
  const blob = await canvasToBlob(t, 'image/png');
  return { bytes: new Uint8Array(await blob.arrayBuffer()), mime: 'image/png', w: t.width, h: t.height };
}

function makePad(canvas, getColor, getWidth) {
  const ctx = canvas.getContext('2d');
  let pts = null, last = null, dirty = false;
  const resize = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(r.width * dpr * 1.5);
    canvas.height = Math.round(r.height * dpr * 1.5);
    ctx.setTransform(canvas.width / r.width, 0, 0, canvas.height / r.height, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  };
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, p: e.pressure || 0.5, t: e.timeStamp }; };
  canvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    last = pos(e); pts = [last]; dirty = true;
    ctx.fillStyle = getColor();
    ctx.beginPath(); ctx.arc(last.x, last.y, getWidth() * 0.5, 0, Math.PI * 2); ctx.fill();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!pts) return;
    for (const ce of e.getCoalescedEvents?.() || [e]) {
      const p = pos(ce);
      const dist = Math.hypot(p.x - last.x, p.y - last.y);
      if (dist < 0.6) continue;
      const speed = dist / Math.max(1, p.t - last.t);
      const base = getWidth();
      const pressure = e.pointerType === 'pen' ? 0.35 + p.p * 1.1 : 1;
      const w = Math.max(base * 0.35, base * pressure * (1.25 - Math.min(0.75, speed * 0.35)));
      last.w ??= w;
      const lw = last.w * 0.6 + w * 0.4;
      ctx.strokeStyle = getColor();
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(last.x, last.y);
      ctx.lineTo(p.x, p.y);
      ctx.stroke();
      p.w = lw;
      last = p;
      pts.push(p);
    }
  });
  const end = () => { pts = null; };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  return {
    resize,
    clear: () => { ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.restore(); dirty = false; },
    isDirty: () => dirty,
  };
}

function removeWhite(canvas, threshold = 225) {
  const ctx = canvas.getContext('2d');
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = (d[i] + d[i + 1] + d[i + 2]) / 3;
    if (l >= threshold) d[i + 3] = 0;
    else if (l > threshold - 40) d[i + 3] = Math.round(d[i + 3] * (threshold - l) / 40);
  }
  ctx.putImageData(id, 0, 0);
}

export async function signatureDialog() {
  const saved = await getSignatures();
  const urls = [];
  let tab = saved.length ? 'saved' : 'draw';
  let color = '#14204a';
  let width = 2.6;
  let typedFont = SIG_FONTS[0];
  let imported = null;

  const tabs = h('div', { class: 'tabs' });
  const pane = h('div', { style: { minHeight: '230px', display: 'flex', flexDirection: 'column', gap: '10px', paddingTop: '6px' } });
  const remember = h('input', { type: 'checkbox', checked: true });
  const body = h('div', {}, tabs, pane, h('label', { class: 'check-row', style: { marginTop: '6px' } }, remember, 'Mémoriser cette signature pour la réutiliser'));
  const colorRow = () => h('div', { class: 'swatches' },
    ...['#14204a', '#000000', '#1a56db', '#c81e1e'].map((c) => {
      const b = h('button', { class: 'sw' + (c === color ? ' on' : ''), style: { background: c }, title: c, type: 'button' });
      b.onclick = () => { color = c; b.parentNode.querySelectorAll('.sw').forEach((x) => x.classList.toggle('on', x === b)); onColor(); };
      return b;
    }));
  let onColor = () => {};
  let pad = null, typedInput = null;

  const render = () => {
    tabs.innerHTML = '';
    for (const [k, label] of [['saved', 'Mes signatures'], ['draw', 'Dessiner'], ['type', 'Taper'], ['import', 'Importer']]) {
      if (k === 'saved' && !saved.length) continue;
      const b = h('button', { class: tab === k ? 'on' : '', type: 'button' }, label);
      b.onclick = () => { tab = k; render(); };
      tabs.append(b);
    }
    pane.innerHTML = '';
    pad = null;
    onColor = () => {};
    if (tab === 'saved') {
      const grid = h('div', { class: 'sig-list' });
      for (const s of saved) {
        const u = URL.createObjectURL(new Blob([s.bytes], { type: 'image/png' }));
        urls.push(u);
        const del = h('button', { class: 'ib sm del', 'data-icon': 'trash', title: 'Supprimer', type: 'button' });
        const item = h('div', { class: 'sig-item', title: 'Utiliser' }, h('img', { src: u, alt: 'Signature' }), del);
        item.onclick = (e) => { if (del.contains(e.target)) return; chosen = { ...s, fromSaved: true }; finishNow(); };
        del.onclick = async () => { saved.splice(saved.indexOf(s), 1); await saveSignatures(saved); render(); };
        grid.append(item);
      }
      pane.append(h('p', { class: 'muted small', style: { margin: 0 } }, 'Cliquez sur une signature pour la placer.'), grid);
    } else if (tab === 'draw') {
      const c = h('canvas', { class: 'sig-pad' });
      const wInput = h('input', { type: 'range', min: 1, max: 6, step: 0.2, value: width });
      wInput.oninput = () => { width = +wInput.value; };
      pane.append(c, h('div', { style: { display: 'flex', alignItems: 'center', gap: '12px' } }, colorRow(), h('span', { class: 'muted small' }, 'Épaisseur'), wInput,
        h('span', { class: 'flex' }), h('button', { class: 'btn sm', type: 'button', onclick: () => pad.clear() }, 'Effacer')));
      requestAnimationFrame(() => { pad = makePad(c, () => color, () => width); pad.resize(); });
    } else if (tab === 'type') {
      typedInput = h('input', { type: 'text', placeholder: 'Votre nom', value: getSettings().author || '' });
      const fonts = h('div', { class: 'sig-fonts' });
      const draw = () => {
        fonts.innerHTML = '';
        for (const f of SIG_FONTS) {
          const b = h('button', { class: 'sig-font' + (f === typedFont ? ' on' : ''), style: { fontFamily: `"${f}", cursive`, color }, type: 'button' }, typedInput.value || 'Signature');
          b.onclick = () => { typedFont = f; draw(); };
          fonts.append(b);
        }
      };
      typedInput.oninput = draw;
      onColor = draw;
      draw();
      pane.append(h('div', { class: 'frow' }, typedInput), fonts, colorRow());
    } else if (tab === 'import') {
      const file = h('input', { type: 'file', accept: 'image/*' });
      const rm = h('input', { type: 'checkbox', checked: true });
      const prev = h('div', { class: 'sig-item', style: { height: '140px' } }, h('span', { class: 'muted' }, 'Aperçu'));
      const update = async () => {
        if (!file.files[0]) return;
        const img = await loadImage(URL.createObjectURL(file.files[0]));
        const c = document.createElement('canvas');
        const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
        c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        if (rm.checked) removeWhite(c);
        imported = c;
        prev.innerHTML = '';
        prev.append(h('img', { src: c.toDataURL() }));
      };
      file.onchange = update;
      rm.onchange = update;
      pane.append(h('p', { class: 'muted small', style: { margin: 0 } }, 'Photo ou scan de votre signature sur papier blanc.'), file,
        h('label', { class: 'check-row' }, rm, 'Rendre le fond blanc transparent'), prev);
    }
  };
  let chosen = null;
  let finishNow = () => {};
  render();

  const getResult = async () => {
    if (chosen) return chosen;
    if (tab === 'draw') {
      if (!pad?.isDirty()) return null;
      return canvasToSig(pane.querySelector('canvas'));
    }
    if (tab === 'type') {
      const name = typedInput.value.trim();
      if (!name) return null;
      setSetting('author', getSettings().author || name);
      const c = document.createElement('canvas');
      const size = 120;
      const ctx = c.getContext('2d');
      ctx.font = `${size}px "${typedFont}", cursive`;
      c.width = Math.ceil(ctx.measureText(name).width + size);
      c.height = Math.ceil(size * 1.9);
      ctx.font = `${size}px "${typedFont}", cursive`;
      ctx.fillStyle = color;
      ctx.textBaseline = 'middle';
      ctx.fillText(name, size / 2, c.height / 2);
      return canvasToSig(c);
    }
    if (tab === 'import' && imported) return canvasToSig(imported);
    return null;
  };

  const resP = openDialog({
    title: 'Signature', body, width: 560,
    buttons: [{ label: 'Annuler', value: null }, { label: 'Placer la signature', primary: true, value: 'ok' }],
    onClose: () => urls.forEach((u) => URL.revokeObjectURL(u)),
  });
  finishNow = () => { document.querySelector('#dlg .dlg-foot .btn.primary')?.click(); };
  const r = await resP;
  if (r !== 'ok') return null;
  const sig = await getResult();
  if (!sig) return null;
  if (remember.checked && !sig.fromSaved) {
    saved.unshift({ id: uid(), bytes: sig.bytes, w: sig.w, h: sig.h, created: Date.now() });
    await saveSignatures(saved);
  }
  return sig;
}

// ---------- Tampons ----------
export const STAMPS = [
  { text: 'Approuvé', color: '#1f9d55' }, { text: 'Validé', color: '#1f9d55' }, { text: 'Payé', color: '#1f9d55' },
  { text: 'Reçu', color: '#1a56db' }, { text: 'Lu et approuvé', color: '#1a56db' }, { text: 'Bon pour accord', color: '#1a56db' },
  { text: 'Brouillon', color: '#6b7280' }, { text: 'Copie', color: '#6b7280' }, { text: 'Confidentiel', color: '#c81e1e' },
  { text: 'Refusé', color: '#c81e1e' }, { text: 'Urgent', color: '#d97706' }, { text: 'À signer', color: '#d97706' },
];
export async function stampDialog(initial) {
  const custom = h('input', { type: 'text', placeholder: 'Texte personnalisé', value: initial?.text || '' });
  const colorIn = h('input', { type: 'color', value: initial?.color || '#c81e1e', class: 'sw-custom', style: { width: '34px', height: '30px' } });
  const withDate = h('input', { type: 'checkbox', checked: initial ? !!initial.sub : true });
  let pick = null;
  const grid = h('div', { class: 'stamp-grid' }, ...STAMPS.map((s) => {
    const b = h('button', { class: 'stamp-opt', style: { color: s.color, borderColor: s.color }, type: 'button' }, s.text.toUpperCase());
    b.onclick = () => { pick = s; document.querySelector('#dlg .dlg-foot .btn.primary').click(); };
    return b;
  }));
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    grid,
    h('div', { class: 'frow' }, h('label', {}, 'Ou un tampon personnalisé'), h('div', { style: { display: 'flex', gap: '8px' } }, custom, colorIn)),
    h('label', { class: 'check-row' }, withDate, `Ajouter la date (${formatDate()})`));
  const r = await openDialog({ title: initial ? 'Modifier le tampon' : 'Tampon', body, width: 560, buttons: [{ label: 'Annuler', value: null }, { label: 'OK', primary: true, value: 'ok' }] });
  if (r !== 'ok') return null;
  const base = pick || (custom.value.trim() ? { text: custom.value.trim(), color: colorIn.value } : null);
  if (!base) return null;
  return { text: base.text, color: base.color, sub: withDate.checked ? formatDate() : '' };
}

// ---------- Filigrane ----------
export async function watermarkDialog(cur) {
  const v = cur || { text: 'CONFIDENTIEL', size: 72, color: '#c81e1e', opacity: 0.18, angle: 45 };
  const text = h('input', { type: 'text', value: v.text });
  const size = h('input', { type: 'number', min: 8, max: 300, value: v.size });
  const color = h('input', { type: 'color', value: v.color, class: 'sw-custom', style: { width: '34px', height: '30px' } });
  const op = h('input', { type: 'range', min: 0.03, max: 1, step: 0.01, value: v.opacity });
  const angle = h('input', { type: 'number', min: -90, max: 90, value: v.angle });
  const body = h('div', {},
    h('div', { class: 'frow' }, h('label', {}, 'Texte'), text),
    h('div', { class: 'fgrid', style: { marginTop: '12px' } },
      h('div', { class: 'frow' }, h('label', {}, 'Taille (pt)'), size),
      h('div', { class: 'frow' }, h('label', {}, 'Angle (°)'), angle),
      h('div', { class: 'frow' }, h('label', {}, 'Couleur'), color),
      h('div', { class: 'frow' }, h('label', {}, 'Opacité'), op)),
    h('p', { class: 'muted small' }, 'Le filigrane est appliqué à toutes les pages lors de l\'enregistrement.'));
  const buttons = [{ label: 'Annuler', value: null }];
  if (cur) buttons.push({ label: 'Retirer', value: 'remove', danger: true });
  buttons.push({ label: 'Appliquer', primary: true, value: () => ({ text: text.value, size: +size.value || 72, color: color.value, opacity: +op.value, angle: +angle.value || 0 }) });
  return openDialog({ title: 'Filigrane', body, buttons });
}

// ---------- Numérotation ----------
export async function pageNumbersDialog(cur) {
  const v = cur || { format: 'Page {n} / {total}', position: 'bottom-center', size: 10, color: '#333333', start: 1, skipFirst: false };
  const format = h('select', {}, ...['{n}', 'Page {n}', 'Page {n} / {total}', '{n} / {total}', '- {n} -'].map((f) => h('option', { value: f, selected: f === v.format }, f.replace('{n}', '3').replace('{total}', '12'))));
  const pos = h('select', {}, ...[['bottom-center', 'En bas au centre'], ['bottom-right', 'En bas à droite'], ['bottom-left', 'En bas à gauche'], ['top-center', 'En haut au centre'], ['top-right', 'En haut à droite'], ['top-left', 'En haut à gauche']]
    .map(([k, l]) => h('option', { value: k, selected: k === v.position }, l)));
  const size = h('input', { type: 'number', min: 5, max: 48, value: v.size });
  const start = h('input', { type: 'number', min: 0, value: v.start });
  const color = h('input', { type: 'color', value: v.color, class: 'sw-custom', style: { width: '34px', height: '30px' } });
  const skip = h('input', { type: 'checkbox', checked: v.skipFirst });
  const body = h('div', {},
    h('div', { class: 'fgrid' },
      h('div', { class: 'frow' }, h('label', {}, 'Format'), format),
      h('div', { class: 'frow' }, h('label', {}, 'Position'), pos),
      h('div', { class: 'frow' }, h('label', {}, 'Taille (pt)'), size),
      h('div', { class: 'frow' }, h('label', {}, 'Commencer à'), start),
      h('div', { class: 'frow' }, h('label', {}, 'Couleur'), color)),
    h('label', { class: 'check-row', style: { marginTop: '12px' } }, skip, 'Ne pas numéroter la première page (couverture)'));
  const buttons = [{ label: 'Annuler', value: null }];
  if (cur) buttons.push({ label: 'Retirer', value: 'remove', danger: true });
  buttons.push({ label: 'Appliquer', primary: true, value: () => ({ format: format.value, position: pos.value, size: +size.value || 10, color: color.value, start: +start.value || 1, skipFirst: skip.checked }) });
  return openDialog({ title: 'Numéros de page', body, buttons });
}

// ---------- Propriétés / métadonnées ----------
export async function propertiesDialog(info, meta) {
  const field = (label, value) => h('div', { class: 'frow' }, h('label', {}, label), h('input', { type: 'text', value: value || '' }));
  const title = field('Titre', meta.title), author = field('Auteur', meta.author), subject = field('Sujet', meta.subject), kw = field('Mots-clés (séparés par des virgules)', meta.keywords);
  const table = h('table', { class: 'prop-table' });
  for (const [k, v] of info) table.append(h('tr', {}, h('td', {}, k), h('td', {}, v ?? '—')));
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } }, table, h('hr', { style: { border: 0, borderTop: '1px solid var(--line)', width: '100%' } }), title, author, subject, kw);
  return openDialog({
    title: 'Propriétés du document', body, width: 560,
    buttons: [{ label: 'Annuler', value: null }, {
      label: 'Enregistrer les métadonnées', primary: true,
      value: () => ({ title: title.querySelector('input').value, author: author.querySelector('input').value, subject: subject.querySelector('input').value, keywords: kw.querySelector('input').value }),
    }],
  });
}

// ---------- Protection ----------
export async function protectDialog(cur, wasEncrypted) {
  const v = cur || {};
  const up = h('input', { type: 'password', value: v.userPassword || '', autocomplete: 'new-password' });
  const up2 = h('input', { type: 'password', value: v.userPassword || '', autocomplete: 'new-password' });
  const op = h('input', { type: 'password', value: v.ownerPassword || '', autocomplete: 'new-password' });
  const noPrint = h('input', { type: 'checkbox', checked: !!v.noPrint });
  const noCopy = h('input', { type: 'checkbox', checked: !!v.noCopy });
  const noModify = h('input', { type: 'checkbox', checked: !!v.noModify });
  const err = h('div', { class: 'small', style: { color: 'var(--accent)' } });
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    wasEncrypted ? h('p', { class: 'muted small', style: { margin: 0 } }, "Ce document était protégé à l'ouverture. Sans nouvelle protection, il sera enregistré sans mot de passe.") : null,
    h('div', { class: 'frow' }, h('label', {}, "Mot de passe d'ouverture"), up),
    h('div', { class: 'frow' }, h('label', {}, 'Confirmer le mot de passe'), up2),
    h('div', { class: 'frow' }, h('label', {}, 'Mot de passe propriétaire (facultatif, pour les restrictions)'), op),
    h('label', { class: 'check-row' }, noPrint, "Interdire l'impression"),
    h('label', { class: 'check-row' }, noCopy, 'Interdire la copie du texte'),
    h('label', { class: 'check-row' }, noModify, 'Interdire les modifications'),
    h('p', { class: 'muted small', style: { margin: 0 } }, 'Chiffrement AES-256, appliqué lors de l\'enregistrement.'), err);
  const buttons = [{ label: 'Annuler', value: null }];
  if (cur) buttons.push({ label: 'Retirer la protection', value: 'remove', danger: true });
  buttons.push({
    label: 'Protéger', primary: true,
    validate: () => {
      if (up.value !== up2.value) { err.textContent = 'Les deux mots de passe ne correspondent pas.'; return false; }
      if (!up.value && !op.value) { err.textContent = 'Indiquez au moins un mot de passe.'; return false; }
      return true;
    },
    value: () => ({ userPassword: up.value, ownerPassword: op.value, noPrint: noPrint.checked, noCopy: noCopy.checked, noModify: noModify.checked }),
  });
  return openDialog({ title: 'Protéger par mot de passe', body, buttons });
}

// ---------- Diviser ----------
export async function splitDialog(pageCount) {
  const every = h('input', { type: 'number', min: 1, max: pageCount, value: 1 });
  const ranges = h('input', { type: 'text', placeholder: 'ex. 1-3, 4-8, 9' });
  const rEvery = h('input', { type: 'radio', name: 'sp', checked: true });
  const rRanges = h('input', { type: 'radio', name: 'sp' });
  every.onfocus = () => { rEvery.checked = true; };
  ranges.onfocus = () => { rRanges.checked = true; };
  const err = h('div', { class: 'small', style: { color: 'var(--accent)' } });
  const parse = () => {
    if (rEvery.checked) {
      const n = Math.max(1, parseInt(every.value, 10) || 1);
      const groups = [];
      for (let i = 0; i < pageCount; i += n) groups.push([...Array(Math.min(n, pageCount - i)).keys()].map((k) => i + k));
      return groups;
    }
    const groups = [];
    for (const part of ranges.value.split(/[,;]/)) {
      const s = part.trim();
      if (!s) continue;
      const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(s);
      if (!m) return null;
      const a = +m[1], b = m[2] ? +m[2] : a;
      if (a < 1 || b > pageCount || a > b) return null;
      groups.push([...Array(b - a + 1).keys()].map((k) => a - 1 + k));
    }
    return groups.length ? groups : null;
  };
  const body = h('div', {},
    h('label', { class: 'check-row' }, rEvery, 'Un fichier toutes les'), h('div', { style: { margin: '6px 0 14px 24px', display: 'flex', gap: '8px', alignItems: 'center' } }, every, h('span', {}, 'page(s)')),
    h('label', { class: 'check-row' }, rRanges, 'Plages personnalisées'), h('div', { class: 'frow', style: { margin: '6px 0 0 24px' } }, ranges),
    h('p', { class: 'muted small' }, `Le document compte ${pageCount} pages. Les fichiers seront enregistrés dans le dossier de votre choix.`), err);
  return openDialog({
    title: 'Diviser le document', body,
    buttons: [{ label: 'Annuler', value: null }, {
      label: 'Diviser', primary: true,
      validate: () => { if (!parse()) { err.textContent = 'Plages invalides.'; return false; } return true; },
      value: parse,
    }],
  });
}

// ---------- Paramètres ----------
export async function settingsDialog(extra = {}) {
  const s = getSettings();
  const sel = (opts, val) => h('select', {}, ...opts.map(([k, l]) => h('option', { value: k, selected: k === val }, l)));
  const theme = sel([['auto', 'Automatique (système)'], ['light', 'Clair'], ['dark', 'Sombre']], s.theme);
  const quality = sel([['auto', 'Maximale (résolution native de l\'écran)'], ['balanced', 'Équilibrée (recommandée en 4K)'], ['performance', 'Performance (la plus fluide)']], s.quality);
  const zoom = sel([['auto', 'Automatique'], ['page-width', 'Pleine largeur'], ['page-fit', 'Page entière'], ['1', '100 %']], s.defaultZoom);
  const worker = h('input', { type: 'checkbox', checked: s.workerRendering });
  const hwa = h('input', { type: 'checkbox', checked: s.hwa });
  const touch = h('input', { type: 'checkbox', checked: s.touchDraw });
  const restore = h('input', { type: 'checkbox', checked: s.restorePosition });
  const forms = h('input', { type: 'checkbox', checked: s.formDetect !== false });
  const author = h('input', { type: 'text', value: s.author, placeholder: 'Nom affiché sur vos commentaires' });
  const intercept = h('input', { type: 'checkbox', checked: extra.intercept !== false });
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '12px' } },
    h('div', { class: 'fgrid' },
      h('div', { class: 'frow' }, h('label', {}, 'Thème'), theme),
      h('div', { class: 'frow' }, h('label', {}, 'Zoom par défaut'), zoom)),
    h('div', { class: 'frow' }, h('label', {}, 'Qualité de rendu'), quality),
    h('label', { class: 'check-row' }, worker, 'Rendu des pages dans un thread séparé (défilement plus fluide)'),
    h('label', { class: 'check-row' }, hwa, 'Accélération matérielle (GPU) des canevas'),
    h('label', { class: 'check-row' }, touch, 'Dessiner au doigt sur l\'écran tactile (sinon le doigt fait défiler, le stylet dessine)'),
    h('label', { class: 'check-row' }, restore, 'Reprendre à la dernière page lue'),
    h('label', { class: 'check-row' }, forms, 'Détecter automatiquement les champs à remplir (lignes, cases, cadres, signatures)'),
    extra.hasChrome ? h('label', { class: 'check-row' }, intercept, 'Ouvrir automatiquement les PDF du web avec Formagic') : null,
    h('div', { class: 'frow' }, h('label', {}, 'Votre nom (commentaires, signature tapée)'), author),
    h('p', { class: 'muted small', style: { margin: 0 } }, 'Les réglages de rendu s\'appliquent au prochain chargement de la page.'));
  const r = await openDialog({ title: 'Paramètres', body, width: 560, buttons: [{ label: 'Annuler', value: null }, { label: 'Enregistrer', primary: true, value: 'ok' }] });
  if (r !== 'ok') return null;
  const before = { ...s };
  setSetting('theme', theme.value);
  setSetting('quality', quality.value);
  setSetting('defaultZoom', zoom.value);
  setSetting('workerRendering', worker.checked);
  setSetting('hwa', hwa.checked);
  setSetting('touchDraw', touch.checked);
  setSetting('restorePosition', restore.checked);
  setSetting('formDetect', forms.checked);
  setSetting('author', author.value.trim());
  return {
    intercept: intercept.checked,
    needsReload: before.quality !== quality.value || before.workerRendering !== worker.checked || before.hwa !== hwa.checked,
  };
}

// ---------- Mes informations ----------
/** Profil de remplissage automatique. Renvoie { values, enabled, clear } ou null. */
export async function profileDialog(values = {}, enabled = true) {
  const inputs = {};
  const groups = [...new Set(STORED_KEYS.map((k) => k.group))];
  const sections = groups.map((g) => h('div', {},
    h('div', { class: 'mh', style: { padding: '4px 0' } }, g),
    h('div', { class: 'fgrid' }, ...STORED_KEYS.filter((k) => k.group === g).map((k) => {
      const el = k.options
        ? h('select', {}, h('option', { value: '' }, '—'), ...k.options.map((o) => h('option', { value: o, selected: values[k.key] === o }, o)))
        : h('input', { type: k.type || 'text', value: values[k.key] || '', placeholder: k.placeholder || k.hint || '', autocomplete: 'off' });
      inputs[k.key] = el;
      return h('div', { class: 'frow' }, h('label', {}, k.label), el);
    }))));
  const on = h('input', { type: 'checkbox', checked: enabled });
  const body = h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' } },
    h('p', { class: 'muted small', style: { margin: 0 } },
      'Ces informations servent à remplir automatiquement les formulaires. Elles restent uniquement sur cet ordinateur et ne sont jamais envoyées. ' +
      'Le lieu « Fait à » reprend votre ville et la date « Le » celle du jour.'),
    ...sections,
    h('label', { class: 'check-row' }, on, 'Proposer de mémoriser ce que je saisis et de remplir les formulaires reconnus'));
  const r = await openDialog({
    title: 'Mes informations', body, width: 640,
    buttons: [
      { label: 'Tout effacer', danger: true, value: 'clear', validate: () => confirm('Effacer toutes vos informations mémorisées ?') },
      { label: 'Annuler', value: null },
      { label: 'Enregistrer', primary: true, value: 'ok' },
    ],
  });
  if (!r) return null;
  const out = {};
  for (const [k, el] of Object.entries(inputs)) if (el.value.trim()) out[k] = el.value.trim();
  return { values: out, enabled: on.checked, clear: r === 'clear' };
}

export function shortcutsDialog() {
  const rows = [
    ['Ctrl+O', 'Ouvrir'], ['Ctrl+S', 'Enregistrer'], ['Ctrl+Maj+S', 'Enregistrer sous'], ['Ctrl+P', 'Imprimer'],
    ['Ctrl+Z / Ctrl+Y', 'Annuler / Rétablir'], ['Ctrl+F', 'Rechercher'], ['Ctrl + / Ctrl -', 'Zoom'], ['Ctrl+0', 'Zoom automatique'],
    ['Ctrl + molette', 'Zoom à la souris'], ['F4', 'Panneau latéral'], ['F5', 'Mode présentation'],
    ['V H T M', 'Sélection, main, texte, modifier le texte'], ['U D E', 'Surligner, dessiner, gomme'],
    ['R O L A', 'Rectangle, ellipse, ligne, flèche'], ['I S N K W C', 'Image, signature, commentaire, lien, masque, rogner'],
    ['F', 'Champs de formulaire (tracer / ajuster les zones)'], ['Tab / Maj+Tab', 'Champ suivant / précédent (pendant la saisie)'],
    ['Suppr', 'Supprimer la sélection'], ['Ctrl+C / X / V', 'Copier / couper / coller'], ['Ctrl+D', 'Dupliquer'],
    ['Flèches', 'Déplacer la sélection (Maj = ×10)'], ['Maj (en dessinant)', 'Contraindre (carré, 45°, proportions)'],
    ['Échap', 'Désélectionner / revenir à la sélection'], ['Page préc. / suiv., Début, Fin', 'Navigation'],
  ];
  const t = h('table', { class: 'kbd-table' }, ...rows.map(([k, v]) => h('tr', {}, h('td', { html: k.split(' / ').map((x) => `<kbd>${escapeHtml(x)}</kbd>`).join(' / ') }), h('td', {}, v))));
  return openDialog({ title: 'Raccourcis clavier', body: t, width: 560 });
}

export { formatBytes, icon };
