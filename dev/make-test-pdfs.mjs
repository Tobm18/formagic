// Génère des PDF de test
import { PDFDocument, StandardFonts, rgb, degrees } from '@cantoo/pdf-lib';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test');
mkdirSync(dir, { recursive: true });

// 1. Document texte multi-pages
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  for (let p = 1; p <= 6; p++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Chapitre ${p} — Rapport de test`, { x: 60, y: 770, size: 22, font: bold, color: rgb(0.1, 0.15, 0.4) });
    const lines = [
      'Ceci est un paragraphe de démonstration pour tester la sélection de texte.',
      'Le surlignage, le soulignement et le texte barré doivent suivre les lignes.',
      'Prix total : 1 250,00 € — date limite : 15 décembre 2026.',
      "L'outil « Modifier le texte » doit remplacer cette ligne proprement.",
    ];
    lines.forEach((l, i) => page.drawText(l, { x: 60, y: 720 - i * 22, size: 12, font }));
    page.drawText('Texte en Times pour la détection de police serif.', { x: 60, y: 600, size: 14, font: times });
    page.drawRectangle({ x: 60, y: 380, width: 470, height: 180, color: rgb(0.93, 0.95, 1), borderColor: rgb(0.6, 0.65, 0.9), borderWidth: 1 });
    page.drawText(`Page ${p} sur 6`, { x: 260, y: 40, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  }
  writeFileSync(path.join(dir, 'sample.pdf'), await doc.save());
}

// 2. Pages pivotées et de tailles différentes
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const a = doc.addPage([595.28, 841.89]);
  a.drawText('Page normale (portrait)', { x: 60, y: 760, size: 20, font });
  const b = doc.addPage([595.28, 841.89]);
  b.setRotation(degrees(90));
  b.drawText('Page avec /Rotate 90', { x: 60, y: 760, size: 20, font });
  const c = doc.addPage([841.89, 595.28]);
  c.drawText('Page paysage', { x: 60, y: 520, size: 20, font });
  writeFileSync(path.join(dir, 'rotated.pdf'), await doc.save());
}

// 3. Formulaire
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Formulaire d\'inscription', { x: 60, y: 770, size: 22, font });
  page.drawText('Nom :', { x: 60, y: 712, size: 12, font });
  page.drawText('Accepte les conditions :', { x: 60, y: 662, size: 12, font });
  const form = doc.getForm();
  const name = form.createTextField('nom');
  name.addToPage(page, { x: 110, y: 700, width: 250, height: 24 });
  const cb = form.createCheckBox('accepte');
  cb.addToPage(page, { x: 210, y: 656, width: 16, height: 16 });
  writeFileSync(path.join(dir, 'form.pdf'), await doc.save());
}

// 4. Protégé par mot de passe (« secret »)
{
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText('Document confidentiel protégé', { x: 60, y: 760, size: 20, font });
  doc.encrypt({ userPassword: 'secret', ownerPassword: 'owner' });
  writeFileSync(path.join(dir, 'protected.pdf'), await doc.save());
}
console.log('PDF de test écrits dans', dir);
