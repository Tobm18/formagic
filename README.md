# Formagic

Lecteur et éditeur PDF pour Chrome, gratuit, open source et 100 % local (aucun fichier n'est envoyé où que ce soit).
Formagic détecte les champs des formulaires, même « à plat » (lignes, pointillés, cases, peignes), pour les remplir,
signer et annoter, puis enregistre un PDF ordinaire.

> **English** — Formagic is a free, open-source Chrome extension (Manifest V3) to read, annotate, sign and fill any PDF,
> including flat, non-interactive forms whose fields are detected automatically. Everything runs locally in the browser;
> no file ever leaves your computer. The interface is in French for now. Licensed under Apache 2.0.

## Installation

1. Télécharger le dernier `Formagic-x.y.z.zip` dans les [Releases](https://github.com/Tobm18/formagic/releases) et le
   décompresser (ou cloner ce dépôt)
2. Ouvrir `chrome://extensions` et activer **Mode développeur** (en haut à droite)
3. **Charger l'extension non empaquetée** → choisir le dossier décompressé (ou le dossier du dépôt)
4. Dans les détails de l'extension, activer **Autoriser l'accès aux URL de fichier** (pour ouvrir les PDF de votre disque)
5. Épingler l'icône dans la barre d'outils

Tous les liens `.pdf` et les PDF servis par les sites s'ouvrent alors dans Formagic.
L'interception se coupe depuis la fenêtre de l'icône, et le menu ⋮ propose « Ouvrir avec le lecteur de Chrome ».

## Raccourcis principaux

| Touche | Outil | Touche | Outil |
|---|---|---|---|
| V | Sélection | H | Main (déplacement) |
| T | Texte | M | Modifier le texte existant |
| U | Surligner | D | Stylo |
| E | Gomme | R / O | Rectangle / Ellipse |
| L / A | Ligne / Flèche | I | Image |
| S | Signature | N | Note |
| K | Lien | W | Masquer (blanc) |
| C | Rogner | F | Champs de formulaire |

La pastille d'une miniature indique le nombre de **modifications non enregistrées** de la page ; elle disparaît à l'enregistrement.

`Ctrl+S` enregistrer (même pendant la saisie dans un champ) · `Ctrl+Maj+S` enregistrer sous · `Ctrl+Z / Ctrl+Y` annuler / rétablir · `Ctrl+F` rechercher · `Ctrl+molette` zoom · `F5` présentation · `?` toutes les touches.

## Formulaires

À l'ouverture, Formagic repère les champs des formulaires, même « à plat » (non interactifs) :

- **zones bleues** (lignes `____`, pointillés, cadres, cellules vides) : cliquer pour écrire, `Tab` / `Entrée` pour passer au champ suivant ;
- **champs en peigne** (`|__|__|__|`, petites cases accolées, traits sur une ligne) : une lettre par case ; un clic sur une case y place le curseur, la frappe remplace le caractère, et un numéro collé avec espaces ou `/` est rangé automatiquement ;
- **cases à cocher** : un clic coche, un autre décoche (clic droit : ✓ ou ✗) ;
- **zones jaunes « Signer ici »** : un clic ouvre la signature, qui est ajustée au cadre.

Les vrais champs PDF (AcroForm) restent remplissables comme avant. L'outil **Champs (F)** permet de tracer, déplacer, redimensionner ou supprimer des zones ; menu ⋮ › Formulaire pour relancer la détection ou masquer les zones. Les zones ne sont jamais enregistrées ni imprimées : seul le contenu saisi l'est. La détection est heuristique : sur un scan, seuls les lignes et les cadres sont repérés.

## Mes informations (remplissage automatique)

Quand vous remplissez un champ reconnu (nom, prénom, e-mail, téléphone…), une carte en haut à droite propose de le
**mémoriser** (chaque information peut être décochée ; la valeur déjà mémorisée est affichée en cas de mise à jour).

À l'ouverture d'un autre formulaire, rien n'est rempli sans vous : chaque champ concerné est **encadré en violet avec un
aperçu de la valeur**, et une pastille **« ✨ Remplir »** sous le champ le remplit seul (× pour l'ignorer). La carte en haut
à droite liste tous ces champs (un clic sur une ligne y amène) et propose **Tout remplir** (un seul Ctrl+Z annule tout).

- Informations reconnues : civilité (cases Madame / Monsieur), nom d'usage, nom de naissance, prénom usuel, prénoms
  d'état civil, nom et prénom, date et lieu de naissance, nationalité, situation familiale, e-mail, téléphones portable
  et fixe, adresse et complément, code postal, ville, pays, profession, entreprise, SIRET. « Fait à » reçoit votre ville
  et « Le » la date du jour.
- **Prénom ou prénoms** : un champ « Prénom » reçoit le prénom usuel, un champ « Prénoms » / « Prénom(s) » la liste
  complète de l'état civil. Si une seule des deux est connue, l'autre en est déduite (premier prénom de la liste).
- **Date et lieu de naissance** : une zone unique reçoit « 14/02/1990 à Lyon » ; des cases à chiffres reçoivent la date
  et la ligne « à … » qui suit reçoit le lieu. Le nom de naissance reprend le nom s'il n'est pas renseigné (et inversement).
- Seule la **première** occurrence de chaque information est remplie : le second partenaire d'un Pacs, un enfant,
  un tiers ou les colonnes d'un tableau restent vides.
- Les données restent **uniquement sur cet ordinateur**. Menu ⋮ › Formulaire › **Mes informations…** pour les voir,
  les corriger, tout effacer ou désactiver les propositions ; **Remplir avec mes informations** pour relancer le remplissage.
- Volontairement non mémorisés : n° de sécurité sociale, IBAN, numéros fiscaux et autres données sensibles.

## Enregistrer puis corriger plus tard

Le PDF enregistré est un PDF ordinaire, sans donnée cachée. À la réouverture, les champs **déjà remplis**
sont détectés comme les champs vides : un clic sur la valeur imprimée la rend modifiable (elle est masquée
et remplacée par la nouvelle saisie), un clic sur une case cochée la décoche, et une signature peut être remplacée.
Cela marche aussi pour un formulaire rempli avec un autre logiciel, tant que la valeur est du vrai texte.

Pour tout autre texte de la page, l'outil **Modifier le texte (M)** reste disponible.

**Ctrl+S sur un fichier du disque** : un PDF ouvert par le bouton Ouvrir, par glisser-déposer ou depuis les récents est
réécrit directement. Un PDF ouvert d'un double-clic dans l'Explorateur (adresse `file:///`) ne peut pas être modifié
par une extension sans votre accord : au premier Ctrl+S, le sélecteur propose le même nom, choisissez le fichier d'origine
pour l'écraser. Formagic s'en souvient : les Ctrl+S suivants, et ceux des prochaines ouvertures de ce fichier,
l'enregistrent directement (Chrome peut seulement demander d'autoriser la modification).

## Performances (écran 4K)

- ⋮ › Paramètres › **Qualité d'affichage** : « Équilibrée » ou « Performance » si le défilement manque de fluidité.
- Windows › Paramètres › Système › Affichage › Graphiques : régler Chrome sur **Hautes performances** (GPU NVIDIA).

## Limites connues

- Le texte ajouté utilise les polices standard PDF (Helvetica, Times, Courier) : alphabet latin (accents français, €, etc.).
- « Modifier le texte » recouvre la ligne d'origine par une nouvelle zone de texte (le PDF ne stocke pas de paragraphes éditables).
- Le caviardage transforme la page concernée en image pour que le texte masqué disparaisse réellement.

## Développement

L'extension est du JavaScript (modules ES) sans étape de compilation : le dossier du dépôt se charge tel quel dans
Chrome. Les bibliothèques sont fournies dans `lib/` ([PDF.js](https://github.com/mozilla/pdf.js) pour l'affichage,
[@cantoo/pdf-lib](https://github.com/cantoo-scribe/pdf-lib) pour l'écriture).

| Dossier / fichier | Rôle |
|---|---|
| `manifest.json`, `background.js` | Extension MV3 : interception des PDF, menus, service worker |
| `viewer.html`, `js/app.js` | Lecteur : ouverture, enregistrement, impression, Mes informations |
| `js/annotations.js`, `js/state.js` | Annotations, champs, annuler / rétablir |
| `js/formdetect.js` | Détection heuristique des champs de formulaire |
| `js/profile.js`, `js/store.js` | Profil de remplissage et stockage local (IndexedDB) |
| `dev/` | Serveur de test, génération des PDF de test et des icônes, packaging (non inclus dans le paquet) |

Hors extension, avec Node 22 ou plus récent :

```bash
node dev/serve.mjs
```

puis ouvrir http://localhost:8765/viewer.html?file=/dev/test/sample.pdf (`PORT=…` pour changer de port).

Formulaires de test : `node dev/make-form-test.mjs` (formulaire vierge `flatform.pdf`) puis
`node dev/make-filled-test.mjs` (même formulaire rempli par « un autre logiciel » : `flatform-rempli.pdf`).
Les autres PDF de test se régénèrent avec `node dev/make-test-pdfs.mjs` (après `npm install` dans `dev/`).
Chaque champ détecté porte `src` : la règle qui l'a produit. Placez dans `dev/test/local/` (ignoré par git) les PDF
réels qui servent à vérifier la détection, notamment des documents longs sans formulaire, pour repérer les faux champs
(sommaire, tableaux, encadrés, schémas, graphiques).

Paquet à installer ou à publier (sans `dev/`) :

```bash
node dev/package.mjs
```

→ `dist/Formagic-<version>.zip`, la version étant celle de `manifest.json`.

La clé publique `key` de `manifest.json` fixe l'identifiant de l'extension non empaquetée
(`hmlfboamiccijpnnndpadfnljonaekna`), quel que soit le dossier : déplacer ou renommer le dossier ne fait donc
pas perdre les données locales. Elle doit être retirée du manifeste pour une publication sur le Chrome Web Store.

## Contribuer

Les signalements de bugs (avec, si possible, un PDF d'exemple sans données personnelles) et les pull requests sont
les bienvenus. Formagic doit rester **local** : aucune requête réseau vers un service tiers, aucune télémétrie.

## Licence

[Apache License 2.0](LICENSE). Les bibliothèques fournies dans `lib/` gardent leur propre licence : voir
[NOTICE](NOTICE) et [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
