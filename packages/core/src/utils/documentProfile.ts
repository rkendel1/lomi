export interface GenericDocumentProfile {
  kind: 'generic';
}

export type DocumentProfile = GenericDocumentProfile;

/** Document profiling is intentionally generic. No industry form standard
 * is assumed; capability is inferred from the filename only. */
export function detectDocumentProfile(_fileName: string, _pdfText = ''): DocumentProfile {
  return { kind: 'generic' };
}
