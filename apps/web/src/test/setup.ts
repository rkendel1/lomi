import '@testing-library/jest-dom/vitest';
import { vi } from 'vitest';

// The app renders the uploader on first paint. Stub the PDF/OCR engines so the
// component test does not need a real worker or canvas implementation.
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: vi.fn(),
  version: 'test',
}));

vi.mock('tesseract.js', () => ({
  default: {
    createWorker: vi.fn(),
  },
}));
