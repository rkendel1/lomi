import { passages, type ParsedDocument, type ProviderReadiness } from '@lomi/docops';
import type { LayaSession } from './laya';

export const LAYA_CLASSIFY_PROMPT_VERSION = 'laya-classify-noul-1';

/** The best type must score at least this… */
export const MIN_TYPE_SCORE = 0.6;
/** …and beat the runner-up by this much; otherwise a person chooses. */
export const MIN_TYPE_MARGIN = 0.3;
/** How much of the document is shown to the model (from the start; titles and headings live there). */
const MAX_INPUT_CHARS = 2000;

/** A document type the customer has published, as the classifier sees it. */
export interface TypeCandidate {
  key: string;
  name: string;
  description: string | null;
  /** Field labels the type's template reads; they describe what such a document states. */
  fields: string[];
}

export interface ClassificationResult {
  /** The chosen type, or null when no type was clear enough. */
  typeKey: string | null;
  scores: Array<{ key: string; score: number }>;
  reason: string;
  model: string;
  promptVersion: string;
  prompt: string;
  rawResponse: string;
}

export interface DocumentClassifier {
  readonly name: string;
  readiness(): Promise<ProviderReadiness>;
  classify(document: ParsedDocument, types: TypeCandidate[]): Promise<ClassificationResult>;
}

/** The question asked for one type. Field labels make types with similar names distinguishable. */
export function typeQuestion(t: TypeCandidate): string {
  const what = t.description?.trim() ? ` (${t.description.trim().replace(/\.$/, '')})` : '';
  const states = t.fields.length ? `, a document that states ${t.fields.slice(0, 8).join(', ').toLowerCase()}` : '';
  return `Is this document a ${t.name.toLowerCase()}${what}${states}?`;
}

/** The start of the document as plain text, in reading order. */
export function documentHead(document: ParsedDocument, maxChars = MAX_INPUT_CHARS): string {
  let out = '';
  for (const page of document.pages) {
    for (const p of passages(page)) {
      if (out.length >= maxChars) return out.slice(0, maxChars);
      out += (out ? '\n' : '') + p;
    }
  }
  return out.slice(0, maxChars);
}

/** Pick a type from yes/no scores, or none when the evidence is weak or ambiguous. Deterministic. */
export function decideType(scores: Array<{ key: string; score: number }>): { typeKey: string | null; reason: string } {
  const ranked = [...scores].sort((a, b) => b.score - a.score);
  const [best, second] = ranked;
  if (!best) return { typeKey: null, reason: 'No published document types to choose from.' };
  if (best.score < MIN_TYPE_SCORE) {
    return { typeKey: null, reason: `No type fits clearly (best: ${best.key} at ${best.score.toFixed(2)}, below ${MIN_TYPE_SCORE}).` };
  }
  if (second && best.score - second.score < MIN_TYPE_MARGIN) {
    return { typeKey: null, reason: `Ambiguous between ${best.key} (${best.score.toFixed(2)}) and ${second.key} (${second.score.toFixed(2)}).` };
  }
  return { typeKey: best.key, reason: `Identified as ${best.key} (${best.score.toFixed(2)}${second ? `; next ${second.key} ${second.score.toFixed(2)}` : ''}).` };
}

interface LayaDecision {
  name: string;
  probabilities: Record<string, number>;
}
interface LayaResult {
  model: { identifier: string; revision?: string };
  backend: string;
  decisions: LayaDecision[];
}

/**
 * Identify which of the customer's document types a submission is, with Laya.
 * One call: one yes/no question per type over the start of the document. Laya
 * only scores the customer's own types; the choice and its thresholds are
 * deterministic (`decideType`), and an unclear result goes to a person rather
 * than being guessed.
 */
export class LayaDocumentClassifier implements DocumentClassifier {
  readonly name = 'laya';

  constructor(private readonly session: LayaSession) {}

  readiness(): Promise<ProviderReadiness> {
    return this.session.readiness();
  }

  async classify(document: ParsedDocument, types: TypeCandidate[]): Promise<ClassificationResult> {
    const runtime = await this.session.get('extraction');
    const request = {
      model: this.session.model,
      input: documentHead(document),
      decisions: types.map((t, i) => ({ name: `t${i}`, instructions: typeQuestion(t), kind: { type: 'noul', false_description: 'No', true_description: 'Yes' } })),
    };
    const result = (await runtime.decideAsync(request)) as LayaResult;
    const scores = types.map((t, i) => ({ key: t.key, score: Number((result.decisions.find((d) => d.name === `t${i}`)?.probabilities.true ?? 0).toFixed(4)) }));
    const decision = decideType(scores);
    return {
      ...decision,
      scores,
      model: `${result.model.identifier}@${result.model.revision ?? '?'} (${result.backend})`,
      promptVersion: LAYA_CLASSIFY_PROMPT_VERSION,
      prompt: JSON.stringify({ minScore: MIN_TYPE_SCORE, minMargin: MIN_TYPE_MARGIN, request }),
      rawResponse: JSON.stringify(result),
    };
  }
}
