import type { AddressInfo } from 'node:net';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiServer } from '../app';

let server: ReturnType<typeof createApiServer>;
let baseUrl: string;

beforeAll(async () => {
  server = createApiServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

async function makeTemplate(): Promise<string> {
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  const bytes = await pdf.save();
  return Buffer.from(bytes).toString('base64');
}

describe('lomi-api', () => {
  it('reports health', async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: 'ok',
      service: 'lomi-api',
    });
  });

  it('renders a filled PDF from schema artifacts', async () => {
    const response = await fetch(`${baseUrl}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: await makeTemplate(),
        layout: {
          field_001: {
            page: 0,
            x: 100,
            y: 700,
            width: 200,
            height: 14,
            type: 'text',
            fontSize: 10,
            maxWidth: 200,
          },
        },
        mapping: {
          artifactType: 'field-mapping',
          version: '1.0',
          mappings: [
            {
              id: 'mapping_001',
              semanticKey: 'applicant.name',
              binding: { fieldId: 'field_001', sourceId: 'applicantName' },
            },
          ],
        },
        transforms: {},
        data: { 'applicant.name': 'Ada Lovelace' },
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    const bytes = await response.arrayBuffer();
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(1);
  });

  it('rejects a non-PDF template', async () => {
    const response = await fetch(`${baseUrl}/api/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        template: Buffer.from('not a pdf').toString('base64'),
        layout: {},
        mapping: { artifactType: 'field-mapping', version: '1.0', mappings: [] },
        transforms: {},
        data: {},
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('valid base64-encoded PDF'),
    });
  });

  it('returns 404 for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/nope`);
    expect(response.status).toBe(404);
  });
});
