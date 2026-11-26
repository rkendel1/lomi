import { createRequire } from 'node:module';
import type { ParsedDocument, SemanticCheckRequest, SemanticCheckResult, SemanticValidator } from '@lomi/docops';

export const LAYA_PROMPT_VERSION = 'laya-noul-1';

/** The part of rust-ml-runtime's public `LocalML` API this adapter uses. */
export interface DecisionRuntime {
  decideAsync(request: { model: string; input: unknown; decisions: unknown[] }): Promise<unknown>;
}

interface LayaDecision {
  name: string;
  value: { type: string; value: unknown };
  probabilities: Record<string, number>;
  confidence: number;
}

interface LayaResult {
  model: { identifier: string; revision?: string };
  backend: string;
  decisions: LayaDecision[];
  provenance?: { artifact_sha256?: string; runtime_version?: string };
}

/**
 * Load rust-ml-runtime's native Node binding in-process. Loaded lazily so a
 * missing native package (e.g. a musl image) or an uninstalled model surfaces
 * as a provider failure on use, not a crash at startup.
 */
export function nativeLayaRuntime(modelRoot?: string): () => Promise<DecisionRuntime> {
  return async () => {
    const require = createRequire(import.meta.url);
    const { LocalML } = require('@rust-ml-runtime/node') as typeof import('@rust-ml-runtime/node');
    return (await LocalML.create({ modelRoot })) as unknown as DecisionRuntime;
  };
}

/**
 * Semantic validation with Laya, a local structured-decision model run
 * in-process through rust-ml-runtime's native binding. Laya only answers
 * bounded questions — here, a yes/no ("noul") decision about an already
 * extracted, already verified candidate. It never extracts values. Its
 * probabilities are recorded as model output, not as calibrated truth.
 */
export class LayaSemanticValidator implements SemanticValidator {
  readonly name = 'laya';
  private runtime: Promise<DecisionRuntime> | null = null;

  constructor(
    private readonly load: () => Promise<DecisionRuntime>,
    private readonly options: { model?: string; uncertainBelow?: number } = {}
  ) {}

  private getRuntime(): Promise<DecisionRuntime> {
    this.runtime ??= this.load().catch((error) => {
      this.runtime = null; // retry on a later job, e.g. after the model is installed
      throw new Error(`Laya runtime unavailable: ${(error as Error).message}`);
    });
    return this.runtime;
  }

  private request(check: SemanticCheckRequest) {
    return {
      model: this.options.model ?? 'laya',
      input: `Field: ${check.semanticKey}\nExtracted value: ${check.value}\nEvidence from the document: "${check.quote}"`,
      decisions: [
        {
          name: 'holds',
          instructions: check.prompt,
          kind: { type: 'noul', false_description: 'No, the check does not hold.', true_description: 'Yes, the check holds.' },
        },
      ],
    };
  }

  async check(_document: ParsedDocument, checks: SemanticCheckRequest[]) {
    const runtime = await this.getRuntime();
    const uncertainBelow = this.options.uncertainBelow ?? 0.6;
    const requests = checks.map((c) => this.request(c));
    const responses: LayaResult[] = [];
    for (const body of requests) responses.push((await runtime.decideAsync(body)) as LayaResult);

    const results: SemanticCheckResult[] = checks.map((check, i) => {
      const decision = responses[i]?.decisions?.find((d) => d.name === 'holds');
      if (!decision) return { semanticKey: check.semanticKey, outcome: 'uncertain', explanation: 'Laya returned no decision.', confidence: null };
      const holds = decision.value.value === true;
      const p = decision.probabilities[holds ? 'true' : 'false'] ?? decision.confidence;
      return {
        semanticKey: check.semanticKey,
        outcome: p < uncertainBelow ? 'uncertain' : holds ? 'pass' : 'fail',
        explanation: `Laya answered ${holds ? 'yes' : 'no'} (p=${p.toFixed(2)}).`,
        confidence: p,
      };
    });

    const first = responses[0];
    const model = first ? `${first.model.identifier}${first.model.revision ? `@${first.model.revision}` : ''} (${first.backend})` : 'laya';
    return {
      results,
      call: {
        purpose: 'semantic_validation' as const,
        provider: this.name,
        model,
        promptVersion: LAYA_PROMPT_VERSION,
        prompt: JSON.stringify(requests),
        rawResponse: JSON.stringify(responses),
      },
      confidenceSource: 'model_probability' as const,
    };
  }
}
