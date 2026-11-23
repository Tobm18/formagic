// Génère un PDF « scanné » de test (dev/test/scanned.pdf) : pages de texte rendues en image par Chromium,
// légèrement floues, inclinées, sur fond gris-beige avec du bruit, comme un document passé au scanner.
// Usage : node dev/make-scan-test.mjs   (nécessite Playwright et Chromium, ainsi que @cantoo/pdf-lib de dev/)
import { PDFDocument } from '@cantoo/pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test');
mkdirSync(dir, { recursive: true });

const DPI = 200;
const W = Math.round(8.27 * DPI), H = Math.round(11.69 * DPI); // A4
const px = (pt) => (pt * DPI) / 72;

const pages = [
  `<h1 style="font:bold ${px(18)}px Arial">CONTRAT DE LOCATION</h1>
   <p style="font:${px(11)}px Arial">Entre les soussignés : Madame Claire Dupont, demeurant 12 rue des Lilas, 69003 Lyon,</p>
   <p style="font:${px(11)}px Arial">ci-après dénommée « le bailleur », et Monsieur Julien Martin, ci-après « le locataire ».</p>
   <p style="font:${px(11)}px Arial">Le loyer mensuel est fixé à 850,00 € charges comprises, payable avant le 5 de chaque mois.</p>
   <h2 style="font:bold ${px(13)}px 'Times New Roman'">Article 2 — Durée du bail</h2>
   <p style="font:${px(12)}px 'Times New Roman'">Le présent bail est consenti pour une durée de trois années entières et consécutives,</p>
   <p style="font:${px(12)}px 'Times New Roman'">à compter du 1er janvier 2027. Il se renouvellera ensuite par tacite reconduction.</p>
   <p style="font:italic ${px(12)}px 'Times New Roman'">Les parties déclarent avoir pris connaissance des conditions générales.</p>
   <p style="font:${px(10)}px 'Courier New'">Référence dossier : LOC-2026-0418 / agence n° 12</p>
   <p style="font:${px(11)}px Arial;color:#1a3a8a">Fait à Lyon, le 23 novembre 2026.</p>`,
  `<h1 style="font:bold ${px(16)}px 'Times New Roman'">Annexe : état des lieux</h1>
   <p style="font:${px(11)}px Arial">Cuisine : murs en bon état, peinture blanche récente, évier sans défaut.</p>
   <p style="font:${px(11)}px Arial">Salle de bains : joints à reprendre autour de la baignoire, robinet neuf.</p>
   <p style="font:bold ${px(11)}px Arial">Relevé des compteurs : eau 1 254 m³, électricité 48 720 kWh.</p>`,
];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H } });
const doc = await PDFDocument.create();
for (const [i, html] of pages.entries()) {
  // bruit de fond (grain du papier) en SVG, rotation légère, flou du scanner
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${W}px;height:${H}px;overflow:hidden;background:#f2efe6">
    <svg width="${W}" height="${H}" style="position:absolute;inset:0;opacity:.18"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="${i + 3}"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>
    <div style="position:absolute;left:${px(60)}px;top:${px(60)}px;right:${px(60)}px;color:#222;transform:rotate(${i ? -0.25 : 0.3}deg);transform-origin:0 0;filter:blur(0.6px)">
    <style>p,h1,h2{margin:0 0 ${px(9)}px} h1{margin-bottom:${px(18)}px} h2{margin-top:${px(16)}px}</style>${html}</div></body></html>`);
  const png = await page.screenshot({ type: 'jpeg', quality: 80 });
  const img = await doc.embedJpg(png);
  const p = doc.addPage([595.28, 841.89]);
  p.drawImage(img, { x: 0, y: 0, width: 595.28, height: 841.89 });
}
await browser.close();
writeFileSync(path.join(dir, 'scanned.pdf'), await doc.save());
console.log('dev/test/scanned.pdf');
