/**
 * Pure OCR geometry/label helpers.
 *
 * The browser-side Tesseract worker lives in the web app so this package stays
 * free of DOM and WASM dependencies.
 */

export interface OCRWord {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
}

/**
 * Convert a label like "Insured Name:" to camelCase field name "insuredName".
 */
export function labelToFieldName(label: string): string {
  const meaningfulLabel = label
    .replace(/^\s*\d+[A-Z]?\.\s*/i, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b(?:do not write in this space|type or print|if applicable|optional)\b/gi, ' ');
  const cleaned = meaningfulLabel
    .replace(/[^\w\s]/g, '')
    .trim()
    .toLowerCase();

  if (!cleaned) return '';

  const words = cleaned.split(/\s+/);
  if (words.length === 0) return '';

  return words[0] + words.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
}

/**
 * Find the nearest text label to a given box position.
 * Looks left and above within a reasonable distance.
 */
export function findNearbyLabel(
  boxX: number,
  boxY: number,
  boxWidth: number,
  boxHeight: number,
  words: OCRWord[],
  maxDistance: number = 100
): string | null {
  void boxWidth;
  void boxHeight;

  let bestLabel: string | null = null;
  let bestScore = Infinity;

  for (const word of words) {
    const isLabel = /[:：]$/.test(word.text) ||
      word.text.toLowerCase().includes('name') ||
      word.text.toLowerCase().includes('date');

    const wordRight = word.x + word.width;
    const wordBottom = word.y + word.height;
    const distX = boxX - wordRight;
    const distY = boxY - wordBottom;

    if (distX < -50 || distY < -50) continue;
    if (distX > maxDistance || distY > maxDistance) continue;

    const score = Math.sqrt(distX * distX + distY * distY);

    if (score < bestScore && (isLabel || score < 50)) {
      bestScore = score;
      bestLabel = word.text;
    }
  }

  return bestLabel;
}
