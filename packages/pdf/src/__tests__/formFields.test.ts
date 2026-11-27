import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { extractPdfText } from '../text';

/** A one-page fillable form: a text field, a date field, a checkbox. */
async function fillable(values?: { name?: string; date?: string; agree?: boolean }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Applicant name', { x: 56, y: 703, size: 10, font });
  page.drawText('Date of application', { x: 56, y: 673, size: 10, font });
  page.drawText('I agree', { x: 56, y: 643, size: 10, font });
  const form = doc.getForm();
  const name = form.createTextField('applicant_name');
  name.addToPage(page, { x: 218, y: 698, width: 300, height: 18 });
  const date = form.createTextField('application_date');
  date.addToPage(page, { x: 218, y: 668, width: 120, height: 18 });
  const agree = form.createCheckBox('agree');
  agree.addToPage(page, { x: 218, y: 640, width: 12, height: 12 });
  if (values?.name) name.setText(values.name);
  if (values?.date) date.setText(values.date);
  if (values?.agree) agree.check();
  return doc.save();
}

describe('extractPdfText with fillable form fields', () => {
  it('adds filled values at their widgets, marked as form-field text', async () => {
    const parsed = await extractPdfText(await fillable({ name: 'Dana Okafor', date: '03/01/2026', agree: true }));
    const fields = parsed.pages[0].items.filter((i) => i.source === 'form_field');
    expect(fields.map((f) => f.str)).toEqual(['Dana Okafor', '03/01/2026', 'X']);
    expect(fields[0].x).toBeGreaterThanOrEqual(218);
    expect(fields[0].y).toBeGreaterThanOrEqual(698);
    expect(fields[0].y).toBeLessThan(716);
    // Printed labels are still there, unmarked.
    expect(parsed.pages[0].items.find((i) => i.str === 'Applicant name')?.source).toBeUndefined();
  });

  it('adds nothing for empty fields', async () => {
    const parsed = await extractPdfText(await fillable());
    expect(parsed.pages[0].items.filter((i) => i.source === 'form_field')).toEqual([]);
  });
});
