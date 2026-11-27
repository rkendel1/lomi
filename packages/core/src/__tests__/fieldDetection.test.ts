import { detectFieldRegions } from '../utils/fieldDetection';

const ruledCell = (width = 120, height = 60): ImageData => {
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const black = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0; data[i + 3] = 255;
  };
  for (let x = 10; x <= 110; x++) { black(x, 10); black(x, 45); }
  for (let y = 10; y <= 45; y++) { black(10, y); black(110, y); }
  return { width, height, data, colorSpace: 'srgb' } as ImageData;
};

it('detects a ruled field and reserves the printed-label area', () => {
  const regions = detectFieldRegions(ruledCell(), [{
    text: 'AGENCY', x: 14, y: 13, width: 35, height: 8, confidence: 99,
  }]);
  expect(regions).toHaveLength(1);
  expect(regions[0].label).toBe('agency');
  expect(regions[0].y).toBeGreaterThan(20);
});

it('rejects a structural row whose text consumes the cell', () => {
  const regions = detectFieldRegions(ruledCell(), [{
    text: 'ATTACHMENTS', x: 14, y: 24, width: 75, height: 14, confidence: 99,
  }]);
  expect(regions).toHaveLength(0);
});

it('rejects a large unlabeled table cell', () => {
  expect(detectFieldRegions(ruledCell())).toHaveLength(0);
});

/** A page with label-left input boxes whose edges land on alternating pixel columns (as rendered PDFs do). */
const stackedForm = (): ImageData => {
  const width = 400, height = 220;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  const black = (x: number, y: number) => {
    const i = (y * width + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = 0; data[i + 3] = 255;
  };
  const box = (left: number, top: number, w: number, h: number) => {
    for (let x = left; x <= left + w; x++) { black(x, top); black(x, top + h); }
    for (let y = top; y <= top + h; y++) { black(left, y); black(left + w, y); }
  };
  box(160, 20, 220, 30);   // name
  box(161, 70, 220, 30);   // date (edge one column over)
  box(160, 120, 220, 30);  // amount
  box(161, 170, 14, 14);   // checkbox
  return { width, height, data, colorSpace: 'srgb' } as ImageData;
};
const word = (text: string, x: number, y: number, w = 60) => ({ text, x, y, width: w, height: 10, confidence: 99 });

it('finds standalone label-left boxes, keeps a box with a printed hint, and does not chain stacked edges', () => {
  const regions = detectFieldRegions(stackedForm(), [
    word('Company name:', 20, 30, 80), word('Start date:', 20, 80), word('MM/DD/YYYY', 320, 80, 50), word('Annual spend:', 20, 130, 75), word('I agree:', 20, 172, 45),
  ]);
  expect(regions.map((r) => [r.kind, r.label])).toEqual([
    ['text', 'companyName'], ['text', 'startDate'], ['text', 'annualSpend'], ['checkbox', 'iAgree'],
  ]);
  // Full boxes, not slivers between stacked edges.
  expect(regions.slice(0, 3).every((r) => r.width > 200 && r.height > 20 && r.height < 35)).toBe(true);
});

it('does not take letter strokes inside text for boxes', () => {
  const page = stackedForm();
  // A word printed over the checkbox area: anything it overlaps is a glyph, not an input.
  expect(detectFieldRegions(page, [word('Company name:', 20, 30, 80), word('XXXXXXXX', 150, 168, 60)]).some((r) => r.kind === 'checkbox')).toBe(false);
});

it('finds boxes already filled in on a filled copy, named after their label, not their value', () => {
  const regions = detectFieldRegions(stackedForm(), [
    word('Company name:', 20, 30, 80), word('Contoso Paper Co.', 166, 30, 90), word('Start date:', 20, 80), word('03/01/2026', 167, 80, 55),
    word('Annual spend:', 20, 130, 75), word('I agree:', 20, 172, 45),
  ]);
  expect(regions.map((r) => [r.kind, r.label])).toEqual([
    ['text', 'companyName'], ['text', 'startDate'], ['text', 'annualSpend'], ['checkbox', 'iAgree'],
  ]);
});
