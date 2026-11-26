import type { Field, SemanticDecision } from '@lomi/core';

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

/**
 * Where a confidence number came from. None of these is treated as a calibrated
 * probability: `model_probability` is a decision model's output distribution,
 * `model_self_reported` is a generative model's own estimate.
 */
export type ConfidenceSource = 'deterministic_match' | 'model_self_reported' | 'model_probability' | 'none';

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
export interface ProviderReadiness {
  ready: boolean;
  detail: string;
  model?: string;
}

/**
 * A provider is not ready to serve (model not installed, no credentials,
 * not authorized for this tenant). This is a configuration problem for an
 * operator to fix, not a transient failure to retry.
 */
export class ProviderNotReadyError extends Error {
  constructor(
    readonly provider: string,
    readonly role: 'extraction' | 'semantic',
    readonly reason: string,
    readonly action: string
  ) {
    super(`${role} provider "${provider}" is not ready: ${reason}`);
  }
}

export interface ExtractionProvider {
  readonly name: string;
  /** Data leaves Lomi's infrastructure when this provider is used. */
  readonly external: boolean;
  readiness(): Promise<ProviderReadiness>;
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

/** `uncertain`: a model answered below its confidence floor; a human decides. */
export type ValidationOutcomeKind = 'pass' | 'fail' | 'uncertain' | 'skipped' | 'error';

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
  decision: SemanticDecision;
  minConfidence: number;
}

export interface SemanticCheckResult {
  semanticKey: string;
  outcome: 'pass' | 'fail' | 'uncertain';
  explanation: string;
  confidence: number | null;
  /** The answer as given (e.g. "yes", a choice label, a score level). */
  answer?: string;
}

/** Model-backed semantic checks (generative LLM or decision model), batched per document. */
export interface SemanticValidator {
  readonly name: string;
  readonly external: boolean;
  readiness(): Promise<ProviderReadiness>;
  check(
    document: ParsedDocument,
    checks: SemanticCheckRequest[]
  ): Promise<{ results: SemanticCheckResult[]; call: ModelCallRecord; confidenceSource: ConfidenceSource }>;
}

export type Disposition = 'gap' | 'needs_review' | 'auto_approved';
