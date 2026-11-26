import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createHash } from 'node:crypto';
import { extractPdfText, TEXT_PARSER_ID } from '../text';
import { renderPdf } from '../renderer/pdfRenderer';

async function samplePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Invoice Number: INV-1001', { x: 50, y: 700, font, size: 12 });
  const second = doc.addPage([612, 792]);
  second.drawText('Total Due: $1,250.00', { x: 72, y: 500, font, size: 10 });
  return doc.save();
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

describe('extractPdfText', () => {
  it('returns positioned text per page in PDF points', async () => {
    const parsed = await extractPdfText(await samplePdf());
    expect(parsed.pageCount).toBe(2);
    expect(parsed.parser).toBe(TEXT_PARSER_ID);
    expect(parsed.pages[0].items[0]).toMatchObject({ str: 'Invoice Number: INV-1001', x: 50, y: 700 });
    expect(parsed.pages[1].items[0]).toMatchObject({ str: 'Total Due: $1,250.00', x: 72, y: 500, height: 10 });
    expect(parsed.pages[0].width).toBe(612);
  });

  it('does not detach the caller buffer', async () => {
    const bytes = await samplePdf();
    await extractPdfText(bytes);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(new TextDecoder().decode(bytes.subarray(0, 4))).toBe('%PDF');
  });
});

describe('renderPdf deterministic mode', () => {
  const layout = { total: { page: 0, x: 50, y: 600, width: 200, height: 14, type: 'currency' as const, fontSize: 10, maxWidth: 200 } };
  const mapping = {
    artifactType: 'field-mapping' as const,
    version: '1.0' as const,
    mappings: [{ id: 'm1', semanticKey: 'invoice.total', binding: { fieldId: 'field_001', sourceId: 'total' } }],
  };

  it('produces byte-identical output for identical inputs', async () => {
    const template = await samplePdf();
    const opts = { pdfTemplate: template, layout, mapping, transforms: {}, data: { 'invoice.total': '1250.00' }, deterministic: true };
    const a = await renderPdf(opts);
    await new Promise((r) => setTimeout(r, 1100));
    const b = await renderPdf(opts);
    expect(sha(a)).toBe(sha(b));
    const text = await extractPdfText(a);
    expect(text.pages[0].items.map((i) => i.str)).toContain('1250.00');
  });
});
