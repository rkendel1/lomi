import type {
  LayoutEntry,
  MappingArtifact,
  TableDefinition,
  TransformEntry,
} from '@lomi/core';

export interface ServerRenderRequest {
  template: string;
  layout: Record<string, LayoutEntry>;
  mapping: MappingArtifact;
  transforms: Record<string, TransformEntry>;
  data: Record<string, unknown>;
  tables?: Record<string, TableDefinition>;
}

const API_BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

/** Convert an ArrayBuffer to base64 without spreading the whole file at once. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

/**
 * Render a filled PDF with the API service. The web app can always render
 * locally; this path demonstrates the same domain packages running on the
 * server and is what nginx proxies to in Docker Compose.
 */
export async function renderPdfOnServer(payload: ServerRenderRequest): Promise<Blob> {
  const response = await fetch(`${API_BASE}/api/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(
      `Server render failed (${response.status})${detail ? `: ${detail}` : ''}`
    );
  }

  return response.blob();
}
