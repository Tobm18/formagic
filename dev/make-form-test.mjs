// Génère dev/test/flatform.pdf : formulaire « à plat » (page 1) + vrais champs AcroForm dont une signature (page 2)
// Usage : node dev/make-form-test.mjs
import { copyFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// pdf-lib de l'extension (module ES en .js) : on le copie en .mjs pour que Node l'importe
const tmp = mkdtempSync(path.join(tmpdir(), 'pa-'));
copyFileSync(path.join(here, '..', 'lib', 'pdf-lib', 'pdf-lib.esm.min.js'), path.join(tmp, 'pdf-lib.mjs'));
const { PDFDocument, StandardFonts, rgb, PDFString, PDFName } = await import(pathToFileURL(path.join(tmp, 'pdf-lib.mjs')).href);

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);
const black = rgb(0, 0, 0), grey = rgb(0.45, 0.45, 0.45);

// ---------- Page 1 : formulaire à plat ----------
{
  const p = doc.addPage([595.28, 841.89]);
  const t = (s, x, y, o = {}) => p.drawText(s, { x, y, size: o.size || 11, font: o.bold ? bold : font, color: o.color || black });
  const line = (x1, y, x2, th = 0.7) => p.drawLine({ start: { x: x1, y }, end: { x: x2, y }, thickness: th, color: black });
  const box = (x, y, w, h, th = 0.8) => p.drawRectangle({ x, y, width: w, height: h, borderColor: black, borderWidth: th });

  t('Bulletin d\'inscription — Saison 2026-2027', 60, 790, { size: 18, bold: true });
  t('Merci de remplir ce bulletin en lettres capitales et de le retourner signé.', 60, 768, { size: 10, color: grey });
  line(60, 758, 535, 1.2); // séparateur : ne doit PAS devenir un champ

  t('Nom : ______________________________', 60, 728);
  t('Prénom : .................................................................', 300, 728);
  t('Adresse :', 60, 700); line(112, 698, 535);
  t('Code postal :', 60, 672); line(132, 670, 230);
  t('Ville :', 250, 672); line(285, 670, 535);

  // Cadre avec libellé intérieur (style CERFA)
  box(60, 600, 230, 44); t('Téléphone', 64, 634, { size: 7, color: grey });
  box(305, 600, 230, 44); t('Adresse e-mail', 309, 634, { size: 7, color: grey });

  // Cases à cocher dessinées
  t('Type de licence :', 60, 572, { bold: true });
  const cb = (x, y, label) => { box(x, y - 1, 10, 10, 0.8); t(label, x + 15, y); };
  cb(60, 552, 'Loisir'); cb(160, 552, 'Compétition'); cb(290, 552, 'Dirigeant');

  // Tableau : en-tête + 3 lignes vides
  t('Membres de la famille déjà inscrits :', 60, 520, { bold: true });
  const cols = [60, 230, 380, 535], rows = [505, 485, 465, 445, 425];
  for (const y of rows) line(cols[0], y, cols[3], 0.8);
  for (const x of cols) p.drawLine({ start: { x, y: rows[0] }, end: { x, y: rows[4] }, thickness: 0.8, color: black });
  t('Nom et prénom', 64, 491, { size: 10, bold: true }); t('Date de naissance', 234, 491, { size: 10, bold: true }); t('N° de licence', 384, 491, { size: 10, bold: true });

  cb(60, 395, 'J\'accepte le règlement intérieur du club');
  cb(60, 377, 'J\'autorise la publication de photos');

  t('Fait à ____________________ le ______________', 60, 340);
  t('Signature du licencié :', 60, 305);
  box(60, 230, 220, 65);
  // ligne de signature avec le libellé dessous
  line(330, 250, 535);
  t('Signature du responsable légal', 350, 238, { size: 9, color: grey });

  t('Cadre réservé au club', 60, 190, { size: 9, bold: true, color: grey });
  box(60, 120, 475, 62, 0.6);
  t('Reçu le :', 66, 166, { size: 9 }); t('Montant :', 300, 166, { size: 9 });
  t('Page 1 / 3', 270, 40, { size: 9, color: grey });
}

// ---------- Page 2 : vrais champs AcroForm + signature native ----------
{
  const p = doc.addPage([595.28, 841.89]);
  p.drawText('Formulaire avec champs PDF natifs', { x: 60, y: 790, size: 18, font: bold });
  p.drawText('Nom complet :', { x: 60, y: 742, size: 11, font });
  p.drawText('Je certifie l\'exactitude des informations :', { x: 60, y: 702, size: 11, font });
  p.drawText('Signature :', { x: 60, y: 652, size: 11, font });
  const form = doc.getForm();
  const nm = form.createTextField('nom_complet');
  nm.addToPage(p, { x: 145, y: 735, width: 250, height: 20 });
  const ok = form.createCheckBox('certifie');
  ok.addToPage(p, { x: 290, y: 698, width: 14, height: 14 });
  // Champ de signature numérique (/FT /Sig), non rempli
  const sig = doc.context.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig', T: PDFString.of('signature_client'),
    Rect: [130, 600, 360, 665], F: 4, P: p.ref,
    MK: { BC: [0, 0, 0] }, Border: [0, 0, 1],
  });
  const ref = doc.context.register(sig);
  p.node.addAnnot(ref);
  form.acroForm.addField(ref);
  p.drawRectangle({ x: 130, y: 600, width: 230, height: 65, borderColor: grey, borderWidth: 0.5 });
  p.drawText('Page 2 / 3', { x: 270, y: 40, size: 9, font, color: grey });
  void PDFName;
}

// ---------- Page 3 : champs « en peigne » (un caractère par case) ----------
{
  const p = doc.addPage([595.28, 841.89]);
  const navy = rgb(0.17, 0.2, 0.42);
  const t = (s, x, y, size = 13) => { p.drawText(s, { x, y, size, font, color: navy }); return x + font.widthOfTextAtSize(s, size); };
  p.drawText('Champs en peigne', { x: 60, y: 790, size: 18, font: bold });

  // 1. Peigne tapé au clavier, d'un seul tenant
  t('Numéro de téléphone : |__|__|__|__|__|__|__|__|__|__|', 60, 740);

  // 2. Date : grands traits entre JJ / MM / AAAA, petits traits (police plus petite) entre les chiffres
  let x = t('Vos date et lieu de naissance : ', 60, 700);
  const minor = [1, 3, 5, 6, 7];
  x = t('|', x, 700);
  for (let i = 0; i < 8; i++) {
    x = t('__', x, 700);
    x = minor.includes(i + 1) ? t('|', x, 700, 6) : t('|', x, 700);
  }

  // 3. Peigne avec la lettre I comme séparateur (certaines polices)
  t('Code : I__I__I__I__I', 60, 660);

  // 4. Peigne vectoriel : ligne de base + traits verticaux (grands / petits)
  t('Code client :', 60, 620);
  { const x0 = 150, cw = 14, n = 8, y = 618;
    p.drawLine({ start: { x: x0, y }, end: { x: x0 + cw * n, y }, thickness: 0.8, color: navy });
    for (let i = 0; i <= n; i++) {
      const h = (i === 0 || i === n || i === 4) ? 9 : 4;
      p.drawLine({ start: { x: x0 + cw * i, y }, end: { x: x0 + cw * i, y: y + h }, thickness: 0.8, color: navy });
    } }

  // 5. Cases CERFA accolées, en groupes (n° de sécurité sociale : 1 2 2 2 3 3 | 2)
  t('N° de sécurité sociale :', 60, 576, 11);
  { let bx = 200; const y = 570, w = 11, h = 15;
    for (const g of [1, 2, 2, 2, 3, 3]) {
      for (let i = 0; i < g; i++) { p.drawRectangle({ x: bx, y, width: w, height: h, borderColor: navy, borderWidth: 0.7 }); bx += w; }
      bx += 5;
    }
    bx += 10;
    for (let i = 0; i < 2; i++) { p.drawRectangle({ x: bx, y, width: w, height: h, borderColor: navy, borderWidth: 0.7 }); bx += w; } }

  // 6. Témoins : cases à cocher espacées (ne doivent PAS devenir un peigne) et un souligné classique
  const cb = (cx, cy, label) => { p.drawRectangle({ x: cx, y: cy - 1, width: 10, height: 10, borderColor: navy, borderWidth: 0.8 }); t(label, cx + 15, cy, 11); };
  cb(60, 530, 'Oui'); cb(110, 530, 'Non'); cb(160, 530, 'Ne sait pas');
  t('Profession : ______________________________', 60, 495, 11);
  p.drawText('Page 3 / 3', { x: 270, y: 40, size: 9, font, color: grey });
}

const out = path.join(here, 'test', 'flatform.pdf');
writeFileSync(out, await doc.save());
console.log('écrit :', out);
