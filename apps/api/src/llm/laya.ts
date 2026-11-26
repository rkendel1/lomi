import { createRequire } from 'node:module';
import {
  ProviderNotReadyError,
  type ParsedDocument,
  type ProviderReadiness,
  type SemanticCheckRequest,
  type SemanticCheckResult,
  type SemanticValidator,
} from '@lomi/docops';

export const LAYA_PROMPT_VERSION = 'laya-decision-1';

/** The part of rust-ml-runtime's public `LocalML` API this adapter uses. */
export interface DecisionRuntime {
  decideAsync(request: { model: string; input: unknown; decisions: unknown[] }): Promise<unknown>;
}

export interface LayaNative {
  selfTest(options: { modelRoot?: string; model: string }): {
    available: boolean;
    model?: { identifier: string; revision?: string; backend: string; decision_types: string[] };
    checks: Array<{ check: string; ok: boolean; message: string }>;
  };
  create(options: { modelRoot?: string }): Promise<DecisionRuntime>;
}

interface LayaDecision {
  name: string;
  kind: string;
  value: { type: string; value: unknown };
  probabilities: Record<string, number>;
  /** The runtime's own confidence; authoritative, not recomputed here. */
  confidence: number;
}

interface LayaResult {
  model: { identifier: string; revision?: string };
  backend: string;
  decisions: LayaDecision[];
  provenance?: { artifact_sha256?: string; runtime_version?: string };
}

/**
 * rust-ml-runtime's native Node binding, loaded in-process on first use.
 * Only the worker uses semantic validation, so the API process never loads it.
 */
export function nativeLaya(): LayaNative {
  const require = createRequire(import.meta.url);
  let mod: typeof import('@rust-ml-runtime/node') | undefined;
  const load = () => (mod ??= require('@rust-ml-runtime/node') as typeof import('@rust-ml-runtime/node'));
  return {
    selfTest: (options) => load().LocalML.selfTest(options) as ReturnType<LayaNative['selfTest']>,
    create: async (options) => (await load().LocalML.create(options)) as unknown as DecisionRuntime,
  };
}

const INSTALL_ACTION = 'Install the model on the worker (`ml-runtime model install laya`, or set ML_RUNTIME_MODEL_DIR), then retry the document.';

/**
 * Semantic validation with Laya, a local structured-decision model. Laya only
 * answers bounded, typed questions (yes/no, choice, score) about a value that
 * has already been extracted and whose evidence has already been verified
 * against the document. It never extracts. Its confidence is recorded as
 * model output, never as a calibrated probability.
 */
export class LayaSemanticValidator implements SemanticValidator {
  readonly name = 'laya';
  readonly external = false;
  private runtime: Promise<DecisionRuntime> | null = null;
  private ready: ProviderReadiness | null = null;

  constructor(
    private readonly native: LayaNative,
    private readonly options: { modelRoot?: string; model?: string } = {}
  ) {}

  /** Checks the native binding and the installed model without running inference. Cached once ready. */
  async readiness(): Promise<ProviderReadiness> {
    if (this.ready?.ready) return this.ready;
    try {
      const test = this.native.selfTest({ modelRoot: this.options.modelRoot, model: this.options.model ?? 'laya' });
      const failed = test.checks.filter((c) => !c.ok).map((c) => c.message);
      const result: ProviderReadiness = test.available
        ? { ready: true, detail: 'Model loaded', model: test.model ? `${test.model.identifier}@${test.model.revision} (${test.model.backend})` : 'laya' }
        : { ready: false, detail: failed.join('; ') || 'Laya is unavailable' };
      if (result.ready) this.ready = result;
      return result;
    } catch (error) {
      return { ready: false, detail: `Native runtime could not be loaded: ${(error as Error).message}` };
    }
  }

  private async getRuntime(): Promise<DecisionRuntime> {
    const readiness = await this.readiness();
    if (!readiness.ready) throw new ProviderNotReadyError(this.name, 'semantic', readiness.detail, INSTALL_ACTION);
    this.runtime ??= this.native.create({ modelRoot: this.options.modelRoot }).catch((error) => {
      this.runtime = null;
      throw new ProviderNotReadyError(this.name, 'semantic', (error as Error).message, INSTALL_ACTION);
    });
    return this.runtime;
  }

  /** Load the model ahead of the first document. Does nothing if the model is not installed. */
  async warm(): Promise<ProviderReadiness> {
    const readiness = await this.readiness();
    if (readiness.ready) await this.getRuntime();
    return readiness;
  }

  private request(check: SemanticCheckRequest) {
    const d = check.decision;
    const kind =
      d.type === 'choice'
        ? { type: 'choice', options: d.options.map((label) => ({ label })) }
        : d.type === 'score'
          ? { type: 'score', levels: d.levels }
          : { type: 'noul', false_description: 'No', true_description: 'Yes' };
    return {
      model: this.options.model ?? 'laya',
      input: `Field: ${check.semanticKey}\nExtracted value: ${check.value}\nVerified evidence from the document: "${check.quote}"`,
      decisions: [{ name: 'check', instructions: check.prompt, kind }],
    };
  }

  private interpret(check: SemanticCheckRequest, decision: LayaDecision | undefined): SemanticCheckResult {
    if (!decision) return { semanticKey: check.semanticKey, outcome: 'uncertain', explanation: 'Laya returned no decision.', confidence: null };
    const d = check.decision;
    let answer: string;
    let passed: boolean;
    if (d.type === 'choice') {
      answer = String(decision.value.value);
      passed = d.accept.includes(answer);
    } else if (d.type === 'score') {
      // The runtime reports the expected level index (0-based) as the score value.
      const level = Number(decision.value.value);
      answer = `${level.toFixed(2)} of ${d.levels.length - 1}`;
      passed = level >= d.minLevel;
    } else {
      passed = decision.value.value === true;
      answer = passed ? 'yes' : 'no';
    }
    const confidence = decision.confidence;
    const uncertain = confidence < check.minConfidence;
    return {
      semanticKey: check.semanticKey,
      outcome: uncertain ? 'uncertain' : passed ? 'pass' : 'fail',
      answer,
      confidence,
      explanation: uncertain
        ? `Laya answered "${answer}" with confidence ${confidence.toFixed(2)}, below the ${check.minConfidence} floor; a reviewer should decide.`
        : `Laya answered "${answer}" (confidence ${confidence.toFixed(2)}).`,
    };
  }

  async check(_document: ParsedDocument, checks: SemanticCheckRequest[]) {
    const runtime = await this.getRuntime();
    const requests = checks.map((c) => this.request(c));
    const responses: LayaResult[] = [];
    for (const body of requests) responses.push((await runtime.decideAsync(body)) as LayaResult);
    const results = checks.map((check, i) => this.interpret(check, responses[i]?.decisions?.find((d) => d.name === 'check')));
    const first = responses[0];
    return {
      results,
      call: {
        purpose: 'semantic_validation' as const,
        provider: this.name,
        model: first ? `${first.model.identifier}@${first.model.revision ?? '?'} (${first.backend})` : 'laya',
        promptVersion: LAYA_PROMPT_VERSION,
        prompt: JSON.stringify(requests),
        rawResponse: JSON.stringify(responses),
      },
      confidenceSource: 'model_probability' as const,
    };
  }
}
