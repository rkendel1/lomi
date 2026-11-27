import * as pdfjsLib from 'pdfjs-dist';
import { detectFieldRegions, displayLabelFromPdfFieldId, semanticKeyFromPdfFieldId, type Field, type FieldType } from '@lomi/core';
import { extractTextWithOCR, findNearbyLabel, type OCRWord } from './ocr';

/**
 * coordtool field location, shared by the mapper (one page as it is viewed)
 * and form setup (every page at once). Fields come back in PDF points with a
 * bottom-left origin. Native AcroForm widgets are authoritative; ruled cells
 * found in the rendered page are the fallback for flattened and scanned forms.
 */

pdfjsLib.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.mjs`;

export const DETECTION_SCALE = 1.5;
const OCR_UPSCALE = 2;

type Region = { x: number; y: number; width: number; height: number };

// PDF.js annotation payloads vary by PDF and version. Some expose the PDF
// subtype string, while others expose only AnnotationType.WIDGET (20).
export function isNativeWidget(annotation: any): boolean {
  const isWidget = annotation?.subtype === 'Widget' || annotation?.annotationType === 20;
  return isWidget && !annotation.hidden && !annotation.readOnly && !annotation.pushButton;
}

function annotationDisplayLabel(annotation: any, sourceFieldId: string): string {
  const accessibilityLabel = typeof annotation?.alternativeText === 'string' ? annotation.alternativeText.trim() : '';
  if (accessibilityLabel) {
    return accessibilityLabel
      .replace(/^\s*\d+[A-Z]?[.)]\s*/i, '')
      .split(/\.\s+(?=(?:enter|select|check|provide|choose|indicate)\b)/i)[0]
      .trim();
  }
  return displayLabelFromPdfFieldId(sourceFieldId) || sourceFieldId;
}

function printedLabelBesideWidget(rect: number[], viewport: pdfjsLib.PageViewport, words: OCRWord[]): string {
  const viewportRect = viewport.convertToViewportRectangle(rect);
  const left = Math.min(viewportRect[0], viewportRect[2]);
  const right = Math.max(viewportRect[0], viewportRect[2]);
  const top = Math.min(viewportRect[1], viewportRect[3]);
  const bottom = Math.max(viewportRect[1], viewportRect[3]);
  const centerY = (top + bottom) / 2;
  const candidates = words
    .filter((word) => {
      const wordCenterY = word.y + word.height / 2;
      const gap = word.x - right;
      return Math.abs(wordCenterY - centerY) <= Math.max(8, bottom - top) && gap >= -3 && gap <= 150;
    })
    .sort((a, b) => a.x - b.x);
  if (candidates.length > 0) return candidates[0].text.trim();
  const nearby = findNearbyLabel(left, top, right - left, bottom - top, words, 80);
  return nearby?.trim() || '';
}

/** The page's own text as positioned words in viewport pixels (top-left origin), like OCR output. */
export async function extractEmbeddedPdfWords(page: pdfjsLib.PDFPageProxy, viewport: pdfjsLib.PageViewport): Promise<OCRWord[]> {
  const content = await page.getTextContent();
  return content.items.flatMap((rawItem: any) => {
    const text = typeof rawItem.str === 'string' ? rawItem.str.trim() : '';
    if (!text || !rawItem.transform) return [];
    const [x, baselineY] = viewport.convertToViewportPoint(rawItem.transform[4], rawItem.transform[5]);
    const height = Math.max(1, Math.abs(rawItem.height || rawItem.transform[3] || 8) * viewport.scale);
    return [{ text, x, y: baselineY - height, width: Math.max(1, Math.abs(rawItem.width || 1) * viewport.scale), height, confidence: 100 }];
  });
}

export function overlapsExistingRegion(candidate: Region, regions: Region[]): boolean {
  return regions.some((region) => {
    const w = Math.max(0, Math.min(candidate.x + candidate.width, region.x + region.width) - Math.max(candidate.x, region.x));
    const h = Math.max(0, Math.min(candidate.y + candidate.height, region.y + region.height) - Math.max(candidate.y, region.y));
    const smallerArea = Math.min(candidate.width * candidate.height, region.width * region.height);
    return smallerArea > 0 && (w * h) / smallerArea >= 0.35;
  });
}

/** Fillable (AcroForm) fields on a page: exact names, positions and kinds. */
export async function nativeWidgetFields(
  page: pdfjsLib.PDFPageProxy,
  viewport: pdfjsLib.PageViewport,
  pageIndex: number,
  words: OCRWord[] = []
): Promise<{ fields: Field[]; regions: Region[] }> {
  const annotations = (await page.getAnnotations()).filter(isNativeWidget);
  const fields = annotations.map((ann: any): Field => {
    const [x1, y1, x2, y2] = ann.rect;
    let type: FieldType = 'text';
    if (ann.fieldType === 'Tx') type = ann.multiLine ? 'multiline' : 'text';
    else if (ann.fieldType === 'Btn') type = 'checkbox';
    // sourceFieldId must remain exactly equal to the PDF's field name so
    // exported mappings can fill the original widget later.
    const sourceFieldId = typeof ann.fieldName === 'string' && ann.fieldName.trim() ? ann.fieldName.trim() : `pdf_field_${ann.id || pageIndex + 1}`;
    const displayLabel = printedLabelBesideWidget(ann.rect, viewport, words) || annotationDisplayLabel(ann, sourceFieldId);
    return {
      id: `pdf_field_${pageIndex}_${ann.id || `${Math.round(x1)}_${Math.round(y1)}`}`,
      name: sourceFieldId,
      sourceFieldId,
      semanticKey: semanticKeyFromPdfFieldId(sourceFieldId),
      displayLabel,
      page: pageIndex,
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      type,
      fontSize: 10,
      maxWidth: Math.abs(x2 - x1),
    };
  });
  return { fields, regions: fields.map((f) => ({ x: f.x, y: f.y, width: f.width, height: f.height })) };
}

/** Ruled, empty cells found in the rendered page (flattened or scanned forms), labelled from nearby text. */
export function flatRegionFields(
  image: ImageData,
  viewport: pdfjsLib.PageViewport,
  pageIndex: number,
  words: OCRWord[],
  skip: Region[] = [],
  idPrefix = 'flat'
): Field[] {
  const out: Field[] = [];
  detectFieldRegions(image, words).forEach((region, index) => {
    const [pdfLeft, pdfBottom] = viewport.convertToPdfPoint(region.x, region.y + region.height);
    const [pdfRight, pdfTop] = viewport.convertToPdfPoint(region.x + region.width, region.y);
    const x = Math.min(pdfLeft, pdfRight);
    const y = Math.min(pdfBottom, pdfTop);
    const width = Math.abs(pdfRight - pdfLeft);
    const height = Math.abs(pdfTop - pdfBottom);
    if (overlapsExistingRegion({ x, y, width, height }, skip)) return;
    const name = region.label || `detected_page${pageIndex + 1}_${index + 1}`;
    out.push({
      id: `${idPrefix}-${pageIndex}-${Math.round(x)}-${Math.round(y)}`,
      name, sourceFieldId: name, semanticKey: semanticKeyFromPdfFieldId(name),
      displayLabel: displayLabelFromPdfFieldId(name), page: pageIndex,
      x, y, width, height,
      type: region.kind === 'checkbox' || (width <= 18 && height <= 18)
        ? 'checkbox'
        : /date/i.test(name) ? 'date' : /premium|amount|limit|deposit|total|spend|price/i.test(name) ? 'currency' : 'text',
      fontSize: 10, maxWidth: width,
      boxedTextEnabled: region.kind === 'boxedText',
      boxInputMode: region.kind === 'boxedText' ? 'alphanumeric' : undefined,
      boxPattern: region.kind === 'boxedText' ? String(region.boxCount || '') : undefined,
    });
  });
  return out;
}

export interface DetectionReport {
  fields: Field[];
  pages: number;
  native: number;
  flat: number;
  ocrPages: number;
  ocrFailed?: string;
}

/**
 * Locate every field on every page of a form. Per page: native widgets if it
 * has any; otherwise ruled cells, labelled with the page's text, or with OCR
 * when the page is an image (scan).
 */
export async function detectFormFields(file: File | Uint8Array, options: { ocr?: boolean; onProgress?: (message: string) => void } = {}): Promise<DetectionReport> {
  const data = file instanceof Uint8Array ? new Uint8Array(file) : new Uint8Array(await file.arrayBuffer());
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const report: DetectionReport = { fields: [], pages: pdf.numPages, native: 0, flat: 0, ocrPages: 0 };
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      options.onProgress?.(`Locating fields on page ${n} of ${pdf.numPages}…`);
      const page = await pdf.getPage(n);
      const viewport = page.getViewport({ scale: DETECTION_SCALE });
      let words = await extractEmbeddedPdfWords(page, viewport);
      const native = await nativeWidgetFields(page, viewport, n - 1, words);
      report.fields.push(...native.fields);
      report.native += native.fields.length;
      if (native.fields.length) continue;
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      // A page with (almost) no text layer is a scan: read its words with OCR for labels.
      if (words.length < 3 && options.ocr !== false) {
        options.onProgress?.(`Page ${n} is an image — reading it with OCR…`);
        try {
          // OCR misses small print at detection resolution: read a 2x render, then map words back.
          const big = page.getViewport({ scale: DETECTION_SCALE * OCR_UPSCALE });
          const ocrCanvas = document.createElement('canvas');
          ocrCanvas.width = Math.ceil(big.width);
          ocrCanvas.height = Math.ceil(big.height);
          const ocrCtx = ocrCanvas.getContext('2d');
          if (!ocrCtx) throw new Error('no canvas');
          await page.render({ canvas: ocrCanvas, canvasContext: ocrCtx, viewport: big }).promise;
          words = (await extractTextWithOCR(ocrCanvas)).map((w) => ({
            ...w, x: w.x / OCR_UPSCALE, y: w.y / OCR_UPSCALE, width: w.width / OCR_UPSCALE, height: w.height / OCR_UPSCALE,
          }));
          report.ocrPages++;
        } catch (error) {
          // Boxes are still found from the pixels; they are just unlabelled.
          report.ocrFailed = `OCR failed: ${(error as Error).message}`;
        }
      }
      // 'located', not the viewer's provisional 'flat-' prefix: the mapper drops 'flat-' boxes when its OCR toggle is off.
      const flat = flatRegionFields(ctx.getImageData(0, 0, canvas.width, canvas.height), viewport, n - 1, words, [], 'located');
      report.fields.push(...flat);
      report.flat += flat.length;
      page.cleanup();
    }
  } finally {
    await pdf.destroy();
  }
  return report;
}

/** Field kinds the server reads by position; the others (signature, initials, table) are render-only. */
export const READABLE_TYPES = ['text', 'multiline', 'date', 'dob', 'currency', 'checkbox', 'phone', 'zip', 'ssn', 'ein'] as const;

/** A located field as `templates.forms.import` / `templates.fields.add` take it. */
export function toRegionSpec(f: Field) {
  const type = f.dataType === 'number' ? 'number' : (READABLE_TYPES as readonly string[]).includes(f.type) ? f.type : 'text';
  return {
    label: (f.displayLabel || f.name || f.sourceFieldId || '').trim(),
    type,
    page: f.page,
    x: f.x,
    y: f.y,
    width: f.width,
    height: f.height,
    ...(f.sourceFieldId && !/^(flat-|located-|detected_page)/.test(f.sourceFieldId) ? { sourceFieldId: f.sourceFieldId } : {}),
    ...(f.required ? { required: true } : {}),
  };
}

export const isReadable = (f: Field) => (READABLE_TYPES as readonly string[]).includes(f.type);
