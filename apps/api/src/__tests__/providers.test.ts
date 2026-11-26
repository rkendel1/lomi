import { describe, expect, it } from 'vitest';
import { ProviderNotReadyError, type ParsedDocument, type SemanticCheckRequest } from '@lomi/docops';
import { buildProviders, selectProviders, type ProviderRegistry } from '../llm/providers';
import { LayaSemanticValidator, nativeLaya, type LayaNative } from '../llm/laya';

const doc: ParsedDocument = { pageCount: 1, parser: 'test', pages: [] };

function fakeNative(available: boolean, decide?: (req: any) => unknown): LayaNative {
  return {
    selfTest: () => ({
      available,
      model: available ? { identifier: 'laya', revision: 'r1', backend: 'onnx', decision_types: ['noul', 'choice', 'score'] } : undefined,
      checks: [{ check: 'local inference', ok: available, message: available ? 'ok' : 'model not found: laya' }],
    }),
    create: async () => ({ decideAsync: async (req) => decide!(req) }),
  };
}

const registry = (layaReady: boolean): ProviderRegistry =>
  buildProviders({
    anthropicApiKey: 'test-key-not-used',
    extractionModel: 'm',
    semanticModel: 'm',
    layaEnabled: true,
    layaNative: fakeNative(layaReady),
    semanticDefault: 'laya',
  });

describe('provider selection', () => {
  it('uses the local default when the tenant chose nothing', async () => {
    const s = await selectProviders(registry(true), {}, { extraction: false, semantic: true });
    expect(s.semantic?.name).toBe('laya');
    expect(s.fallbackUsed).toBeNull();
  });

  it('reports a missing local model as a readiness failure, never falling back silently', async () => {
    const err = await selectProviders(registry(false), { models: { externalProcessing: { allowed: true } } }, { extraction: false, semantic: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotReadyError);
    expect(err.reason).toMatch(/model not found/);
    expect(err.action).toMatch(/ml-runtime model install laya/);
  });

  it('falls back only when the tenant configured the fallback and authorized external processing', async () => {
    const unauthorized = await selectProviders(registry(false), { models: { semanticFallback: 'anthropic' } }, { extraction: false, semantic: true }).catch((e) => e);
    expect(unauthorized).toBeInstanceOf(ProviderNotReadyError);
    expect(unauthorized.reason).toMatch(/not authorized/);

    const s = await selectProviders(
      registry(false),
      { models: { semanticFallback: 'anthropic', externalProcessing: { allowed: true, authorizedBy: 'customer admin' } } },
      { extraction: false, semantic: true }
    );
    expect(s.semantic?.name).toBe('anthropic');
    expect(s.fallbackUsed).toMatchObject({ from: 'laya', to: 'anthropic', reason: expect.stringMatching(/model not found/) });
  });

  it('refuses an external extraction provider without tenant authorization', async () => {
    const err = await selectProviders(registry(true), { models: { extraction: 'anthropic' } }, { extraction: true, semantic: false }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotReadyError);
    const ok = await selectProviders(registry(true), { models: { extraction: 'anthropic', externalProcessing: { allowed: true } } }, { extraction: true, semantic: false });
    expect(ok.extraction?.name).toBe('anthropic');
  });

  it('does not resolve roles the template does not need', async () => {
    const s = await selectProviders(registry(false), {}, { extraction: false, semantic: false });
    expect(s).toMatchObject({ extraction: null, semantic: null });
  });

  it('rejects an external provider as a deployment default', () => {
    expect(() => buildProviders({ anthropicApiKey: 'k', extractionModel: 'm', semanticModel: 'm', semanticDefault: 'anthropic' })).toThrow(/external/);
  });

  it('reports an unregistered provider as a configuration failure', async () => {
    const err = await selectProviders(buildProviders({ extractionModel: 'm', semanticModel: 'm' }), { models: { semantic: 'laya' } }, { extraction: false, semantic: true }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderNotReadyError);
    expect(err.reason).toMatch(/not configured on this deployment/);
  });
});

const checks: SemanticCheckRequest[] = [
  { semanticKey: 'vendor.name', value: 'ACME Supplies Inc.', quote: 'ACME Supplies Inc.', prompt: 'Is this the name of a company?', decision: { type: 'yes_no' }, minConfidence: 0.6 },
  { semanticKey: 'vendor.kind', value: 'ACME Supplies Inc.', quote: 'ACME Supplies Inc.', prompt: 'What kind of entity is this?', decision: { type: 'choice', options: ['company', 'person', 'address'], accept: ['company'] }, minConfidence: 0.6 },
  { semanticKey: 'vendor.support', value: 'ACME Supplies Inc.', quote: 'ACME Supplies Inc.', prompt: 'How well does the evidence support the value?', decision: { type: 'score', levels: ['none', 'weak', 'some', 'strong', 'exact'], minLevel: 3 }, minConfidence: 0.05 },
];

describe('Laya adapter (fake native runtime)', () => {
  it('maps typed decisions and applies the confidence floor to the runtime-reported confidence', async () => {
    const requests: any[] = [];
    const laya = new LayaSemanticValidator(
      fakeNative(true, (req) => {
        requests.push(req);
        const type = req.decisions[0].kind.type;
        const value = type === 'noul' ? true : type === 'choice' ? 'company' : 3.4;
        const confidence = type === 'choice' ? 0.3 : 0.9;
        return { model: { identifier: 'laya', revision: 'r1' }, backend: 'onnx', decisions: [{ name: 'check', kind: type, value: { type, value }, probabilities: {}, confidence }] };
      })
    );
    const out = await laya.check(doc, checks);
    expect(requests.map((r) => r.decisions[0].kind.type)).toEqual(['noul', 'choice', 'score']);
    expect(requests[1].decisions[0].kind.options).toEqual([{ label: 'company' }, { label: 'person' }, { label: 'address' }]);
    expect(out.results.map((r) => r.outcome)).toEqual(['pass', 'uncertain', 'pass']);
    expect(out.confidenceSource).toBe('model_probability');
    expect(out.call.model).toBe('laya@r1 (onnx)');
  });

  it('throws a readiness error, without inference, when the model is not installed', async () => {
    let created = false;
    const native = fakeNative(false);
    const laya = new LayaSemanticValidator({ ...native, create: async () => { created = true; return native.create({}); } });
    await expect(laya.check(doc, checks)).rejects.toBeInstanceOf(ProviderNotReadyError);
    expect(created).toBe(false);
  });
});

const modelDir = process.env.LAYA_TEST_MODEL_DIR;
describe.skipIf(!modelDir)('Laya adapter (real rust-ml-runtime model; set LAYA_TEST_MODEL_DIR)', () => {
  it('reports readiness and answers yes/no, choice and score decisions', async () => {
    const laya = new LayaSemanticValidator(nativeLaya(), { modelRoot: modelDir });
    const readiness = await laya.readiness();
    expect(readiness).toMatchObject({ ready: true, model: expect.stringMatching(/laya-onnx@68f27df/) });
    const out = await laya.check(doc, checks);
    expect(out.results).toHaveLength(3);
    for (const r of out.results) {
      expect(['pass', 'fail', 'uncertain']).toContain(r.outcome);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
    expect(out.results[0]).toMatchObject({ outcome: 'pass', answer: 'yes' });
    expect(JSON.parse(out.call.rawResponse)[0].provenance.artifact_sha256).toMatch(/^[0-9a-f]{64}$/);
  }, 120_000);

  it('reports a missing model as not ready', async () => {
    const laya = new LayaSemanticValidator(nativeLaya(), { modelRoot: '/nonexistent-model-root' });
    expect(await laya.readiness()).toMatchObject({ ready: false, detail: expect.stringMatching(/model not found/) });
  });
});
