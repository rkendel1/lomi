import { findNearbyLabel, labelToFieldName, type OCRWord } from '@lomi/core';

export { findNearbyLabel, labelToFieldName };
export type { OCRWord };

function createWorkerLazy() {
  const publicRoot = import.meta.env.BASE_URL.replace(/\/$/, '');
  return import('tesseract.js').then(({ default: Tesseract }) =>
    Tesseract.createWorker('eng', undefined, {
      // Keep every OCR runtime asset same-origin. Using the explicit loader
      // (rather than the *.wasm.js single-file build) makes the browser fetch
      // and instantiate the compiled .wasm binary. The core resolves its .wasm
      // relative to the worker script, so both live in public/tesseract/worker.
      corePath: `${publicRoot}/tesseract/worker/tesseract-core-simd-lstm.js`,
      workerPath: `${publicRoot}/tesseract/worker/worker.min.js`,
      langPath: `${publicRoot}/tesseract/lang`,
      gzip: true,
      workerBlobURL: false,
      logger: (m) => {
        if (m.status === 'recognizing text') {
          console.log(`OCR progress: ${Math.round(m.progress * 100)}%`);
        }
      },
    })
  );
}

let workerPromise: ReturnType<typeof createWorkerLazy> | null = null;

function getOCRWorker() {
  // Forms are sparse text around ruled boxes; the default page-layout analysis
  // drops labels printed beside boxes. PSM 11 ("sparse text") finds them.
  if (!workerPromise) workerPromise = createWorkerLazy().then(async (worker) => {
    await worker.setParameters({ tessedit_pageseg_mode: '11' as any });
    return worker;
  });
  return workerPromise;
}

/**
 * Extract text from a PDF page using OCR.
 * Returns bounding boxes with text content.
 */
export async function extractTextWithOCR(
  canvas: HTMLCanvasElement,
  timeoutMs = 30000
): Promise<OCRWord[]> {
  const worker = await getOCRWorker();
  const result = await Promise.race([
    worker.recognize(canvas, {}, { text: true, blocks: true }),
    new Promise<never>((_, reject) =>
      window.setTimeout(() => reject(new Error('WASM OCR timed out')), timeoutMs)
    ),
  ]);

  const words: OCRWord[] = [];
  const blocks = result.data.blocks || [];
  for (const block of blocks) {
    for (const paragraph of block.paragraphs || []) {
      for (const line of paragraph.lines || []) {
        for (const word of line.words || []) {
          if (word.text && word.text.trim().length > 0 && word.bbox) {
            words.push({
              text: word.text.trim(),
              x: word.bbox.x0,
              y: word.bbox.y0,
              width: word.bbox.x1 - word.bbox.x0,
              height: word.bbox.y1 - word.bbox.y0,
              confidence: word.confidence || 0,
            });
          }
        }
      }
    }
  }

  return words;
}
