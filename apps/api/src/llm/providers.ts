import Anthropic from '@anthropic-ai/sdk';
import type { ExtractionProvider, SemanticValidator } from '@lomi/docops';
import { AnthropicExtractionProvider, AnthropicSemanticValidator } from './anthropic';
import { LayaSemanticValidator, nativeLayaRuntime } from './laya';

/**
 * Model providers by role. Each role has named, interchangeable options; a
 * tenant can choose per role in `tenants.settings.providers`, otherwise the
 * deployment default applies. `none` is always valid and means "do not use a
 * model": extraction falls back to deterministic patterns only, and semantic
 * checks are recorded as skipped for a human to cover.
 *
 * - extraction: `anthropic` | `none`        (Laya is a decision model; it does not extract spans)
 * - semantic:   `laya` | `anthropic` | `none`
 *
 * Economics: Laya runs locally (no per-call cost) for high-volume bounded
 * decisions; paid generative inference is reserved for extraction that needs it.
 */
export interface ProviderRegistry {
  extraction: Record<string, ExtractionProvider>;
  semantic: Record<string, SemanticValidator>;
  defaults: { extraction: string; semantic: string };
}

export interface ProviderEnv {
  anthropicApiKey?: string;
  extractionModel: string;
  semanticModel: string;
  /** Enable Laya (in-process rust-ml-runtime). */
  layaEnabled?: boolean;
  layaModelRoot?: string;
  extractionDefault?: string;
  semanticDefault?: string;
}

export function buildProviders(env: ProviderEnv): ProviderRegistry {
  const extraction: Record<string, ExtractionProvider> = {};
  const semantic: Record<string, SemanticValidator> = {};
  if (env.anthropicApiKey) {
    const client = new Anthropic({ apiKey: env.anthropicApiKey });
    extraction.anthropic = new AnthropicExtractionProvider(client, env.extractionModel);
    semantic.anthropic = new AnthropicSemanticValidator(client, env.semanticModel);
  }
  if (env.layaEnabled) semantic.laya = new LayaSemanticValidator(nativeLayaRuntime(env.layaModelRoot));

  const pick = (wanted: string | undefined, available: Record<string, unknown>, order: string[]) =>
    wanted && (wanted === 'none' || wanted in available) ? wanted : order.find((o) => o in available) ?? 'none';
  return {
    extraction,
    semantic,
    defaults: {
      extraction: pick(env.extractionDefault, extraction, ['anthropic']),
      semantic: pick(env.semanticDefault, semantic, ['laya', 'anthropic']),
    },
  };
}

export function resolveProviders(registry: ProviderRegistry, tenantSettings: Record<string, unknown> | null | undefined) {
  const chosen = ((tenantSettings ?? {}).providers ?? {}) as { extraction?: string; semantic?: string };
  const extractionName = chosen.extraction ?? registry.defaults.extraction;
  const semanticName = chosen.semantic ?? registry.defaults.semantic;
  return {
    extractionName,
    semanticName,
    extraction: registry.extraction[extractionName] ?? null,
    semantic: registry.semantic[semanticName] ?? null,
  };
}
