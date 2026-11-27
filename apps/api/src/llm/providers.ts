import Anthropic from '@anthropic-ai/sdk';
import { ProviderNotReadyError, type ExtractionProvider, type SemanticValidator } from '@lomi/docops';
import { AnthropicExtractionProvider, AnthropicSemanticValidator } from './anthropic';
import { LayaSemanticValidator, LayaSession, nativeLaya, type LayaNative } from './laya';
import { LayaDocumentClassifier, type DocumentClassifier } from './layaClassification';
import { LayaExtractionProvider } from './layaExtraction';

/**
 * Model providers by role. The deployment *registers* what it can run; a
 * tenant *chooses* and *authorizes*. Rules:
 *
 * 1. Selection is explicit. A tenant's `settings.models` names a provider per
 *    role. Without one, the deployment default applies, and deployment
 *    defaults may only name local providers.
 * 2. External processing is tenant-authorized. A provider that sends document
 *    content off Lomi's infrastructure (Anthropic) is used only when
 *    `settings.models.externalProcessing.allowed` is true.
 * 3. Fallback is explicit. If the chosen provider is not ready, Lomi uses
 *    `semanticFallback` only when the tenant configured it and the fallback is
 *    itself permitted under rule 2. Otherwise processing stops with a
 *    readiness error for an operator — it is never silently rerouted.
 *
 * Roles: extraction `laya | anthropic | none`; semantic `laya | anthropic | none`.
 * Laya extracts by choosing among verbatim passages/candidates (it never writes
 * text); Anthropic extracts generatively. Either way evidence is verified after. `none` means no model for that role:
 * pattern extraction only / semantic checks recorded as skipped.
 *
 * Economics: Laya runs locally with no per-call cost for high-volume bounded
 * decisions; paid generative inference is reserved for work that needs it.
 */
export interface ProviderRegistry {
  extraction: Record<string, ExtractionProvider>;
  semantic: Record<string, SemanticValidator>;
  /** Identifies the document type of submissions sent without one (local Laya only; never external). */
  classifier?: DocumentClassifier | null;
  defaults: { extraction: string; semantic: string };
}

export interface ProviderEnv {
  anthropicApiKey?: string;
  extractionModel: string;
  semanticModel: string;
  layaEnabled?: boolean;
  layaModelRoot?: string;
  extractionDefault?: string;
  semanticDefault?: string;
  /** Injected in tests; defaults to the native binding. */
  layaNative?: LayaNative;
}

export function buildProviders(env: ProviderEnv): ProviderRegistry {
  const extraction: Record<string, ExtractionProvider> = {};
  const semantic: Record<string, SemanticValidator> = {};
  let classifier: DocumentClassifier | null = null;
  if (env.anthropicApiKey) {
    const client = new Anthropic({ apiKey: env.anthropicApiKey });
    extraction.anthropic = new AnthropicExtractionProvider(client, env.extractionModel);
    semantic.anthropic = new AnthropicSemanticValidator(client, env.semanticModel);
  }
  if (env.layaEnabled) {
    // One loaded model serves both roles.
    const session = new LayaSession(env.layaNative ?? nativeLaya(), { modelRoot: env.layaModelRoot });
    extraction.laya = new LayaExtractionProvider(session);
    semantic.laya = new LayaSemanticValidator(session);
    classifier = new LayaDocumentClassifier(session);
  }

  const localDefault = (name: string | undefined, available: Record<string, { external: boolean }>, role: string) => {
    if (!name || name === 'none') return 'none';
    const provider = available[name];
    if (provider?.external) throw new Error(`Deployment default ${role} provider "${name}" is external; external providers must be chosen and authorized per tenant.`);
    return name;
  };
  return {
    extraction,
    semantic,
    classifier,
    defaults: {
      extraction: localDefault(env.extractionDefault, extraction, 'extraction'),
      semantic: localDefault(env.semanticDefault, semantic, 'semantic'),
    },
  };
}

export interface TenantModelSettings {
  extraction?: string;
  semantic?: string;
  semanticFallback?: string;
  externalProcessing?: { allowed: boolean; authorizedBy?: string; authorizedAt?: string };
}

export function tenantModelSettings(settings: Record<string, unknown> | null | undefined): TenantModelSettings {
  return ((settings ?? {}).models ?? {}) as TenantModelSettings;
}

export interface ProviderSelection {
  extraction: ExtractionProvider | null;
  semantic: SemanticValidator | null;
  /** Human-readable record of how the selection was made, kept with the processing results. */
  notes: string[];
  fallbackUsed: { role: 'semantic'; from: string; to: string; reason: string } | null;
}

const CONFIGURE_ACTION = "Change the tenant's model settings or configure the provider on the worker, then retry the document.";

function permitted(role: 'extraction' | 'semantic', name: string, provider: { external: boolean } | undefined, policy: TenantModelSettings) {
  if (!provider) {
    throw new ProviderNotReadyError(name, role, `provider "${name}" is not configured on this deployment`, CONFIGURE_ACTION);
  }
  if (provider.external && !policy.externalProcessing?.allowed) {
    throw new ProviderNotReadyError(
      name,
      role,
      'this tenant has not authorized sending document content to an external model provider',
      "Record the customer's authorization for external processing in the tenant's model settings, or choose a local provider."
    );
  }
}

/**
 * Choose providers for one document. Only roles the template actually needs
 * are resolved, so a template with no LLM fields never touches an extraction
 * model and a missing model only blocks documents that need it.
 */
export async function selectProviders(
  registry: ProviderRegistry,
  settings: Record<string, unknown> | null | undefined,
  needs: { extraction: boolean; semantic: boolean }
): Promise<ProviderSelection> {
  const policy = tenantModelSettings(settings);
  const notes: string[] = [];
  let extraction: ExtractionProvider | null = null;
  let semantic: SemanticValidator | null = null;
  let fallbackUsed: ProviderSelection['fallbackUsed'] = null;

  if (needs.extraction) {
    const name = policy.extraction ?? registry.defaults.extraction;
    if (name === 'none') {
      notes.push('extraction: no model configured; model-extracted fields are reported as gaps');
    } else {
      const provider = registry.extraction[name];
      permitted('extraction', name, provider, policy);
      const readiness = await provider!.readiness();
      if (!readiness.ready) throw new ProviderNotReadyError(name, 'extraction', readiness.detail, CONFIGURE_ACTION);
      extraction = provider!;
      notes.push(`extraction: ${name}${provider!.external ? ' (external, tenant-authorized)' : ''}`);
    }
  }

  if (needs.semantic) {
    const name = policy.semantic ?? registry.defaults.semantic;
    if (name === 'none') {
      notes.push('semantic: no model configured; semantic checks recorded as skipped');
    } else {
      const provider = registry.semantic[name];
      permitted('semantic', name, provider, policy);
      const readiness = await provider!.readiness();
      if (readiness.ready) {
        semantic = provider!;
        notes.push(`semantic: ${name}${readiness.model ? ` (${readiness.model})` : ''}`);
      } else {
        const fallbackName = policy.semanticFallback;
        if (!fallbackName || fallbackName === 'none') {
          throw new ProviderNotReadyError(name, 'semantic', readiness.detail, provider instanceof LayaSemanticValidator ? 'Install the Laya model on the worker (`ml-runtime model install laya`), or change the tenant\'s semantic provider, then retry.' : CONFIGURE_ACTION);
        }
        const fallback = registry.semantic[fallbackName];
        permitted('semantic', fallbackName, fallback, policy);
        const fbReady = await fallback!.readiness();
        if (!fbReady.ready) throw new ProviderNotReadyError(fallbackName, 'semantic', fbReady.detail, CONFIGURE_ACTION);
        semantic = fallback!;
        fallbackUsed = { role: 'semantic', from: name, to: fallbackName, reason: readiness.detail };
        notes.push(`semantic: ${fallbackName} (configured fallback; ${name} not ready: ${readiness.detail})`);
      }
    }
  }
  return { extraction, semantic, notes, fallbackUsed };
}
