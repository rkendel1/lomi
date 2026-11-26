import type { Field } from '@lomi/core';
import { indexPageText, verifyQuote } from './text';
import { normalizeValue, valueSupportedByQuote } from './values';
import type {
  ExtractionOutcome,
  ExtractionProvider,
  FieldExtraction,
  ModelCallRecord,
  ParsedDocument,
  ProposedValue,
  TemplateDefinition,
} from './types';
import { ProviderNotReadyError } from './types';

/** Fields that carry business data (signatures/initials are render-only). */
export function extractableFields(template: TemplateDefinition): Field[] {
  return template.fields.filter((f) => f.semanticKey && f.extraction);
}

function gap(field: Field, reason: string, extra: Partial<FieldExtraction> = {}): FieldExtraction {
  return {
    semanticKey: field.semanticKey,
    method: field.extraction?.method ?? 'pattern',
    value: null,
    normalizedValue: null,
    evidence: null,
    confidence: null,
    confidenceSource: 'none',
    gapReason: reason,
    ...extra,
  };
}

/** Deterministic extraction: first capture group is the value, the whole match is the quote. */
export function extractByPattern(document: ParsedDocument, field: Field): ProposedValue {
  const config = field.extraction;
  if (!config?.pattern) return { semanticKey: field.semanticKey, value: null, quote: null, page: null };
  const flags = (config.flags ?? '').replace(/g/g, '');
  const regex = new RegExp(config.pattern, flags);
  for (const page of document.pages) {
    const match = indexPageText(page).text.match(regex);
    if (match) {
      return {
        semanticKey: field.semanticKey,
        value: (match[1] ?? match[0]).trim(),
        quote: match[0].trim(),
        page: page.pageIndex,
        confidence: 1,
      };
    }
  }
  return { semanticKey: field.semanticKey, value: null, quote: null, page: null };
}

/**
 * Turn a proposal into a field extraction. Evidence is verified against the
 * parsed text; anything unverifiable becomes a gap with the original claim
 * preserved for investigation.
 */
export function verifyProposal(
  document: ParsedDocument,
  field: Field,
  proposal: ProposedValue | undefined,
  meta: Pick<FieldExtraction, 'method' | 'confidenceSource' | 'model' | 'promptVersion'>
): FieldExtraction {
  if (!proposal || proposal.value === null || proposal.value === undefined || `${proposal.value}`.trim() === '') {
    return gap(field, 'No value for this field was found in the document.', { ...meta, confidenceSource: 'none' });
  }
  const value = `${proposal.value}`.trim();
  const unverified = { value, quote: proposal.quote ?? null, page: proposal.page ?? null };

  const verification = verifyQuote(document, proposal.quote, proposal.page);
  if (!verification.verified) {
    return gap(field, `Unsupported value: ${verification.reason}`, { ...meta, unverified });
  }
  if (!valueSupportedByQuote(field, value, verification.evidence.quote)) {
    return gap(field, 'Unsupported value: the quoted evidence does not contain the extracted value.', {
      ...meta,
      unverified,
    });
  }
  const normalizedValue = normalizeValue(field, value);
  if (normalizedValue === null) {
    return gap(field, `The extracted text "${value}" could not be interpreted as a ${field.dataType ?? field.type}.`, {
      ...meta,
      unverified,
    });
  }
  return {
    semanticKey: field.semanticKey,
    value,
    normalizedValue,
    evidence: verification.evidence,
    confidence: typeof proposal.confidence === 'number' ? proposal.confidence : null,
    gapReason: null,
    ...meta,
  };
}

/**
 * Extract every configured field. Pattern fields never touch a model. LLM fields
 * go to the provider in a single call; without a provider they are reported as
 * gaps rather than silently skipped.
 */
export async function runExtraction(
  document: ParsedDocument,
  template: TemplateDefinition,
  provider: ExtractionProvider | null
): Promise<ExtractionOutcome> {
  const fields = extractableFields(template);
  const results = new Map<string, FieldExtraction>();
  const modelCalls: ModelCallRecord[] = [];

  for (const field of fields.filter((f) => f.extraction?.method === 'pattern')) {
    results.set(
      field.semanticKey,
      verifyProposal(document, field, extractByPattern(document, field), {
        method: 'pattern',
        confidenceSource: 'deterministic_match',
      })
    );
  }

  const llmFields = fields.filter((f) => f.extraction?.method === 'llm');
  if (llmFields.length > 0) {
    if (!provider) {
      for (const field of llmFields) {
        results.set(field.semanticKey, gap(field, 'No extraction model is configured, so this field was not read.', { method: 'llm' }));
      }
    } else {
      try {
        const response = await provider.extract({ document, fields: llmFields });
        modelCalls.push({
          purpose: 'extraction',
          provider: provider.name,
          model: response.model,
          promptVersion: response.promptVersion,
          prompt: response.prompt,
          rawResponse: response.rawResponse,
        });
        for (const field of llmFields) {
          const proposal = response.proposals.find((p) => p.semanticKey === field.semanticKey);
          results.set(
            field.semanticKey,
            verifyProposal(document, field, proposal, {
              method: 'llm',
              confidenceSource: 'model_self_reported',
              model: response.model,
              promptVersion: response.promptVersion,
            })
          );
        }
      } catch (error) {
        if (error instanceof ProviderNotReadyError) throw error;
        // Surface the failure to the caller: a model outage is a retryable processing
        // failure, not a set of gaps that a reviewer should fill in by hand.
        throw new ExtractionProviderError(provider.name, error);
      }
    }
  }

  return { fields: fields.map((f) => results.get(f.semanticKey)!), modelCalls };
}

export class ExtractionProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly causeError: unknown
  ) {
    super(
      `Extraction provider "${provider}" failed: ${causeError instanceof Error ? causeError.message : String(causeError)}`
    );
  }
}
