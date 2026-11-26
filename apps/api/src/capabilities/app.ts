import { createApplication, defineCapability, type AnyCapability, type AppPortApplication } from '@appport/core';
import { authorizerFrom, combineAuthorizers, deny, permissionAuthorizer, type AuthorizationRequest } from '@appport/authorization';
import { errors, type JsonValue, type Session } from '@appport/protocol';
import { s } from '@appport/schema';
import type { TemplateDefinition } from '@lomi/docops';
import { audit, DomainError, type Actor, type Ctx } from '../domain/common';
import { addVersion, getDocument, getProgress, listDocuments, originalFile, submitDocument } from '../domain/documents';
import { generatedFile, requestGeneration, verifyGenerated } from '../domain/generation';
import { listFailures, operationalStats, providerReadiness, provenance, retryJob } from '../domain/operations';
import { proposeCorrection, reviewValue } from '../domain/review';
import { createDocumentType, getTemplate, listTemplates, publishTemplate, saveDraft, uploadBasePdf } from '../domain/templates';
import { configureIngress, createTenant, ingressList, listTenants, resolveTenant, updateModelSettings } from '../domain/tenants';
import { withSystem } from '../db/pool';
import type { MembershipClaim } from './auth';

export const APPLICATION_ID = 'ai.lomi.document-operations';

interface Claims {
  kind: 'user' | 'agent' | 'service';
  operator: boolean;
  memberships: MembershipClaim[];
}

function claimsOf(session: Session | undefined): Claims | null {
  const attrs = session?.attributes as unknown as Claims | undefined;
  return attrs && session?.principal ? attrs : null;
}

function inputTenant(input: unknown): string | undefined {
  const t = (input as { tenant?: unknown } | null)?.tenant;
  return typeof t === 'string' ? t : undefined;
}

function membershipFor(claims: Claims, ref: string): MembershipClaim | undefined {
  return claims.memberships.find((m) => m.slug === ref || m.tenantId === ref);
}

/** Permissions for this request: session-wide (Lomi-internal) plus the caller's permissions in the named tenant. */
function resolvePermissions(request: AuthorizationRequest): string[] {
  const claims = claimsOf(request.session);
  if (!claims) return []; // never grant anything without an identified principal
  const perms = ['session.read', ...(request.session?.permissions ?? [])];
  const ref = inputTenant(request.input);
  if (ref) {
    if (claims.operator) perms.push('*');
    else perms.push(...(membershipFor(claims, ref)?.permissions ?? []));
  }
  return perms;
}

const authorizer = combineAuthorizers([
  authorizerFrom('authenticated', (req) => (claimsOf(req.session) ? true : deny('Authentication is required', 'UNAUTHORIZED'))),
  // A tenant the caller does not belong to is indistinguishable from one that does not exist.
  authorizerFrom('tenant-membership', (req) => {
    const claims = claimsOf(req.session)!;
    const ref = inputTenant(req.input);
    if (!ref || claims.operator || membershipFor(claims, ref)) return true;
    return deny('Not found', 'NOT_FOUND');
  }),
  permissionAuthorizer({ resolvePermissions }),
]);

interface Call {
  actor: Actor;
  claims: Claims;
  tenantId: string;
}

function toAppPortError(error: unknown): never {
  if (error instanceof DomainError) {
    const details = (error.details ?? undefined) as JsonValue | undefined;
    switch (error.code) {
      case 'NOT_FOUND':
        throw errors.notFound(error.message, details);
      case 'CONFLICT':
        throw errors.conflict(error.message, details);
      case 'FORBIDDEN':
        throw errors.forbidden(error.message, details);
      case 'PAYLOAD_TOO_LARGE':
        throw errors.payloadTooLarge(error.message, details);
      default:
        throw errors.invalidInput(error.message, details);
    }
  }
  throw error;
}

function summarizeInput(input: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    out[k] = k === 'contentBase64' ? `[${String(v).length} base64 chars]` : k === 'definition' ? '[template definition]' : v;
  }
  return out;
}

export function buildApplication(ctx: Ctx): AppPortApplication {
  async function call(context: { principal?: { id: string; displayName?: string }; session?: Session; requestId: string; capability: { name: string } }, input: unknown): Promise<Call> {
    const claims = claimsOf(context.session);
    if (!claims) throw errors.unauthorized();
    const ref = inputTenant(input);
    const membership = ref ? membershipFor(claims, ref) : undefined;
    const tenantId = ref ? (membership?.tenantId ?? (claims.operator ? await resolveTenant(ctx, ref).catch(toAppPortError) : '')) : '';
    return {
      claims,
      tenantId,
      actor: {
        principalId: context.principal!.id,
        kind: claims.kind,
        displayName: context.principal!.displayName,
        onBehalfOf: membership?.onBehalfOf ?? null,
        capability: context.capability.name,
        requestId: context.requestId,
      },
    };
  }

  /** Every capability goes through here: tenant resolution, domain error mapping, and agent auditing. */
  function cap<I, O>(options: {
    name: string;
    description: string;
    permissions: string[];
    effect: 'observation' | 'consequential';
    input: Parameters<typeof defineCapability<I, O>>[0]['input'];
    output: Parameters<typeof defineCapability<I, O>>[0]['output'];
    idempotent?: boolean;
    run: (input: I, c: Call) => Promise<O>;
  }): AnyCapability {
    return defineCapability<I, O>({
      name: options.name,
      version: 1,
      description: options.description,
      authorization: options.permissions,
      effect: options.effect,
      idempotency: options.idempotent ? 'supported' : 'unsupported',
      input: options.input,
      output: options.output,
      handler: async (input, context) => {
        const c = await call(context, input);
        try {
          const result = await options.run(input, c);
          if (c.claims.kind === 'agent') await recordAgentCall(c, input, 'succeeded');
          return result;
        } catch (error) {
          if (c.claims.kind === 'agent') await recordAgentCall(c, input, `failed: ${(error as Error).message}`);
          return toAppPortError(error);
        }
      },
    });
  }

  async function recordAgentCall(c: Call, input: unknown, outcome: string) {
    await withSystem(ctx.db, (tx) =>
      audit(tx, {
        tenantId: c.tenantId || null,
        actor: c.actor,
        action: 'agent.capability_invoked',
        subjectType: 'capability',
        detail: { capability: c.actor.capability, onBehalfOf: c.actor.onBehalfOf, input: summarizeInput(input), outcome },
      })
    ).catch(() => undefined);
  }

  const requireOperator = (c: Call) => {
    if (!c.claims.operator) throw errors.forbidden('Lomi operators only');
  };
  const anyObject = s.record(s.unknown());
  const list = s.object({ items: s.array(s.unknown()) });
  const tenant = s.string();
  const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
  const fromB64 = (value: string) => new Uint8Array(Buffer.from(value, 'base64'));

  const submission = s.object({
    submissionId: s.string(),
    documentId: s.string(),
    versionId: s.string(),
    version: s.integer(),
    outcome: s.enum(['new_document', 'new_version', 'duplicate_exact']),
    status: s.string(),
    duplicateOf: s.optional(s.object({ documentId: s.string(), versionId: s.string(), version: s.integer() })),
  });

  const capabilities: AnyCapability[] = [
    // ── Tenancy and configuration ──────────────────────────────────────────
    cap({
      name: 'tenants.list', description: 'Tenants the caller can act in (all tenants for Lomi operators).', permissions: ['session.read'], effect: 'observation',
      input: s.object({}), output: list,
      run: async (_i, c) => ({ items: await listTenants(ctx, { tenantIds: c.claims.operator ? 'all' : c.claims.memberships.map((m) => m.tenantId) }) }),
    }),
    cap({
      name: 'tenants.create', description: 'Create a customer tenant with default ingress endpoints.', permissions: ['lomi.tenants.manage'], effect: 'consequential',
      input: s.object({ slug: s.string(), name: s.string() }), output: s.object({ id: s.string(), slug: s.string(), name: s.string() }),
      run: async (i, c) => createTenant(ctx, c.actor, i),
    }),
    cap({
      name: 'tenants.models.configure',
      description: "Choose model providers per role and record the customer's authorization (or not) for external model processing.",
      permissions: ['models.authorize'], effect: 'consequential',
      input: s.object({
        tenant,
        extraction: s.optional(s.enum(['anthropic', 'none'])),
        semantic: s.optional(s.enum(['laya', 'anthropic', 'none'])),
        semanticFallback: s.optional(s.enum(['anthropic', 'none'])),
        externalProcessingAllowed: s.optional(s.boolean()),
      }),
      output: anyObject,
      run: async ({ tenant: _t, ...rest }, c) => updateModelSettings(ctx, c.actor, { tenantId: c.tenantId, ...rest }),
    }),
    cap({
      name: 'ingress.list', description: 'Ingress endpoints configured for a tenant.', permissions: ['templates.read'], effect: 'observation',
      input: s.object({ tenant }), output: list, run: async (_i, c) => ({ items: await ingressList(ctx, c.tenantId) }),
    }),
    cap({
      name: 'ingress.configure', description: 'Create or update an ingress endpoint.', permissions: ['lomi.ingress.manage'], effect: 'consequential',
      input: s.object({ tenant, key: s.string(), kind: s.enum(['portal', 'api', 'email', 'sftp']), name: s.string(), documentType: s.optional(s.string()), enabled: s.optional(s.boolean()) }),
      output: s.object({ key: s.string(), enabled: s.boolean() }),
      run: async ({ tenant: _t, ...rest }, c) => configureIngress(ctx, c.actor, { tenantId: c.tenantId, ...rest }),
    }),

    // ── Templates (Schema Studio) ──────────────────────────────────────────
    cap({
      name: 'templates.list', description: 'Document types and their template versions.', permissions: ['templates.read'], effect: 'observation',
      input: s.object({ tenant }), output: list, run: async (_i, c) => ({ items: await listTemplates(ctx, { tenantId: c.tenantId }) }),
    }),
    cap({
      name: 'templates.get', description: 'One template version with its field definitions.', permissions: ['templates.read'], effect: 'observation',
      input: s.object({ tenant, templateVersionId: s.string() }), output: anyObject,
      run: async (i, c) => (await getTemplate(ctx, { tenantId: c.tenantId, templateVersionId: i.templateVersionId })) as unknown as Record<string, unknown>,
    }),
    cap({
      name: 'templates.documenttypes.create', description: 'Add a document type to a tenant.', permissions: ['lomi.templates.write'], effect: 'consequential',
      input: s.object({ tenant, key: s.string(), name: s.string(), description: s.optional(s.string()) }),
      output: s.object({ id: s.string(), key: s.string(), name: s.string() }),
      run: async ({ tenant: _t, ...rest }, c) => createDocumentType(ctx, c.actor, { tenantId: c.tenantId, ...rest }),
    }),
    cap({
      name: 'templates.basepdfs.upload', description: 'Store an immutable, versioned base PDF for a document type.', permissions: ['lomi.templates.write'], effect: 'consequential',
      input: s.object({ tenant, documentType: s.string(), filename: s.string(), contentBase64: s.string() }),
      output: s.object({ id: s.string(), version: s.integer(), sha256: s.string(), existing: s.boolean() }),
      run: async (i, c) => uploadBasePdf(ctx, c.actor, { tenantId: c.tenantId, documentType: i.documentType, filename: i.filename, bytes: fromB64(i.contentBase64) }),
    }),
    cap({
      name: 'templates.drafts.save', description: 'Save a draft template version (published versions are immutable).', permissions: ['lomi.templates.write'], effect: 'consequential',
      input: s.object({ tenant, documentType: s.string(), definition: anyObject, basePdfId: s.optional(s.string()), notes: s.optional(s.string()) }),
      output: s.object({ id: s.string(), version: s.integer(), status: s.string(), definitionHash: s.string() }),
      run: async (i, c) => saveDraft(ctx, c.actor, { tenantId: c.tenantId, documentType: i.documentType, definition: i.definition as unknown as TemplateDefinition, basePdfId: i.basePdfId, notes: i.notes }),
    }),
    cap({
      name: 'templates.publish', description: 'Publish a draft template version for use with new documents.', permissions: ['lomi.templates.publish'], effect: 'consequential',
      input: s.object({ tenant, templateVersionId: s.string() }), output: s.object({ id: s.string(), version: s.integer(), status: s.string() }),
      run: async (i, c) => publishTemplate(ctx, c.actor, { tenantId: c.tenantId, templateVersionId: i.templateVersionId }),
    }),

    // ── Documents ──────────────────────────────────────────────────────────
    cap({
      name: 'documents.submit', description: 'Submit a PDF. Returns after durable acceptance; processing is asynchronous.', permissions: ['documents.submit'], effect: 'consequential', idempotent: true,
      input: s.object({ tenant, filename: s.string(), contentBase64: s.string(), documentType: s.optional(s.string()), ingress: s.optional(s.string()), title: s.optional(s.string()), idempotencyKey: s.optional(s.string()) }),
      output: submission,
      run: async (i, c) => submitDocument(ctx, c.actor, { tenantId: c.tenantId, documentTypeKey: i.documentType, filename: i.filename, bytes: fromB64(i.contentBase64), ingressKey: i.ingress, title: i.title, idempotencyKey: i.idempotencyKey }),
    }),
    cap({
      name: 'documents.versions.add', description: 'Submit a revised PDF as a new immutable version of a document.', permissions: ['documents.submit'], effect: 'consequential', idempotent: true,
      input: s.object({ tenant, documentId: s.string(), filename: s.string(), contentBase64: s.string(), ingress: s.optional(s.string()), idempotencyKey: s.optional(s.string()) }),
      output: submission,
      run: async (i, c) => addVersion(ctx, c.actor, { tenantId: c.tenantId, documentId: i.documentId, filename: i.filename, bytes: fromB64(i.contentBase64), ingressKey: i.ingress, idempotencyKey: i.idempotencyKey }),
    }),
    cap({
      name: 'documents.list', description: 'Search and filter documents with status, progress and next action.', permissions: ['documents.read'], effect: 'observation',
      input: s.object({ tenant, search: s.optional(s.string()), status: s.optional(s.string()), documentType: s.optional(s.string()), limit: s.optional(s.integer()), offset: s.optional(s.integer()) }),
      output: list,
      run: async ({ tenant: _t, ...rest }, c) => ({ items: await listDocuments(ctx, { tenantId: c.tenantId, ...rest }) }),
    }),
    cap({
      name: 'documents.get', description: 'A document version with extracted values, evidence, checks, decisions and history.', permissions: ['documents.read'], effect: 'observation',
      input: s.object({ tenant, documentId: s.string(), versionId: s.optional(s.string()) }), output: anyObject,
      run: async (i, c) => (await getDocument(ctx, { tenantId: c.tenantId, documentId: i.documentId, versionId: i.versionId })) as unknown as Record<string, unknown>,
    }),
    cap({
      name: 'documents.progress', description: 'Processing and review progress for a document.', permissions: ['documents.read'], effect: 'observation',
      input: s.object({ tenant, documentId: s.string() }), output: anyObject,
      run: async (i, c) => (await getProgress(ctx, { tenantId: c.tenantId, documentId: i.documentId })) as unknown as Record<string, unknown>,
    }),
    cap({
      name: 'documents.download', description: 'Download an original version or a generated output.', permissions: ['documents.read'], effect: 'observation',
      input: s.object({ tenant, documentId: s.string(), versionId: s.optional(s.string()), generatedDocumentId: s.optional(s.string()) }),
      output: s.object({ filename: s.string(), contentBase64: s.string() }),
      run: async (i, c) => {
        const f = i.generatedDocumentId
          ? await generatedFile(ctx, { tenantId: c.tenantId, generatedDocumentId: i.generatedDocumentId })
          : await originalFile(ctx, { tenantId: c.tenantId, documentId: i.documentId, versionId: i.versionId });
        return { filename: f.filename, contentBase64: b64(f.bytes) };
      },
    }),

    // ── Review ─────────────────────────────────────────────────────────────
    cap({
      name: 'values.review', description: 'Approve or correct one extracted value. People only; agents use values.propose.', permissions: ['reviews.decide'], effect: 'consequential',
      input: s.object({ tenant, valueId: s.string(), action: s.enum(['approve', 'correct']), value: s.optional(s.nullable(s.string())), note: s.optional(s.string()), proposalId: s.optional(s.string()) }),
      output: anyObject,
      run: async ({ tenant: _t, ...rest }, c) => (await reviewValue(ctx, c.actor, { tenantId: c.tenantId, ...rest })) as unknown as Record<string, unknown>,
    }),
    cap({
      name: 'values.propose', description: 'Propose a correction for a person to accept. Changes nothing by itself.', permissions: ['reviews.propose'], effect: 'consequential',
      input: s.object({ tenant, valueId: s.string(), value: s.nullable(s.string()), rationale: s.string() }),
      output: s.object({ proposalId: s.string(), status: s.string(), requiresHumanApproval: s.boolean() }),
      run: async ({ tenant: _t, ...rest }, c) => proposeCorrection(ctx, c.actor, { tenantId: c.tenantId, ...rest }),
    }),

    // ── Output ─────────────────────────────────────────────────────────────
    cap({
      name: 'documents.generate', description: 'Generate the output document from approved values (asynchronous, idempotent).', permissions: ['documents.generate'], effect: 'consequential',
      input: s.object({ tenant, documentId: s.string() }),
      output: s.object({ generatedDocumentId: s.string(), status: s.string(), sha256: s.nullable(s.string()), snapshotHash: s.string() }),
      run: async (i, c) => requestGeneration(ctx, c.actor, { tenantId: c.tenantId, documentId: i.documentId }),
    }),
    cap({
      name: 'documents.outputs.verify', description: 'Re-render a generated document from its recorded inputs and compare bytes.', permissions: ['documents.read'], effect: 'observation',
      input: s.object({ tenant, generatedDocumentId: s.string() }), output: anyObject,
      run: async (i, c) => (await verifyGenerated(ctx, { tenantId: c.tenantId, generatedDocumentId: i.generatedDocumentId })) as unknown as Record<string, unknown>,
    }),
    cap({
      name: 'documents.provenance', description: 'Submissions, template and model versions, decisions and outputs for a document.', permissions: ['provenance.read'], effect: 'observation',
      input: s.object({ tenant, documentId: s.string(), includeRawModelIo: s.optional(s.boolean()) }), output: anyObject,
      run: async (i, c) => {
        // Raw prompts and model responses contain document content; Lomi operators only.
        if (i.includeRawModelIo) requireOperator(c);
        return (await provenance(ctx, { tenantId: c.tenantId, documentId: i.documentId, includeRawModelIo: Boolean(i.includeRawModelIo) })) as unknown as Record<string, unknown>;
      },
    }),

    // ── Operations ─────────────────────────────────────────────────────────
    cap({
      name: 'operations.stats', description: 'Operational metrics derived from persisted records. Without a tenant: all tenants (Lomi operators).', permissions: ['session.read'], effect: 'observation',
      input: s.object({ tenant: s.optional(tenant) }), output: anyObject,
      run: async (i, c) => {
        if (!i.tenant) requireOperator(c);
        else if (!c.claims.operator && !(membershipFor(c.claims, i.tenant)?.permissions ?? []).includes('operations.read')) throw errors.forbidden('Missing permission: operations.read');
        return (await operationalStats(ctx, { tenantId: c.tenantId || undefined })) as unknown as Record<string, unknown>;
      },
    }),
    cap({
      name: 'operations.failures', description: 'Failed or retrying jobs with reasons and recovery actions.', permissions: ['session.read'], effect: 'observation',
      input: s.object({ tenant: s.optional(tenant) }), output: list,
      run: async (i, c) => {
        if (!i.tenant) requireOperator(c);
        else if (!c.claims.operator && !(membershipFor(c.claims, i.tenant)?.permissions ?? []).includes('operations.read')) throw errors.forbidden('Missing permission: operations.read');
        return { items: await listFailures(ctx, { tenantId: c.tenantId || undefined }) };
      },
    }),
    cap({
      name: 'operations.retry', description: 'Retry a failed job once its cause is resolved.', permissions: ['operations.retry'], effect: 'consequential',
      input: s.object({ tenant, jobId: s.string() }), output: s.object({ jobId: s.string(), status: s.string() }),
      run: async (i, c) => retryJob(ctx, c.actor, { tenantId: c.tenantId, jobId: i.jobId }),
    }),
    cap({
      name: 'operations.providers', description: 'Model provider readiness as reported by workers.', permissions: ['lomi.operations.read'], effect: 'observation',
      input: s.object({}), output: list, run: async () => ({ items: await providerReadiness(ctx) }),
    }),
  ];

  return createApplication({
    application: { id: APPLICATION_ID, name: 'Lomi Document Operations', version: '0.1.0' },
    capabilities,
    authorizer,
    mode: process.env.NODE_ENV === 'production' ? 'production' : 'development',
  });
}
