// Sauvegarde / restauration des données locales (Mes informations, signatures, récents, réglages) dans un fichier JSON.
// Sert à passer d'une installation à une autre (nouvel ordinateur, nouveau dossier d'extension…).
// Les poignées de fichiers du disque ne peuvent pas être exportées : il faudra rouvrir ces fichiers une fois.
import { idbGet, idbSet, getRecent } from './store.js';

const FORMAT = 'formagic-backup';
const LOCAL_KEYS = ['pa-settings', 'pa-toolprops'];

// Octets (signatures) ↔ base64, pour que le fichier reste du JSON lisible
function encode(v) {
  if (v instanceof Uint8Array) {
    let s = '';
    for (let i = 0; i < v.length; i += 0x8000) s += String.fromCharCode(...v.subarray(i, i + 0x8000));
    return { $bytes: btoa(s) };
  }
  if (v instanceof ArrayBuffer) return encode(new Uint8Array(v));
  if (ArrayBuffer.isView(v)) return encode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  if (typeof FileSystemHandle !== 'undefined' && v instanceof FileSystemHandle) return null;
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, encode(x)]));
  return v;
}
function decode(v) {
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    if (typeof v.$bytes === 'string') return Uint8Array.from(atob(v.$bytes), (c) => c.charCodeAt(0));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, decode(x)]));
  }
  return v;
}

/** Rassemble les données à exporter. */
export async function collect() {
  const local = {};
  for (const k of LOCAL_KEYS) { try { const v = localStorage.getItem(k); if (v != null) local[k] = v; } catch {} }
  let chromeLocal = null;
  try { if (globalThis.chrome?.storage?.local) chromeLocal = await chrome.storage.local.get(null); } catch {}
  // Récents : seuls ceux qui ont une adresse (lien ou chemin file:///) peuvent être rouverts ailleurs
  const recent = (await getRecent()).filter((e) => e.url).map(({ handle, ...e }) => e);
  return encode({
    format: FORMAT, version: 1, exportedAt: new Date().toISOString(),
    profile: (await idbGet('profile')) || {},
    signatures: (await idbGet('signatures')) || [],
    recent, local, chromeLocal,
  });
}

export function summary(data) {
  const n = Object.keys(data.profile || {}).length, s = (data.signatures || []).length, r = (data.recent || []).length;
  return `${n} information${n > 1 ? 's' : ''}, ${s} signature${s > 1 ? 's' : ''}, ${r} fichier${r > 1 ? 's' : ''} récent${r > 1 ? 's' : ''}`;
}

export function parse(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Ce fichier n\'est pas une sauvegarde Formagic.'); }
  if (data?.format !== FORMAT) throw new Error('Ce fichier n\'est pas une sauvegarde Formagic.');
  return decode(data);
}

/** Restaure une sauvegarde en la fusionnant avec les données actuelles (la sauvegarde l'emporte en cas de conflit). */
export async function restore(data) {
  await idbSet('profile', { ...((await idbGet('profile')) || {}), ...(data.profile || {}) });
  const sigs = (await idbGet('signatures')) || [];
  const ids = new Set(sigs.map((s) => s.id));
  await idbSet('signatures', [...sigs, ...(data.signatures || []).filter((s) => !ids.has(s.id))].slice(0, 16));
  const cur = (await idbGet('recent')) || [];
  await idbSet('recent', [...cur, ...(data.recent || [])]);
  await getRecent(); // fusionne les doublons
  for (const [k, v] of Object.entries(data.local || {})) {
    if (!LOCAL_KEYS.includes(k)) continue;
    try { localStorage.setItem(k, k === 'pa-settings' ? JSON.stringify({ ...JSON.parse(localStorage.getItem(k) || '{}'), ...JSON.parse(v) }) : v); } catch {}
  }
  try { if (data.chromeLocal && globalThis.chrome?.storage?.local) await chrome.storage.local.set(data.chromeLocal); } catch {}
}
