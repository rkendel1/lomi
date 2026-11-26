import type { Field } from '@lomi/core';
import {
  passages,
  valueCandidates,
  type ExtractionProvider,
  type ExtractionProviderRequest,
  type ExtractionProviderResult,
  type ProposedValue,
  type ProviderReadiness,
  type ValueType,
} from '@lomi/docops';
import type { LayaSession } from './laya';

export const LAYA_EXTRACTION_PROMPT_VERSION = 'laya-extract-noul-2';

/** Below this joint score the field is reported as not found (a gap), not guessed. */
const MIN_JOINT_SCORE = 0.25;
const MIN_PASSAGE_SCORE = 0.3;
const PASSAGES_CONSIDERED = 4;

interface LayaDecision {
  name: string;
  probabilities: Record<string, number>;
  confidence: number;
}
interface LayaResult {
  model: { identifier: string; revision?: string };
  backend: string;
  decisions: LayaDecision[];
}

export function valueTypeOf(field: Field): ValueType {
  if (field.extraction?.valueType) return field.extraction.valueType;
  if (field.type === 'date' || field.type === 'dob' || field.dataType === 'date') return 'date';
  if (field.type === 'currency' || field.dataType === 'currency') return 'money';
  if (field.dataType === 'number') return 'number';
  return 'string';
}

/** What the model is asked about: the field's instructions, or its label. */
export function describe(field: Field): string {
  return (field.extraction?.instructions?.trim() || field.displayLabel || field.semanticKey).replace(/\s+/g, ' ');
}

/**
 * Extraction with Laya, a local decision model. Laya does not write text, so
 * it is never asked to produce a value: Lomi splits the parsed document into
 * passages and typed value candidates (verbatim text), and Laya answers yes/no
 * questions about them:
 *
 *   1. For every passage, one call with one question per field:
 *      "Does this passage state the <field>?"
 *   2. For the best few passages of each field, one call per passage:
 *      "Is "<candidate>" the <field>?" for each typed candidate in it.
 *   3. The value is the candidate with the highest passage × candidate score.
 *      Below a floor the field is reported as not found — a gap, never a guess.
 *
 * Every question and answer is kept as the call's prompt and raw response.
 * Evidence is verified against the version's text afterwards like any other
 * provider's output.
 */
export class LayaExtractionProvider implements ExtractionProvider {
  readonly name = 'laya';
  readonly external = false;

  constructor(private readonly session: LayaSession) {}

  readiness(): Promise<ProviderReadiness> {
    return this.session.readiness();
  }

  async extract({ document, fields }: ExtractionProviderRequest): Promise<ExtractionProviderResult> {
    const runtime = await this.session.get('extraction');
    const asked: unknown[] = [];
    const answered: unknown[] = [];
    let modelId = 'laya';
    const decide = async (input: string, decisions: Array<{ name: string; instructions: string }>) => {
      const request = { model: this.session.model, input, decisions: decisions.map((d) => ({ ...d, kind: { type: 'noul', false_description: 'No', true_description: 'Yes' } })) };
      asked.push(request);
      const result = (await runtime.decideAsync(request)) as LayaResult;
      answered.push(result);
      modelId = `${result.model.identifier}@${result.model.revision ?? '?'} (${result.backend})`;
      return (name: string) => result.decisions.find((d) => d.name === name)?.probabilities.true ?? 0;
    };

    const all = document.pages.flatMap((page) => passages(page).map((text) => ({ text, page: page.pageIndex })));

    // 1. Score every passage for every field in one call per passage.
    const passageScores: number[][] = [];
    for (const p of all) {
      const score = await decide(p.text, fields.map((f, i) => ({ name: `f${i}`, instructions: `Does this passage state the ${describe(f)}?` })));
      passageScores.push(fields.map((_, i) => score(`f${i}`)));
    }

    // 2–3. Joint choice of passage and value per field.
    const proposals: ProposedValue[] = [];
    for (const [i, field] of fields.entries()) {
      const ranked = all.map((p, j) => ({ ...p, score: passageScores[j][i] })).sort((a, b) => b.score - a.score);
      let best: { score: number; value: string; quote: string; page: number } | null = null;
      for (const p of ranked.slice(0, PASSAGES_CONSIDERED)) {
        if (p.score < MIN_PASSAGE_SCORE) break;
        const candidates = valueCandidates(p.text, valueTypeOf(field), describe(field));
        if (!candidates.length) continue;
        const score = await decide(p.text, candidates.map((c, k) => ({ name: `c${k}`, instructions: `Is "${c}" the ${describe(field)}?` })));
        for (const [k, c] of candidates.entries()) {
          const joint = p.score * score(`c${k}`);
          if (!best || joint > best.score) best = { score: joint, value: c, quote: p.text, page: p.page };
        }
      }
      proposals.push(
        best && best.score >= MIN_JOINT_SCORE
          ? { semanticKey: field.semanticKey, value: best.value, quote: best.quote, page: best.page, confidence: Number(best.score.toFixed(4)) }
          : { semanticKey: field.semanticKey, value: null, quote: null, page: null, confidence: best ? Number(best.score.toFixed(4)) : 0 }
      );
    }

    return {
      proposals,
      model: modelId,
      promptVersion: LAYA_EXTRACTION_PROMPT_VERSION,
      prompt: JSON.stringify({ method: 'passage and candidate yes/no decisions', minJointScore: MIN_JOINT_SCORE, requests: asked }),
      rawResponse: JSON.stringify(answered),
    };
  }
}
