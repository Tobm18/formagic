// « Mes informations » : reconnaissance des champs d'identité (nom, prénom, e-mail, téléphone…)
// et profil mémorisé localement (IndexedDB) pour remplir automatiquement les prochains formulaires.
import { idbGet, idbSet } from './store.js';

/**
 * Informations reconnues, dans l'ordre d'affichage.
 * derived : calculée (jamais mémorisée) — le lieu de signature reprend la ville, la date est celle du jour.
 */
export const PROFILE_KEYS = [
  { key: 'civility', label: 'Civilité', options: ['Madame', 'Monsieur'], group: 'Identité' },
  { key: 'lastName', label: 'Nom', group: 'Identité', hint: 'Nom d’usage' },
  { key: 'birthName', label: 'Nom de naissance', group: 'Identité', hint: 'S’il diffère du nom d’usage' },
  { key: 'firstName', label: 'Prénom', group: 'Identité', hint: 'Prénom usuel' },
  { key: 'firstNames', label: 'Prénoms (état civil)', group: 'Identité', hint: 'Tous, dans l’ordre de l’acte de naissance' },
  { key: 'fullName', label: 'Nom et prénom', group: 'Identité', hint: 'Déduit du nom et du prénom s’il est vide' },
  { key: 'birthDate', label: 'Date de naissance', placeholder: 'JJ/MM/AAAA', group: 'Identité' },
  { key: 'birthPlace', label: 'Lieu de naissance', group: 'Identité', hint: 'Commune (département), pays' },
  { key: 'birthDatePlace', label: 'Date et lieu de naissance', derived: true },
  { key: 'nationality', label: 'Nationalité', group: 'Identité' },
  { key: 'maritalStatus', label: 'Situation familiale', group: 'Identité' },
  { key: 'email', label: 'E-mail', type: 'email', group: 'Coordonnées' },
  { key: 'phone', label: 'Téléphone portable', type: 'tel', group: 'Coordonnées' },
  { key: 'landline', label: 'Téléphone fixe', type: 'tel', group: 'Coordonnées' },
  { key: 'address', label: 'Adresse', group: 'Coordonnées' },
  { key: 'address2', label: 'Complément d’adresse', group: 'Coordonnées' },
  { key: 'postcode', label: 'Code postal', group: 'Coordonnées' },
  { key: 'city', label: 'Ville', group: 'Coordonnées' },
  { key: 'country', label: 'Pays', group: 'Coordonnées' },
  { key: 'profession', label: 'Profession', group: 'Activité' },
  { key: 'company', label: 'Entreprise / employeur', group: 'Activité' },
  { key: 'siret', label: 'N° SIRET', group: 'Activité' },
  { key: 'signPlace', label: 'Lieu de signature (« Fait à »)', derived: true },
  { key: 'today', label: 'Date du jour (« Le »)', derived: true },
];
export const keyLabel = (k) => PROFILE_KEYS.find((p) => p.key === k)?.label || k;
export const STORED_KEYS = PROFILE_KEYS.filter((p) => !p.derived);

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[’']/g, ' ').replace(/\s+/g, ' ').replace(/[\s:*]+$/, '').trim();

// Libellés qui parlent d'une autre personne ou d'un tiers que celle qui remplit
const OTHER_PARTY = /\b(enfant|conjoint|epoux|epouse|pere|mere|tuteur|beneficiaire|destinataire|expediteur|representant|officier|agent|medecin|notaire|banque|etablissement|organisme|bailleur|proprietaire|locataire|vendeur|acquereur|parrain|temoin|du responsable|de l association|du club)\b/;

/**
 * Information attendue par un champ, d'après son libellé et son type.
 * Renvoie { key, option? } (option : valeur d'une case à cocher, ex. « Madame »), ou null.
 */
export function classifyField(label, kind = 'text') {
  const l = norm(label);
  if (!l || l.length > 90) return null;
  if (kind === 'check') {
    if (/^(madame|mme|mlle|mademoiselle)$/.test(l)) return { key: 'civility', option: 'Madame' };
    if (/^(monsieur|m\.?|mr\.?)$/.test(l)) return { key: 'civility', option: 'Monsieur' };
    return null;
  }
  if (kind !== 'text' || OTHER_PARTY.test(l)) return null;
  const k = textKey(l);
  return k ? { key: k } : null;
}
function textKey(l) {
  if (/\b(e-?mail|courriel|mel)\b|adresse (electronique|mail)/.test(l)) return 'email';
  if (/\b(tel|telephone)\b.*\b(fixe|domicile)\b/.test(l)) return 'landline';
  if (/\b(telephone|tel|portable|mobile|gsm)\b/.test(l) && !/\bfax\b/.test(l)) return 'phone';
  // « Date et lieu de naissance » dans une seule zone : « 14/02/1990 à Lyon »
  // (posé sur des cases à chiffres, c'est la date seule : voir l'appelant)
  if (/date(s)? et lieu(x)? de naissance|\bnee? le .* a\b/.test(l)) return 'birthDatePlace';
  if (/date de naissance|\bnee? le\b|\bne\(e\) le\b/.test(l)) return 'birthDate';
  if (/(lieu|commune|ville|pays) de naissance|\bnee? a\b|\bne\(e\) a\b/.test(l)) return 'birthPlace';
  if (/nom de naissance|nom de jeune fille/.test(l)) return 'birthName';
  if (/nom ?(et|&|\/|,|-) ?prenom|prenoms? ?(et|&|\/|,|-) ?nom|nom complet|nom-prenom|identite du signataire|je soussigne/.test(l)) return 'fullName';
  // « Prénom » (usuel) ≠ « Prénoms », « Prénom(s) », « tous vos prénoms » (état civil)
  if (/prenom usuel|prenom d usage/.test(l)) return 'firstName';
  if (/prenoms\b|prenom ?\(s\)|prenom\/s|tous (les|vos) prenom/.test(l)) return 'firstNames';
  if (/prenom/.test(l)) return 'firstName';
  if (/\b(siret|siren)\b/.test(l)) return 'siret';
  if (/raison sociale|denomination sociale|\b(entreprise|societe|employeur)\b/.test(l)) return 'company';
  if (/\bnom\b/.test(l) && !/\b(rue|voie|commercial|du bien|de la|du logement|de l immeuble)\b/.test(l)) return 'lastName';
  if (/code postal|^c\.?p\.?$/.test(l)) return 'postcode';
  if (/complement d adresse|adresse \(suite\)|adresse ligne 2|^complement$/.test(l)) return 'address2';
  if (/^(votre |vos )?(ville|commune|localite)\b|ville de residence/.test(l)) return 'city';
  if (/^(votre )?pays\b|pays de residence/.test(l)) return 'country';
  if (/^(votre |vos )?(adresse|domicile)\b|adresse (postale|du domicile|de residence)/.test(l) && !/mail|electronique/.test(l)) return 'address';
  if (/nationalite/.test(l)) return 'nationality';
  if (/situation (familiale|matrimoniale)/.test(l)) return 'maritalStatus';
  if (/\b(profession|metier|emploi occupe|activite professionnelle)\b/.test(l)) return 'profession';
  if (/^fait a$/.test(l)) return 'signPlace';
  if (/^(le|fait le|date de signature|date de la signature|signe le)$/.test(l)) return 'today';
  return null;
}
/** Compatibilité : type d'information d'un libellé de champ texte. */
export const classifyLabel = (label) => classifyField(label, 'text')?.key || null;

/**
 * Valeurs à mémoriser pour une saisie : { clé: valeur } (vide si rien de valable).
 * « Date et lieu de naissance » saisis dans une seule zone sont séparés en date et lieu.
 */
export function learnValues(key, raw) {
  if (key === 'birthDatePlace') {
    const m = String(raw || '').trim().match(/^(\d{1,2}[\s./\-]+\d{1,2}[\s./\-]+\d{2,4}|\d{8})\s*(?:,|à|a|-)?\s*(.*)$/i);
    if (!m) return {};
    const out = {};
    const d = cleanValue('birthDate', m[1]);
    const p = cleanValue('birthPlace', m[2]);
    if (d) out.birthDate = d;
    if (p) out.birthPlace = p;
    return out;
  }
  const v = cleanValue(key, raw);
  return v ? { [key]: v } : {};
}

/** Valeur nettoyée et mise en forme pour le profil, ou null si elle n'a pas l'air valable pour ce type. */
export function cleanValue(key, raw) {
  const v = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!v || v.length > 120 || PROFILE_KEYS.find((p) => p.key === key)?.derived) return null;
  const digits = v.replace(/\D/g, '');
  switch (key) {
    case 'civility':
      return ['Madame', 'Monsieur'].includes(v) ? v : null;
    case 'email':
      return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? v : null;
    case 'phone': case 'landline': {
      if (digits.length < 8) return null;
      const d = v.replace(/[^\d+]/g, '');
      return /^0\d{9}$/.test(d) ? d.replace(/(\d{2})(?=\d)/g, '$1 ') : v;
    }
    case 'birthDate': {
      if (/^\d{8}$/.test(digits) && digits.length === v.replace(/[\s./\-]/g, '').length) return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
      const m = v.match(/^(\d{1,2})[\s./\-]+(\d{1,2})[\s./\-]+(\d{4})$/);
      if (m) return `${m[1].padStart(2, '0')}/${m[2].padStart(2, '0')}/${m[3]}`;
      return /\d/.test(v) && v.length <= 30 ? v : null;
    }
    case 'firstNames':
      return /\p{L}/u.test(v) ? v.replace(/\s*,\s*/g, ', ') : null;
    case 'postcode':
      return /^\d{4,5}$/.test(v.replace(/\s/g, '')) ? v.replace(/\s/g, '') : (/\d/.test(v) && v.length <= 10 ? v : null);
    case 'siret':
      return [9, 14].includes(digits.length) ? digits.replace(/^(\d{3})(\d{3})(\d{3})(\d*)$/, (m, a, b, c, d) => [a, b, c, d].filter(Boolean).join(' ')) : null;
    case 'address': case 'address2':
      return v;
    default:
      return /\p{L}/u.test(v) ? v : null;
  }
}

/** Date du jour au format JJ/MM/AAAA */
export function todayString(d = new Date()) {
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
/** Premier prénom d'une liste « Marie, Anne, Louise » ou « Marie Anne Louise » (les prénoms composés à tiret sont gardés). */
export const firstOf = (names) => String(names || '').trim().split(/\s*,\s*|\s+/)[0] || '';

/** Toutes les valeurs disponibles pour remplir : profil + valeurs déduites. */
export function fillValues(profile) {
  const v = { ...profile };
  // prénom usuel ↔ prénoms d'état civil
  if (!v.firstName && v.firstNames) v.firstName = firstOf(v.firstNames);
  if (!v.firstNames && v.firstName) v.firstNames = v.firstName;
  // nom d'usage ↔ nom de naissance (identiques pour la plupart des personnes ; l'aperçu permet de vérifier)
  if (!v.birthName && v.lastName) v.birthName = v.lastName;
  if (!v.lastName && v.birthName) v.lastName = v.birthName;
  if (v.birthDate && v.birthPlace) v.birthDatePlace = `${v.birthDate} à ${v.birthPlace}`;
  if (!v.fullName && v.firstName && v.lastName) v.fullName = `${v.firstName} ${v.lastName}`;
  if (v.city) v.signPlace = v.city;
  v.today = todayString();
  return v;
}

/** Valeur à écrire dans un champ : version « compacte » pour un peigne (une lettre par case). */
export function valueForField(key, value, cells) {
  if (!cells || value.length <= cells) return value;
  const compact = value.replace(/[\s./\-–_]/g, '');
  return compact.length <= cells ? compact : value.slice(0, cells);
}

// ---------- Stockage (IndexedDB, uniquement sur cet ordinateur) ----------
export async function getProfile() {
  const p = (await idbGet('profile')) || {};
  // Anciennes versions : un seul « Prénom(s) » qui pouvait contenir tous les prénoms → séparer usuel / état civil
  if (!p.firstNames && p.firstName && /[,\s]/.test(p.firstName.trim())) {
    p.firstNames = p.firstName.trim().replace(/\s*,\s*/g, ', ');
    p.firstName = firstOf(p.firstName);
    await idbSet('profile', p);
  }
  return p;
}
export async function saveProfile(values) {
  const clean = {};
  for (const { key } of STORED_KEYS) if (values[key]) clean[key] = values[key];
  await idbSet('profile', clean);
  return clean;
}
export async function mergeProfile(values) {
  return saveProfile({ ...(await getProfile()), ...values });
}
