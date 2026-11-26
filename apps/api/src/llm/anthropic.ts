import Anthropic from '@anthropic-ai/sdk';
import {
  documentText,
  type ExtractionProvider,
  type ExtractionProviderRequest,
  type ExtractionProviderResult,
  type ParsedDocument,
  type SemanticCheckRequest,
  type SemanticCheckResult,
  type SemanticValidator,
} from '@lomi/docops';

export const EXTRACTION_PROMPT_VERSION = 'anthropic-extract-1';
export const SEMANTIC_PROMPT_VERSION = 'anthropic-semantic-1';

const EXTRACTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['fields'],
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['semanticKey', 'value', 'quote', 'page', 'confidence'],
        properties: {
          semanticKey: { type: 'string' },
          value: { type: ['string', 'null'] },
          quote: { type: ['string', 'null'] },
          page: { type: ['integer', 'null'] },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

const SEMANTIC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['results'],
  properties: {
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['semanticKey', 'answer', 'outcome', 'explanation', 'confidence'],
        properties: {
          semanticKey: { type: 'string' },
          answer: { type: 'string' },
          outcome: { type: 'string', enum: ['pass', 'fail', 'uncertain'] },
          explanation: { type: 'string' },
          confidence: { type: 'number' },
        },
      },
    },
  },
} as const;

async function structuredCall(client: Anthropic, model: string, system: string, user: string, schema: Record<string, unknown>) {
  const response = await client.beta.messages.create({
    model,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
    system,
    messages: [{ role: 'user', content: user }],
  });
  if (response.stop_reason === 'refusal') throw new Error('The model declined this request.');
  if (response.stop_reason === 'max_tokens') throw new Error('The model response was truncated.');
  const text = response.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
  return { raw: text, parsed: JSON.parse(text) as unknown, servedBy: response.model };
}

/** Structured field extraction with Claude. Evidence it returns is verified afterwards; it is never trusted as-is. */
export class AnthropicExtractionProvider implements ExtractionProvider {
  readonly name = 'anthropic';
  /** Document text is sent to Anthropic's API. Only used for tenants that authorized external processing. */
  readonly external = true;
  constructor(
    private readonly client: Anthropic,
    private readonly model: string
  ) {}

  async readiness() {
    return { ready: true, detail: 'API key configured', model: this.model };
  }

  async extract({ document, fields }: ExtractionProviderRequest): Promise<ExtractionProviderResult> {
    const system =
      'You extract business data from documents. For every requested field return the value exactly as written, ' +
      'a verbatim quote copied character-for-character from the document text that contains the value, and the ' +
      '0-based page index. If the document does not state the field, return null value and null quote. Never infer or compute values.';
    const fieldList = fields
      .map((f) => `- ${f.semanticKey} (${f.displayLabel}; type ${f.dataType ?? f.type})${f.extraction?.instructions ? `: ${f.extraction.instructions}` : ''}`)
      .join('\n');
    const user = `Fields to extract:\n${fieldList}\n\nDocument text (page markers are 1-based; report 0-based page indexes):\n${documentText(document)}`;
    const { raw, parsed, servedBy } = await structuredCall(this.client, this.model, system, user, EXTRACTION_SCHEMA);
    const proposals = ((parsed as { fields?: unknown[] }).fields ?? []) as ExtractionProviderResult['proposals'];
    return { proposals, model: servedBy, promptVersion: EXTRACTION_PROMPT_VERSION, prompt: `${system}\n\n${user}`, rawResponse: raw };
  }
}

/** Semantic checks with a generative model; confidence is the model's own estimate. */
export class AnthropicSemanticValidator implements SemanticValidator {
  readonly name = 'anthropic';
  readonly external = true;
  constructor(
    private readonly client: Anthropic,
    private readonly model: string
  ) {}

  async readiness() {
    return { ready: true, detail: 'API key configured', model: this.model };
  }

  async check(_document: ParsedDocument, checks: SemanticCheckRequest[]) {
    const system =
      'You review extracted document values. For each check, answer pass, fail or uncertain using only the quoted evidence, ' +
      'with a one-sentence explanation. Use uncertain when the evidence does not settle the question.';
    const shape = (c: SemanticCheckRequest) =>
      c.decision.type === 'choice'
        ? `choose one of [${c.decision.options.join(', ')}]; pass if the answer is one of [${c.decision.accept.join(', ')}]`
        : c.decision.type === 'score'
          ? `score on levels ${c.decision.levels.map((l, i) => `${i}=${l}`).join(', ')}; pass if level >= ${c.decision.minLevel}`
          : 'answer yes or no; pass if yes';
    const user = checks
      .map((c, i) => `${i + 1}. semanticKey: ${c.semanticKey}\n   question: ${c.prompt}\n   answer format: ${shape(c)}\n   value: ${c.value}\n   evidence: "${c.quote}"`)
      .join('\n');
    const { raw, parsed, servedBy } = await structuredCall(this.client, this.model, system, user, SEMANTIC_SCHEMA);
    const raw_results = ((parsed as { results?: SemanticCheckResult[] }).results ?? []) as SemanticCheckResult[];
    const floors = new Map(checks.map((c) => [c.semanticKey, c.minConfidence]));
    const results = raw_results.map((r) =>
      r.confidence !== null && r.confidence < (floors.get(r.semanticKey) ?? 0.6) && r.outcome !== 'uncertain'
        ? { ...r, outcome: 'uncertain' as const, explanation: `${r.explanation} (self-reported confidence ${r.confidence} below floor)` }
        : r
    );
    return {
      results,
      call: { purpose: 'semantic_validation' as const, provider: this.name, model: servedBy, promptVersion: SEMANTIC_PROMPT_VERSION, prompt: `${system}\n\n${user}`, rawResponse: raw },
      confidenceSource: 'model_self_reported' as const,
    };
  }
}
