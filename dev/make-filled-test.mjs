// Génère dev/test/flatform-rempli.pdf : flatform.pdf rempli « par un autre logiciel »
// (vrai texte posé sur les champs, croix dans les cases, gribouillis de signature).
// Sert à vérifier que Formagic détecte les champs déjà remplis et rend leur valeur modifiable.
// Usage : node dev/make-form-test.mjs && node dev/make-filled-test.mjs
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = mkdtempSync(path.join(tmpdir(), 'pa-'));
copyFileSync(path.join(here, '..', 'lib', 'pdf-lib', 'pdf-lib.esm.min.js'), path.join(tmp, 'pdf-lib.mjs'));
const { PDFDocument, StandardFonts, rgb } = await import(pathToFileURL(path.join(tmp, 'pdf-lib.mjs')).href);

const doc = await PDFDocument.load(readFileSync(path.join(here, 'test', 'flatform.pdf')));
const helv = await doc.embedFont(StandardFonts.Helvetica);
const cour = await doc.embedFont(StandardFonts.Courier);
const ink = rgb(0.05, 0.1, 0.45);
const [p1, , p3] = doc.getPages();

const put = (p, s, x, y, size = 11) => p.drawText(s, { x, y, size, font: cour, color: ink });
const cross = (p, x, y, s = 10) => {
  p.drawLine({ start: { x: x + 2, y: y + 2 }, end: { x: x + s - 2, y: y + s - 2 }, thickness: 1.2, color: ink });
  p.drawLine({ start: { x: x + 2, y: y + s - 2 }, end: { x: x + s - 2, y: y + 2 }, thickness: 1.2, color: ink });
};
const after = (s, x, size = 11) => x + helv.widthOfTextAtSize(s, size);

// ---------- Page 1 ----------
put(p1, 'DUPONT', after('Nom : ', 60) + 6, 730);
put(p1, 'Marie', after('Prénom : ', 300) + 10, 730);
put(p1, '12 rue des Lilas', 118, 700);
put(p1, '75011', 140, 672);
put(p1, 'Paris', 292, 672);
put(p1, '06 12 34 56 78', 66, 612);
cross(p1, 160, 551);                       // Compétition
put(p1, 'Martin Dupont', 64, 471, 10);     // tableau, 1re ligne
put(p1, '03/04/2015', 234, 471, 10);
cross(p1, 60, 394);                        // règlement accepté
put(p1, 'Lyon', after('Fait à ', 60) + 10, 342);
put(p1, '12/11/2026', after('Fait à ____________________ le ', 60) + 6, 342);
p1.drawSvgPath('M 0 0 C 20 -30 40 25 60 -5 S 100 -25 120 5 C 135 20 150 -15 170 0', {
  x: 85, y: 262, borderColor: ink, borderWidth: 1.4,
});
put(p1, '10/11/2026', after('Reçu le : ', 66, 9) + 4, 166, 9);

// ---------- Page 3 : peignes ----------
{ // téléphone tapé « |__|__| » : un chiffre centré dans chaque case
  const size = 13;
  let x = after('Numéro de téléphone : |', 60, size);
  const cell = helv.widthOfTextAtSize('__', size), sep = helv.widthOfTextAtSize('|', size);
  for (const d of '0612345678') {
    put(p3, d, x + (cell - cour.widthOfTextAtSize(d, 11)) / 2, 742);
    x += cell + sep;
  }
}
{ // peigne vectoriel « Code client » : 8 cases de 14 pt à partir de x = 150
  [...'AB12CD34'].forEach((c, i) => put(p3, c, 150 + 14 * i + (14 - cour.widthOfTextAtSize(c, 11)) / 2, 621));
}
cross(p3, 110, 529);                       // Non
put(p3, 'Ingénieur', after('Profession : ', 60) + 6, 497);

const out = path.join(here, 'test', 'flatform-rempli.pdf');
writeFileSync(out, await doc.save());
console.log('écrit :', out);
