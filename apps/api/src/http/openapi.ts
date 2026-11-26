/**
 * OpenAPI 3.1 description of Lomi's HTTP API. Served at GET /api/openapi.json and
 * rendered at GET /api/docs. Every REST route is a thin adapter over an AppPort
 * capability; the capability contract (all 30+ operations, including those with
 * no REST route) is also published as an AppPort manifest at GET /api/appport/manifest.
 */

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, description = 'OK') => ({ description, content: { 'application/json': { schema } } });
const errors = {
  '400': json(ref('Error'), 'Invalid input (e.g. not a PDF, unknown document type)'),
  '401': json(ref('Error'), 'Missing or invalid bearer token'),
  '403': json(ref('Error'), 'Authenticated but not permitted (e.g. agents cannot approve; customers cannot call Lomi-only operations)'),
  '404': json(ref('Error'), 'Not found — also returned for tenants the caller does not belong to'),
};
const tenantHeader = { $ref: '#/components/parameters/Tenant' };
const idParam = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: { type: 'string', format: 'uuid' } });

export function openApiDocument() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Lomi Document Operations API',
      version: '0.2.0',
      description: [
        'Submit documents, follow their processing, review extracted values with verified evidence, and generate output documents.',
        '',
        '**Authentication**: `Authorization: Bearer <token>`. Tokens belong to a person, an integration or an agent and carry a role per customer (tenant).',
        '',
        '**Tenant**: the tenant ingress URL names the tenant in the path (`/api/in/{tenant}/documents`). Other endpoints take the `X-Lomi-Tenant` header (slug or id), or use the caller\'s only tenant.',
        '',
        '**Processing** is asynchronous but starts immediately: a submission returns `202 Accepted` once the file and the processing job are durably stored, and the worker picks it up straight away. Poll `GET /api/documents/{id}/progress`.',
        '',
        '**Same operations, other protocols**: every endpoint here dispatches an AppPort capability. The full capability set is available at `POST /api/appport` (AppPort envelopes) and to agents over MCP at `POST /api/mcp`, with identical authorization.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'This deployment' }],
    security: [{ bearer: [] }],
    tags: [
      { name: 'Ingress', description: "Each customer's single submission URL: electronic (API), single-file and bulk uploads." },
      { name: 'Documents', description: 'Documents, versions, progress and files.' },
      { name: 'Review', description: 'Human review of extracted values.' },
      { name: 'Outputs', description: 'Documents generated from approved values.' },
      { name: 'Capabilities', description: 'AppPort and MCP access to the full capability set.' },
      { name: 'System', description: 'Health, identity and documentation.' },
    ],
    paths: {
      '/api/in/{tenant}/documents': {
        post: {
          tags: ['Ingress'],
          operationId: 'submitToTenant',
          summary: "Submit documents to a customer's ingress URL",
          description: [
            'One URL per customer accepts three kinds of submission:',
            '- **Electronic (API)**: the raw PDF as `application/pdf` (`?filename=` recommended) or JSON `{filename, contentBase64}` → `202` with a Submission.',
            '- **Single upload**: `multipart/form-data` with one `file` part → `202` with a Submission.',
            '- **Bulk upload**: `multipart/form-data` with several `file` parts, or JSON `{documents: [...]}` → `202` with a BatchResult (each file accepted or rejected on its own).',
            '',
            'Identical bytes already received by this customer are recorded as a duplicate receipt and return `200` without reprocessing. The caller needs the `submitter` (or reviewer/admin) role for the tenant.',
          ].join('\n'),
          parameters: [
            { name: 'tenant', in: 'path', required: true, description: 'Tenant slug, e.g. `lakeside`', schema: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,62}$' } },
            { name: 'documentType', in: 'query', required: false, description: "Document type key (e.g. `invoice`). Defaults to the ingress's default type.", schema: { type: 'string' } },
            { name: 'filename', in: 'query', required: false, description: 'File name for `application/pdf` bodies.', schema: { type: 'string' } },
            { name: 'Idempotency-Key', in: 'header', required: false, description: 'Replays return the original submission (single submissions).', schema: { type: 'string' } },
          ],
          requestBody: {
            required: true,
            content: {
              'application/pdf': { schema: { type: 'string', format: 'binary' } },
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  properties: {
                    file: { type: 'array', items: { type: 'string', format: 'binary' }, description: 'One part per PDF (field name `file`).' },
                    documentType: { type: 'string' },
                  },
                  required: ['file'],
                },
              },
              'application/json': {
                schema: {
                  oneOf: [
                    ref('DocumentUpload'),
                    { type: 'object', required: ['documents'], properties: { documentType: { type: 'string' }, documents: { type: 'array', maxItems: 100, items: ref('DocumentUpload') } } },
                  ],
                },
              },
            },
          },
          responses: {
            '202': { description: 'Accepted (single submission or batch)', content: { 'application/json': { schema: { oneOf: [ref('Submission'), ref('BatchResult')] } } } },
            '200': json(ref('Submission'), 'Exact duplicate of a document already received'),
            '413': json(ref('Error'), 'File larger than 20 MB or more than 100 files'),
            '415': json(ref('Error'), 'Unsupported content type'),
            ...errors,
          },
        },
      },
      '/api/documents': {
        get: {
          tags: ['Documents'],
          operationId: 'listDocuments',
          summary: 'List and search documents',
          parameters: [
            tenantHeader,
            { name: 'search', in: 'query', schema: { type: 'string' }, description: 'Matches title, file name or business key (e.g. invoice number).' },
            { name: 'status', in: 'query', schema: ref('Status') },
            { name: 'documentType', in: 'query', schema: { type: 'string' } },
          ],
          responses: { '200': json({ type: 'object', properties: { items: { type: 'array', items: ref('DocumentSummary') } } }), ...errors },
        },
        post: {
          tags: ['Documents'],
          operationId: 'submitDocument',
          summary: 'Submit one PDF (tenant from header)',
          description: 'Equivalent to an electronic submission to the tenant ingress URL. Prefer `/api/in/{tenant}/documents` for integrations.',
          parameters: [tenantHeader, { name: 'documentType', in: 'query', schema: { type: 'string' } }, { name: 'filename', in: 'query', schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } }, 'application/json': { schema: ref('DocumentUpload') } } },
          responses: { '202': json(ref('Submission'), 'Accepted; processing has started'), '200': json(ref('Submission'), 'Exact duplicate'), ...errors },
        },
      },
      '/api/documents/{id}': {
        get: {
          tags: ['Documents'],
          operationId: 'getDocument',
          summary: 'Current version (or ?versionId=) with values, evidence, checks, decisions and history',
          parameters: [tenantHeader, idParam('id', 'Document id'), { name: 'versionId', in: 'query', schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': json(ref('DocumentDetail')), ...errors },
        },
      },
      '/api/documents/{id}/versions': {
        post: {
          tags: ['Documents'],
          operationId: 'addVersion',
          summary: 'Submit a revised version',
          description: 'A revision is a new immutable version. Unchanged evidence keeps its review (carried over); changed evidence reopens review. If an earlier version is still processing, the latest version wins and the earlier one is marked superseded.',
          parameters: [tenantHeader, idParam('id', 'Document id'), { name: 'filename', in: 'query', schema: { type: 'string' } }],
          requestBody: { required: true, content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } }, 'application/json': { schema: ref('DocumentUpload') } } },
          responses: { '202': json(ref('Submission')), '200': json(ref('Submission'), 'Exact duplicate'), ...errors },
        },
      },
      '/api/documents/{id}/progress': {
        get: {
          tags: ['Documents'],
          operationId: 'getProgress',
          summary: 'Processing and review progress',
          parameters: [tenantHeader, idParam('id', 'Document id')],
          responses: { '200': json(ref('ProgressResponse')), ...errors },
        },
      },
      '/api/documents/{id}/file': {
        get: {
          tags: ['Documents', 'Outputs'],
          operationId: 'downloadFile',
          summary: 'Download the original (current or ?versionId=) or a generated output (?output=)',
          parameters: [tenantHeader, idParam('id', 'Document id'), { name: 'versionId', in: 'query', schema: { type: 'string', format: 'uuid' } }, { name: 'output', in: 'query', schema: { type: 'string', format: 'uuid' } }],
          responses: { '200': { description: 'The PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, ...errors },
        },
      },
      '/api/documents/{id}/generate': {
        post: {
          tags: ['Outputs'],
          operationId: 'generateOutput',
          summary: 'Generate the output document from approved values',
          description: 'Requires every value of the current version to be decided. Idempotent per snapshot of approved values; the output is reproducible from its recorded inputs.',
          parameters: [tenantHeader, idParam('id', 'Document id')],
          responses: {
            '202': json({ type: 'object', properties: { generatedDocumentId: { type: 'string' }, status: { type: 'string' }, sha256: { type: ['string', 'null'] }, snapshotHash: { type: 'string' } } }),
            '409': json(ref('Error'), 'Fields still need review'),
            ...errors,
          },
        },
      },
      '/api/values/{id}/review': {
        post: {
          tags: ['Review'],
          operationId: 'reviewValue',
          summary: 'Approve or correct one value (people only)',
          description: 'Every decision is appended to the value\'s history with actor, time, old/new value, evidence shown and note. Agents cannot decide; they use the `values.propose` capability.',
          parameters: [tenantHeader, idParam('id', 'Value id')],
          requestBody: { required: true, content: { 'application/json': { schema: ref('ReviewRequest') } } },
          responses: { '200': json(ref('ReviewResult')), '409': json(ref('Error'), 'Value belongs to an older version, or a required value is missing'), ...errors },
        },
      },
      '/api/templates/basepdfs/{id}/file': {
        get: {
          tags: ['Documents'],
          operationId: 'downloadBasePdf',
          summary: "Download a template's immutable base PDF",
          parameters: [tenantHeader, idParam('id', 'Base PDF id')],
          responses: { '200': { description: 'The PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, ...errors },
        },
      },
      '/api/appport': {
        post: {
          tags: ['Capabilities'],
          operationId: 'appportRequest',
          summary: 'Invoke any capability with an AppPort request envelope',
          description: 'E.g. `{"protocol":"appport/1","type":"request","requestId":"…","capability":{"name":"documents.next","version":1},"input":{"tenant":"lakeside"}}`. See the manifest for every capability, its input/output schema and required permissions.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['protocol', 'type', 'requestId', 'capability', 'input'] } } } },
          responses: { '200': json({ type: 'object', description: 'AppPort response envelope (`ok`, `output` or `error`)' }) },
        },
      },
      '/api/appport/manifest': {
        get: { tags: ['Capabilities'], operationId: 'appportManifest', summary: 'AppPort manifest: every capability with schemas and permissions', security: [], responses: { '200': json({ type: 'object' }) } },
      },
      '/.well-known/appport': {
        get: { tags: ['Capabilities'], operationId: 'appportDiscovery', summary: 'AppPort discovery document', security: [], responses: { '200': json({ type: 'object' }) } },
      },
      '/api/mcp': {
        post: {
          tags: ['Capabilities'],
          operationId: 'mcp',
          summary: 'Model Context Protocol (Streamable HTTP, stateless)',
          description: 'Tools are projected from the AppPort manifest (`documents.get` → `documents_get`). Send the bearer token of the agent; calls are authorized and audited like any other.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'JSON-RPC 2.0 request' } } } },
          responses: { '200': json({ type: 'object', description: 'JSON-RPC 2.0 response' }) },
        },
      },
      '/api/me': {
        get: { tags: ['System'], operationId: 'me', summary: 'The authenticated identity and its tenant roles', responses: { '200': json(ref('Me')), '401': errors['401'] } },
      },
      '/api/health': {
        get: { tags: ['System'], operationId: 'health', summary: 'Liveness', security: [], responses: { '200': json({ type: 'object', properties: { status: { type: 'string' } } }) } },
      },
      '/api/render': {
        post: {
          tags: ['System'],
          operationId: 'renderPdf',
          summary: 'Stateless render of a template + data (coordtool renderer)',
          security: [],
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['template', 'layout', 'mapping', 'transforms', 'data'] } } } },
          responses: { '200': { description: 'Rendered PDF', content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } } }, '400': errors['400'] },
        },
      },
      '/api/openapi.json': { get: { tags: ['System'], operationId: 'openapi', summary: 'This document', security: [], responses: { '200': json({ type: 'object' }) } } },
      '/api/docs': { get: { tags: ['System'], operationId: 'docs', summary: 'Rendered API reference', security: [], responses: { '200': { description: 'HTML', content: { 'text/html': { schema: { type: 'string' } } } } } } },
    },
    components: {
      securitySchemes: { bearer: { type: 'http', scheme: 'bearer', description: 'API token issued to a person, integration or agent.' } },
      parameters: {
        Tenant: { name: 'X-Lomi-Tenant', in: 'header', required: false, description: "Tenant slug or id. Optional when the caller belongs to exactly one tenant.", schema: { type: 'string' } },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { oneOf: [{ type: 'string' }, { type: 'object', properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} } }] } },
        },
        DocumentUpload: {
          type: 'object',
          required: ['filename', 'contentBase64'],
          properties: { filename: { type: 'string' }, contentBase64: { type: 'string', contentEncoding: 'base64' }, documentType: { type: 'string' }, title: { type: 'string' } },
        },
        Status: {
          type: 'string',
          enum: ['received', 'queued', 'parsing', 'extracting', 'validating', 'awaiting_review', 'partially_reviewed', 'approved', 'completed', 'failed_retryable', 'failed_operator', 'superseded'],
        },
        Submission: {
          type: 'object',
          properties: {
            submissionId: { type: 'string', format: 'uuid' },
            documentId: { type: 'string', format: 'uuid' },
            versionId: { type: 'string', format: 'uuid' },
            version: { type: 'integer' },
            outcome: { type: 'string', enum: ['new_document', 'new_version', 'duplicate_exact'] },
            status: ref('Status'),
            duplicateOf: { type: 'object', properties: { documentId: { type: 'string' }, versionId: { type: 'string' }, version: { type: 'integer' } } },
          },
        },
        BatchResult: {
          type: 'object',
          properties: {
            batchId: { type: 'string', format: 'uuid' },
            accepted: { type: 'integer' },
            rejected: { type: 'integer' },
            results: { type: 'array', items: { type: 'object', properties: { filename: { type: 'string' }, ok: { type: 'boolean' }, error: { type: 'string' }, documentId: { type: 'string' }, outcome: { type: 'string' } } } },
          },
        },
        Progress: {
          type: 'object',
          properties: {
            total: { type: 'integer' }, pending: { type: 'integer' }, gaps: { type: 'integer' }, approved: { type: 'integer' },
            autoApproved: { type: 'integer' }, corrected: { type: 'integer' }, carriedOver: { type: 'integer' }, failedChecks: { type: 'integer' },
          },
        },
        ProgressResponse: {
          type: 'object',
          properties: {
            documentId: { type: 'string' }, version: { type: 'integer' }, status: ref('Status'), statusLabel: { type: 'string' },
            nextAction: { type: 'string' }, failureReason: { type: ['string', 'null'] }, progress: ref('Progress'),
          },
        },
        DocumentSummary: {
          type: 'object',
          properties: {
            id: { type: 'string' }, title: { type: 'string' },
            documentType: { type: 'object', properties: { key: { type: 'string' }, name: { type: 'string' } } },
            currentVersion: { type: 'object', properties: { id: { type: 'string' }, number: { type: 'integer' } } },
            submittedAt: { type: 'string', format: 'date-time' }, status: ref('Status'), statusLabel: { type: 'string' },
            nextAction: { type: 'string' }, failureReason: { type: ['string', 'null'] }, warning: { type: ['string', 'null'] },
            progress: { oneOf: [ref('Progress'), { type: 'null' }] }, relatedDocuments: { type: 'integer' },
          },
        },
        Value: {
          type: 'object',
          description: 'One extracted field on one document version.',
          properties: {
            id: { type: 'string' }, semanticKey: { type: 'string' }, label: { type: 'string' }, required: { type: 'boolean' },
            value: { type: ['string', 'null'], description: 'As written in the document' },
            normalizedValue: { type: ['string', 'null'], description: 'Canonical form (ISO dates, plain decimals)' },
            finalValue: { type: ['string', 'null'], description: 'Value after review/correction/carry-over' },
            state: { type: 'string', enum: ['pending', 'gap', 'approved', 'auto_approved', 'corrected', 'carried_over'] },
            needsAttention: { type: 'boolean' }, attentionReason: { type: ['string', 'null'] },
            evidence: { type: ['object', 'null'], description: 'Verified verbatim quote', properties: { page: { type: 'integer' }, quote: { type: 'string' }, box: { type: ['object', 'null'] } } },
            previous: { type: ['object', 'null'], description: 'The previous version\'s value, evidence and decision, with why review reopened' },
            checks: { type: 'array', items: { type: 'object', properties: { ruleId: { type: 'string' }, method: { type: 'string', enum: ['deterministic', 'semantic'] }, outcome: { type: 'string', enum: ['pass', 'fail', 'uncertain', 'skipped', 'error'] }, explanation: { type: 'string' } } } },
            decisions: { type: 'array', items: { type: 'object' } },
            proposals: { type: 'array', items: { type: 'object' } },
          },
        },
        DocumentDetail: {
          allOf: [
            ref('DocumentSummary'),
            {
              type: 'object',
              properties: {
                viewing: { type: 'object' }, versions: { type: 'array', items: { type: 'object' } }, values: { type: 'array', items: ref('Value') },
                generated: { type: 'array', items: { type: 'object' } }, related: { type: 'array', items: { type: 'object' } }, history: { type: 'array', items: { type: 'object' } },
              },
            },
          ],
        },
        ReviewRequest: {
          type: 'object',
          required: ['action'],
          properties: {
            action: { type: 'string', enum: ['approve', 'correct'] },
            value: { type: ['string', 'null'], description: 'Required for `correct` (validated against the field type)' },
            note: { type: 'string' },
            proposalId: { type: 'string', description: "Accept an agent's proposal" },
          },
        },
        ReviewResult: {
          type: 'object',
          properties: { valueId: { type: 'string' }, decisionId: { type: 'string' }, state: { type: 'string' }, oldValue: { type: ['string', 'null'] }, newValue: { type: ['string', 'null'] }, progress: ref('Progress') },
        },
        Me: {
          type: 'object',
          properties: {
            id: { type: 'string' }, name: { type: 'string' }, kind: { type: 'string' }, operator: { type: 'boolean' },
            memberships: { type: 'array', items: { type: 'object', properties: { tenantId: { type: 'string' }, slug: { type: 'string' }, role: { type: 'string' }, permissions: { type: 'array', items: { type: 'string' } } } } },
          },
        },
      },
    },
  };
}

export const API_DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Lomi API reference</title>
  <style>body { margin: 0; }</style>
</head>
<body>
  <redoc spec-url="/api/openapi.json"></redoc>
  <script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"></script>
</body>
</html>`;
