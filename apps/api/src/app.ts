import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type {
  LayoutEntry,
  MappingArtifact,
  TableDefinition,
  TransformEntry,
} from '@lomi/core';
import { renderPdf } from '@lomi/pdf';

const MAX_BODY_BYTES = 20 * 1024 * 1024;

export interface RenderPayload {
  template: string;
  layout: Record<string, LayoutEntry>;
  mapping: MappingArtifact;
  transforms: Record<string, TransformEntry>;
  data: Record<string, unknown>;
  tables?: Record<string, TableDefinition>;
  pageOffsets?: Record<number, { x: number; y: number }>;
  overflowStrategy?: 'truncate' | 'shrink' | 'continue';
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
  });
  res.end(payload);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        settled = true;
        reject(new HttpError(413, 'Request body exceeds 20 MB limit'));
        // Drain the rest so the 413 response can still be written.
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (chunks.length === 0) {
        reject(new HttpError(400, 'Request body is required'));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Request body must be valid JSON'));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function validateRenderPayload(input: unknown): RenderPayload {
  if (!isRecord(input)) throw new HttpError(400, 'Payload must be a JSON object');
  if (typeof input.template !== 'string' || input.template.length === 0) {
    throw new HttpError(400, 'template must be a non-empty base64 string');
  }
  if (!isRecord(input.layout)) throw new HttpError(400, 'layout must be an object');
  if (!isRecord(input.mapping)) throw new HttpError(400, 'mapping must be an object');
  if (!isRecord(input.transforms)) throw new HttpError(400, 'transforms must be an object');
  if (!isRecord(input.data)) throw new HttpError(400, 'data must be an object');

  return input as unknown as RenderPayload;
}

async function handleRender(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const payload = validateRenderPayload(await readJson(req));
  const template = Buffer.from(payload.template, 'base64');

  if (template.length === 0 || template.subarray(0, 4).toString('ascii') !== '%PDF') {
    throw new HttpError(400, 'template is not a valid base64-encoded PDF');
  }

  const pdf = await renderPdf({
    pdfTemplate: template,
    layout: payload.layout,
    mapping: payload.mapping,
    transforms: payload.transforms,
    data: payload.data,
    tables: payload.tables,
    pageOffsets: payload.pageOffsets,
    overflowStrategy: payload.overflowStrategy,
  });

  res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline; filename="rendered.pdf"',
    'Content-Length': pdf.length,
    'Cache-Control': 'no-store',
  });
  res.end(Buffer.from(pdf));
}

function withCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function createApiServer() {
  return createServer(async (req, res) => {
    withCors(res);

    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const route = `${req.method ?? 'GET'} ${url.pathname}`;

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (route === 'GET /api/health') {
        sendJson(res, 200, {
          status: 'ok',
          service: 'lomi-api',
          version: '0.1.0',
          uptimeSeconds: Math.round(process.uptime()),
        });
        return;
      }

      if (route === 'GET /api') {
        sendJson(res, 200, {
          name: 'lomi-api',
          endpoints: ['GET /api/health', 'POST /api/render'],
        });
        return;
      }

      if (route === 'POST /api/render') {
        await handleRender(req, res);
        return;
      }

      sendJson(res, 404, { error: 'Not found' });
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : 'Unknown error';
      if (status >= 500) console.error('API error:', error);
      if (!res.headersSent) sendJson(res, status, { error: message });
      else res.end();
    }
  });
}
