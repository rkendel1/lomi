import type { Field } from '@lomi/core';

export interface PageOffset {
  x: number;
  y: number;
}

/** A positioned run of text from a PDF page, in PDF user-space points (bottom-left origin). */
export interface TextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** PDF.js reports an explicit end-of-line after this item. */
  eol?: boolean;
}

export interface ParsedPage {
  pageIndex: number;
  width: number;
  height: number;
  items: TextItem[];
}

export interface ParsedDocument {
  pageCount: number;
  pages: ParsedPage[];
  /** Identifies the parser implementation so parsed text can be reproduced. */
  parser: string;
}

export type CrossFieldRule =
  | {
      id: string;
      kind: 'sum';
      /** Semantic keys whose values must add up to `equals`. */
      terms: string[];
      equals: string;
      tolerance?: number;
      message?: string;
    }
  | {
      id: string;
      kind: 'date_order';
      earlier: string;
      later: string;
      message?: string;
    };

/**
 * The interpretation and rendering definition for one document type.
 * `fields` reuse coordtool's `Field` model: their geometry places values on the
 * template's base PDF when generating output, while `extraction`,
 * `validationRules` and `reviewPolicy` govern how incoming documents are read.
 */
export interface TemplateDefinition {
  fields: Field[];
  crossFieldRules?: CrossFieldRule[];
  /** Semantic keys that together identify the business transaction (duplicate detection). */
  identityKeys?: string[];
  rendering?: {
    pageOffsets?: Record<number, PageOffset>;
    overflowStrategy?: 'truncate' | 'shrink' | 'continue';
  };
}

export interface EvidenceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VerifiedEvidence {
  page: number;
  quote: string;
  /** Character offsets into the whitespace-normalized page text. */
  start: number;
  end: number;
  box?: EvidenceBox;
}

export type ConfidenceSource = 'deterministic_match' | 'model_self_reported' | 'none';

/** What an extraction provider proposed for one field, before verification. */
export interface ProposedValue {
  semanticKey: string;
  value: string | null;
  quote: string | null;
  page: number | null;
  confidence?: number | null;
}

export interface ExtractionProviderRequest {
  document: ParsedDocument;
  fields: Field[];
}

export interface ExtractionProviderResult {
  proposals: ProposedValue[];
  model: string;
  promptVersion: string;
  prompt: string;
  rawResponse: string;
}

/**
 * A replaceable structured-extraction backend. Implementations must not decide
 * whether their evidence is trustworthy: verification happens afterwards,
 * against the parsed document, in `runExtraction`.
 */
export interface ExtractionProvider {
  readonly name: string;
  extract(request: ExtractionProviderRequest): Promise<ExtractionProviderResult>;
}

export interface FieldExtraction {
  semanticKey: string;
  method: 'pattern' | 'llm';
  /** Raw value as found; null when the field is a gap. */
  value: string | null;
  /** Canonical form used for comparison and output (ISO dates, plain decimals). */
  normalizedValue: string | null;
  evidence: VerifiedEvidence | null;
  confidence: number | null;
  confidenceSource: ConfidenceSource;
  gapReason: string | null;
  /** What the provider claimed when its evidence could not be verified. */
  unverified?: { value: string | null; quote: string | null; page: number | null };
  model?: string;
  promptVersion?: string;
}

export interface ModelCallRecord {
  purpose: 'extraction' | 'semantic_validation';
  provider: string;
  model: string;
  promptVersion: string;
  prompt: string;
  rawResponse: string;
  error?: string;
}

export interface ExtractionOutcome {
  fields: FieldExtraction[];
  modelCalls: ModelCallRecord[];
}

export type ValidationOutcomeKind = 'pass' | 'fail' | 'skipped' | 'error';

export interface FieldValidationResult {
  semanticKey: string;
  ruleId: string;
  method: 'deterministic' | 'semantic';
  ruleVersion: string;
  outcome: ValidationOutcomeKind;
  explanation: string;
  model?: string;
  promptVersion?: string;
  confidence?: number | null;
  confidenceSource?: ConfidenceSource;
}

export interface SemanticCheckRequest {
  semanticKey: string;
  value: string;
  quote: string;
  prompt: string;
}

export interface SemanticCheckResult {
  semanticKey: string;
  outcome: 'pass' | 'fail' | 'uncertain';
  explanation: string;
  confidence: number | null;
}

/** LLM-backed semantic checks, batched per document. */
export interface SemanticValidator {
  readonly name: string;
  check(
    document: ParsedDocument,
    checks: SemanticCheckRequest[]
  ): Promise<{ results: SemanticCheckResult[]; call: ModelCallRecord }>;
}

export type Disposition = 'gap' | 'needs_review' | 'auto_approved';
