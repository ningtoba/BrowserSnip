import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { writeFileSync } from 'node:fs';
const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
for (let i = 0; i < 3; i++) {
  const p = doc.addPage([595, 842]);
  p.drawText({ text: `Sample document page ${i + 1}`, x: 60, y: 760, size: 22, font, color: rgb(0, 0, 0) });
  p.drawText({ text: 'The quick brown fox jumps over the lazy dog. Editing this text should work in the browser without uploads.', x: 60, y: 700, size: 12, font, color: rgb(0.1, 0.1, 0.1), lineHeight: 16 });
}
writeFileSync('/tmp/sample.pdf', await doc.save());
console.log('wrote /tmp/sample.pdf');
