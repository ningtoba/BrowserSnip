import { PDFDocument, StandardFonts, rgb } from '@maxwbh/pdf-lib';
import { writeFileSync } from 'node:fs';

async function main() {
const doc = await PDFDocument.create();
doc.setTitle('Round 047 form fixture');
doc.setAuthor('campaign');
doc.setSubject('every field type the pane claims to offer');
const page = doc.addPage([612, 792]);
const font = await doc.embedFont(StandardFonts.Helvetica);
page.drawText('Round 047 fixture: name, notes, zip, sealed, terms, tier, country, languages, email, push button', { x: 40, y: 760, size: 10, font });
page.drawText('RADIO ROW ->', { x: 40, y: 500, size: 9, font });
page.drawText('LIST ->', { x: 40, y: 380, size: 9, font });
const second = doc.addPage([612, 792]);
second.drawText('second sheet, no fields', { x: 60, y: 700, size: 14, font });

const form = doc.getForm();
const box = { borderColor: rgb(0.4, 0.4, 0.4), borderWidth: 0.5, textColor: rgb(0, 0, 0) };

const name = form.createTextField('applicant.name');
name.addToPage(page, { x: 60, y: 700, width: 260, height: 22, ...box });

const notes = form.createTextField('applicant.notes');
notes.enableMultiline();
notes.setText('draft note already in the file');
notes.addToPage(page, { x: 60, y: 650, width: 260, height: 42, ...box });

const zip = form.createTextField('applicant.zip');
zip.setMaxLength(5);
zip.addToPage(page, { x: 60, y: 620, width: 80, height: 20, ...box });

const sealed = form.createTextField('applicant.locked');
sealed.setText('sealed value');
sealed.enableReadOnly();
sealed.addToPage(page, { x: 60, y: 590, width: 160, height: 20, ...box });

const terms = form.createCheckBox('agree.terms');
terms.addToPage(page, { x: 60, y: 550, width: 16, height: 16, ...box });

const tier = form.createRadioGroup('tier');
for (const [i, opt] of Array.from(['Gold', 'Silver', 'Bronze'].entries())) {
  tier.addOptionToPage(opt, page, { x: 60 + i * 90, y: 490, width: 16, height: 16, ...box });
}

const country = form.createDropdown('country');
country.setOptions(['Alpha', 'Beta', 'Gamma']);
country.select('Alpha');
country.addToPage(page, { x: 60, y: 430, width: 160, height: 20, ...box });

const langs = form.createOptionList('languages');
langs.setOptions(['PDF', 'Cairo', 'MuPDF']);
langs.addToPage(page, { x: 60, y: 330, width: 160, height: 60, ...box });

const email = form.createTextField('applicant.email');
email.enableRequired();
email.addToPage(page, { x: 60, y: 290, width: 220, height: 20, ...box });

const push = form.createButton('action.button');
push.addToPage('Push', page, { x: 60, y: 230, width: 160, height: 40, ...box });

form.updateFieldAppearances(await doc.embedFont(StandardFonts.Helvetica));
const bytes = await doc.save({ useObjectStreams: false });
writeFileSync('/tmp/f047/rich.pdf', bytes);
console.log("wrote", bytes.length);
}
main();
