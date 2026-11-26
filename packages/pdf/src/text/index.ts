/**
 * Server-side PDF text extraction, built on the same pdfjs-dist the web viewer
 * uses so that text positions agree with what operators see in the viewer.
 * Exposed as `@lomi/pdf/text` so browser bundles that only render PDFs do not
 * pull in the Node build of PDF.js.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ExtractedTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  eol?: boolean;
}

export interface ExtractedPage {
  pageIndex: number;
  width: number;
  height: number;
  items: ExtractedTextItem[];
}

export interface ExtractedDocument {
  pageCount: number;
  pages: ExtractedPage[];
  parser: string;
}

const require = createRequire(import.meta.url);
const PDFJS_VERSION: string = require('pdfjs-dist/package.json').version;
export const TEXT_PARSER_ID = `pdfjs-dist@${PDFJS_VERSION}/text-1`;

function standardFontDataUrl(): string {
  const root = dirname(require.resolve('pdfjs-dist/package.json'));
  return pathToFileURL(join(root, 'standard_fonts') + '/').href;
}

/** Extract positioned text from every page. Coordinates are PDF points, bottom-left origin. */
export async function extractPdfText(bytes: Uint8Array): Promise<ExtractedDocument> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // PDF.js may transfer (detach) the buffer it is given; never hand it the caller's bytes.
  const data = new Uint8Array(bytes);
  const doc = await pdfjs.getDocument({
    data,
    useSystemFonts: false,
    standardFontDataUrl: standardFontDataUrl(),
    verbosity: 0,
  }).promise;
  try {
    const pages: ExtractedPage[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: ExtractedTextItem[] = [];
      for (const raw of content.items) {
        if (!('str' in raw)) continue;
        const [, , , d, e, f] = raw.transform as number[];
        items.push({
          str: raw.str,
          x: e,
          y: f,
          width: raw.width,
          height: raw.height || Math.abs(d),
          eol: raw.hasEOL || undefined,
        });
      }
      pages.push({ pageIndex: i - 1, width: viewport.width, height: viewport.height, items });
      page.cleanup();
    }
    return { pageCount: doc.numPages, pages, parser: TEXT_PARSER_ID };
  } finally {
    await doc.destroy();
  }
}
