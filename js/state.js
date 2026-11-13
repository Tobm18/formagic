// État global partagé + historique (annuler / rétablir)

export const S = {
  // Document courant
  doc: null,            // { bytes, name, url, handle, pdf, fingerprint, sessionKey, password, encrypted, size }
  pages: [],            // [{ id, baseRot, rot }] — aligné sur les pages du PDF courant
  annots: [],           // annotations (données pures, coordonnées en points dans l'espace « base » de la page)
  images: new Map(),    // imageId -> { bytes, mime, url }
  docSettings: defaultDocSettings(),
  // UI
  tool: 'select',
  selection: new Set(),
  dirty: false,
  // PDF.js
  pdfjsLib: null,
  viewer: null,
  eventBus: null,
  linkService: null,
  findController: null,
};

export function defaultDocSettings() {
  return {
    watermark: null,    // { text, size, color, opacity, angle }
    pageNumbers: null,  // { format, position, size, color, start, skipFirst }
    meta: null,         // { title, author, subject, keywords }
    protect: null,      // { userPassword, ownerPassword, noPrint, noCopy, noModify }
  };
}

// ---------- Modifications depuis le dernier enregistrement ----------
// Empreinte de chaque annotation au moment de l'ouverture ou du dernier enregistrement.
let savedState = new Map(); // id -> { sig, pageId, unit }
const unitOf = (a) => a.fieldId || a.id; // un champ rempli = une modification, quel que soit le nombre d'objets
const sigOf = (a) => JSON.stringify(a);
/** À appeler après un enregistrement (ou à l'ouverture) : l'état actuel devient la référence. */
export function markSaved(annots = S.annots) {
  savedState = new Map(annots.filter((a) => a.type !== 'field').map((a) => [a.id, { sig: sigOf(a), pageId: a.pageId, unit: unitOf(a) }]));
  emit('saved');
}
/** Nombre de modifications non enregistrées par page (ajouts, changements, suppressions). */
export function unsavedByPage() {
  const units = new Map(); // pageId -> Set(unit)
  const add = (pageId, unit) => { if (!units.has(pageId)) units.set(pageId, new Set()); units.get(pageId).add(unit); };
  const present = new Set();
  for (const a of S.annots) {
    if (a.type === 'field') continue;
    present.add(a.id);
    if (savedState.get(a.id)?.sig !== sigOf(a)) add(a.pageId, unitOf(a));
  }
  for (const [id, s] of savedState) if (!present.has(id)) add(s.pageId, s.unit);
  return new Map([...units].map(([k, v]) => [k, v.size]));
}

// ---------- Bus d'événements ----------
const bus = new EventTarget();
export function on(name, fn) { bus.addEventListener(name, (e) => fn(e.detail)); }
export function emit(name, detail) { bus.dispatchEvent(new CustomEvent(name, { detail })); }

// ---------- Utilitaires de pages ----------
export function pageIndexOf(pageId) { return S.pages.findIndex((p) => p.id === pageId); }
export function pageAt(index) { return S.pages[index]; }
export function annotsOfPage(pageId) { return S.annots.filter((a) => a.pageId === pageId); }
export function getAnnot(id) { return S.annots.find((a) => a.id === id); }

// ---------- Historique ----------
const MAX_HISTORY = 80;
const undoStack = [];
const redoStack = [];
let restoreFn = null;
export function setRestoreHandler(fn) { restoreFn = fn; }

function snapshot() {
  return {
    bytes: S.doc?.bytes,
    pages: structuredClone(S.pages),
    annots: structuredClone(S.annots),
    docSettings: structuredClone(S.docSettings),
  };
}

/** À appeler AVANT toute modification. */
export function checkpoint() {
  if (!S.doc) return;
  undoStack.push({ ...snapshot(), wasDirty: S.dirty });
  if (undoStack.length > MAX_HISTORY) undoStack.shift();
  redoStack.length = 0;
  markDirty();
}
/** Annule le dernier checkpoint s'il n'a mené à aucun changement (le document redevient « non modifié » s'il l'était). */
export function dropCheckpoint() {
  const cp = undoStack.pop();
  if (cp && !cp.wasDirty && S.dirty) { S.dirty = false; emit('dirty'); }
  emit('history');
}
export function markDirty() {
  S.dirty = true;
  emit('dirty');
  emit('history');
}
export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  emit('history');
}
export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;

export async function undo() {
  if (!undoStack.length || !restoreFn) return;
  redoStack.push(snapshot());
  await restoreFn(undoStack.pop());
  markDirty();
}
export async function redo() {
  if (!redoStack.length || !restoreFn) return;
  undoStack.push(snapshot());
  await restoreFn(redoStack.pop());
  markDirty();
}
