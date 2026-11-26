import type { Field } from '@lomi/core';
import { runExtraction } from './extraction';
import {
  decideDisposition,
  runSemanticValidation,
  semanticCheckRequests,
  validateCrossField,
  validateField,
} from './validation';
import type {
  Disposition,
  ExtractionProvider,
  FieldExtraction,
  FieldValidationResult,
  ModelCallRecord,
  ParsedDocument,
  SemanticValidator,
  TemplateDefinition,
} from './types';

export interface ProcessedField {
  field: Field;
  extraction: FieldExtraction;
  validations: FieldValidationResult[];
  disposition: Disposition;
}

export interface ProcessedDocument {
  fields: ProcessedField[];
  modelCalls: ModelCallRecord[];
}

export interface ProcessOptions {
  extractionProvider: ExtractionProvider | null;
  semanticValidator: SemanticValidator | null;
  /** Called between stages so callers can record observable progress. */
  onStage?: (stage: 'extracting' | 'validating') => Promise<void> | void;
}

/** Extraction → evidence verification → deterministic + semantic validation → disposition. */
export async function processDocument(
  document: ParsedDocument,
  template: TemplateDefinition,
  options: ProcessOptions
): Promise<ProcessedDocument> {
  await options.onStage?.('extracting');
  const extraction = await runExtraction(document, template, options.extractionProvider);

  await options.onStage?.('validating');
  const byKey = new Map(extraction.fields.map((f) => [f.semanticKey, f]));
  const validations: FieldValidationResult[] = [];
  for (const field of template.fields) {
    const value = byKey.get(field.semanticKey);
    if (value) validations.push(...validateField(field, value));
  }
  validations.push(...validateCrossField(template.crossFieldRules ?? [], byKey));
  const semantic = await runSemanticValidation(
    document,
    semanticCheckRequests(template, byKey),
    options.semanticValidator
  );
  validations.push(...semantic.results);

  const fields = template.fields
    .filter((f) => byKey.has(f.semanticKey))
    .map((field) => {
      const ext = byKey.get(field.semanticKey)!;
      const mine = validations.filter((v) => v.semanticKey === field.semanticKey);
      return { field, extraction: ext, validations: mine, disposition: decideDisposition(field, ext, mine) };
    });

  return { fields, modelCalls: [...extraction.modelCalls, ...semantic.calls] };
}
