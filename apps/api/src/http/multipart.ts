import type { IncomingMessage } from 'node:http';
import busboy from 'busboy';
import { HttpError } from './rest';

export interface UploadedFile {
  filename: string;
  bytes: Buffer;
}

/** Parse multipart/form-data: every `file`/`files` part is a document; other fields are returned as strings. */
export function parseMultipart(req: IncomingMessage, limits: { fileBytes: number; files: number }): Promise<{ files: UploadedFile[]; fields: Record<string, string> }> {
  return new Promise((resolve, reject) => {
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { fileSize: limits.fileBytes, files: limits.files } });
    } catch {
      reject(new HttpError(400, 'Malformed multipart request'));
      return;
    }
    const files: UploadedFile[] = [];
    const fields: Record<string, string> = {};
    let failed: Error | null = null;
    bb.on('file', (_name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('limit', () => (failed = new HttpError(413, `"${info.filename}" exceeds ${Math.round(limits.fileBytes / 1024 / 1024)} MB`)));
      stream.on('close', () => files.push({ filename: info.filename || 'upload.pdf', bytes: Buffer.concat(chunks) }));
    });
    bb.on('field', (name, value) => (fields[name] = value));
    bb.on('filesLimit', () => (failed = new HttpError(413, `At most ${limits.files} files per request`)));
    bb.on('error', (e) => reject(new HttpError(400, `Malformed multipart request: ${(e as Error).message}`)));
    bb.on('close', () => (failed ? reject(failed) : resolve({ files, fields })));
    req.pipe(bb);
  });
}
