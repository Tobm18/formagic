// Stockage local (IndexedDB) : sessions de travail, signatures, fichiers récents
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open('pdf-atelier', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}
async function tx(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction('kv', mode);
    const store = t.objectStore('kv');
    const req = fn(store);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}
export async function idbGet(key) {
  try { return await tx('readonly', (s) => s.get(key)); } catch { return undefined; }
}
export async function idbSet(key, val) {
  try { await tx('readwrite', (s) => s.put(val, key)); return true; } catch (e) { console.warn('IDB', e); return false; }
}
export async function idbDel(key) {
  try { await tx('readwrite', (s) => s.delete(key)); } catch {}
}
export async function idbKeys(prefix = '') {
  try {
    const keys = await tx('readonly', (s) => s.getAllKeys());
    return (keys || []).filter((k) => String(k).startsWith(prefix));
  } catch { return []; }
}

// ---------- Fichiers récents ----------
// Un même document peut être ouvert de plusieurs façons : lien (avec ou sans #page=…, encodé ou non),
// double-clic dans l'Explorateur (file:///, casse variable sous Windows), bouton Ouvrir ou glisser-déposer
// (poignée de fichier sans chemin). On les reconnaît pour n'avoir qu'une ligne par document.
function normUrl(u) {
  if (!u || /^blob:/i.test(u)) return null;
  let s = String(u).replace(/#.*$/, '');
  try { s = decodeURI(s); } catch {}
  if (/^file:/i.test(s)) return s.replace(/\\/g, '/').replace(/^file:\/+/i, 'file:///').toLowerCase();
  try { const x = new URL(s); x.hostname = x.hostname.toLowerCase(); return x.href; } catch { return s; }
}
async function sameDoc(a, b) {
  if (a.handle && b.handle) {
    try { if (await a.handle.isSameEntry(b.handle)) return true; } catch {}
  }
  // Identité certaine uniquement : même chemin absolu / même lien, ou même fichier sur le disque.
  // (Aucune supposition sur le nom : deux fichiers homonymes de dossiers différents restent distincts.)
  const ua = normUrl(a.url), ub = normUrl(b.url);
  if (ua && ub) return ua === ub;
  // Chemin file:/// d'un côté, fichier ouvert par le bouton Ouvrir de l'autre : même fichier seulement si
  // ce chemin a déjà été associé à ce fichier (Ctrl+S sur l'original)
  const [withUrl, other] = ua ? [a, b] : [b, a];
  if ((ua || ub) && other.handle && /^file:/.test(ua || ub)) {
    const known = await getFileHandle(withUrl.url);
    try { return !!known && await known.isSameEntry(other.handle); } catch { return false; }
  }
  return false;
}
/** Fusionne deux entrées du même document (la plus récente d'abord) : on garde le chemin et la poignée. */
const mergeDoc = (recent, older) => ({ ...older, ...recent, url: recent.url || older.url || null, handle: recent.handle || older.handle || null });

async function dedupe(list) {
  const out = [];
  for (const e of list) {
    let merged = false;
    for (let i = 0; i < out.length; i++) {
      if (await sameDoc(out[i], e)) { out[i] = mergeDoc(out[i], e); merged = true; break; }
    }
    if (!merged) out.push(e);
  }
  return out;
}
export async function getRecent() {
  const list = (await idbGet('recent')) || [];
  const clean = await dedupe(list);
  if (clean.length !== list.length) await idbSet('recent', clean); // doublons des versions précédentes
  return clean;
}
export async function addRecent(entry) {
  // entry: { id, name, url?, handle?, size }
  const list = (await idbGet('recent')) || [];
  let item = { ...entry, time: Date.now() };
  const rest = [];
  for (const e of list) {
    if (await sameDoc(item, e)) item = { ...mergeDoc(item, e), id: e.id }; // garde l'identifiant de la ligne existante
    else rest.push(e);
  }
  await idbSet('recent', [item, ...rest].slice(0, 12));
}
export async function removeRecent(id) {
  const list = (await getRecent()).filter((e) => e.id !== id);
  await idbSet('recent', list);
}

// ---------- Fichiers locaux (file:///) ----------
// Chrome n'autorise pas l'écriture dans un file:/// ouvert par URL : une fois que l'utilisateur a désigné
// le fichier dans le sélecteur, on mémorise sa poignée pour que les Ctrl+S suivants l'écrasent directement.
const dirOf = (url) => url.replace(/[?#].*$/, '').replace(/[^/]*$/, '').toLowerCase();
const keyOf = (url) => url.replace(/[?#].*$/, '').toLowerCase();
export async function getFileHandle(url) {
  const list = (await idbGet('fileHandles')) || [];
  return list.find((e) => e.key === keyOf(url))?.handle || null;
}
/** Une poignée d'un fichier du même dossier, pour ouvrir le sélecteur au bon endroit. */
export async function getDirHint(url) {
  const list = (await idbGet('fileHandles')) || [];
  return list.find((e) => e.dir === dirOf(url))?.handle || null;
}
export async function setFileHandle(url, handle) {
  let list = (await idbGet('fileHandles')) || [];
  list = list.filter((e) => e.key !== keyOf(url));
  list.unshift({ key: keyOf(url), dir: dirOf(url), handle });
  await idbSet('fileHandles', list.slice(0, 60));
}

// ---------- Signatures ----------
export async function getSignatures() {
  return (await idbGet('signatures')) || [];
}
export async function saveSignatures(list) {
  await idbSet('signatures', list.slice(0, 16));
}

// ---------- Sessions (restauration des modifications non enregistrées) ----------
export async function saveSession(key, data) {
  await idbSet('session:' + key, { ...data, savedAt: Date.now() });
  // Purge : on garde les 15 plus récentes
  const keys = await idbKeys('session:');
  if (keys.length > 15) {
    const items = await Promise.all(keys.map(async (k) => [k, (await idbGet(k))?.savedAt || 0]));
    items.sort((a, b) => b[1] - a[1]);
    for (const [k] of items.slice(15)) await idbDel(k);
  }
}
export const loadSession = (key) => idbGet('session:' + key);
export const deleteSession = (key) => idbDel('session:' + key);
