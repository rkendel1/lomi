/**
 * Ordered, append-only migrations. Applied in a transaction each, recorded in
 * `schema_migrations`. Never edit a migration that has shipped; add a new one.
 *
 * Tenant isolation is enforced twice: every query is written with an explicit
 * tenant filter, and PostgreSQL row-level security (FORCE'd, so the table owner
 * is bound too) rejects rows from any tenant other than `app.tenant_id`.
 * The application runs its queries as the non-superuser role `lomi_app`
 * (superusers bypass RLS).
 */

const TENANT_TABLES = [
  'document_types',
  'stored_objects',
  'base_pdfs',
  'template_versions',
  'ingress_endpoints',
  'documents',
  'document_versions',
  'submissions',
  'document_relations',
  'jobs',
  'job_attempts',
  'outbox',
  'extracted_values',
  'evidence',
  'validation_results',
  'review_decisions',
  'review_proposals',
  'model_calls',
  'generated_documents',
];

const rls = TENANT_TABLES.map(
  (t) => `
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ${t}
  USING (app_bypass_rls() OR tenant_id = app_tenant_id())
  WITH CHECK (app_bypass_rls() OR tenant_id = app_tenant_id());`
).join('\n');

export const MIGRATIONS: Array<{ id: string; sql: string }> = [
  {
    id: '001_document_operations',
    sql: `
CREATE OR REPLACE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
CREATE OR REPLACE FUNCTION app_bypass_rls() RETURNS boolean LANGUAGE sql STABLE AS
  $$ SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on' $$;

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

-- ── Identity and tenancy (not tenant-scoped) ────────────────────────────────
CREATE TABLE tenants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('user', 'agent', 'service')),
  display_name text NOT NULL,
  email text UNIQUE,
  is_lomi_operator boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE memberships (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  principal_id uuid NOT NULL REFERENCES principals(id),
  role text NOT NULL CHECK (role IN ('customer_admin', 'reviewer', 'viewer', 'submitter', 'agent')),
  -- Agents act on behalf of a human; their permissions are the delegated scopes.
  delegated_by uuid REFERENCES principals(id),
  scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id),
  CHECK (role <> 'agent' OR delegated_by IS NOT NULL)
);

CREATE TABLE api_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  principal_id uuid NOT NULL REFERENCES principals(id),
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  revoked_at timestamptz
);

-- ── Configuration ───────────────────────────────────────────────────────────
CREATE TABLE document_types (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL CHECK (key ~ '^[a-z0-9_.-]+$'),
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key),
  UNIQUE (tenant_id, id)
);

-- Content-addressed blobs (originals, base PDFs, generated outputs).
CREATE TABLE stored_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes bigint NOT NULL,
  content_type text NOT NULL,
  storage_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sha256)
);
CREATE TRIGGER stored_objects_immutable BEFORE UPDATE ON stored_objects FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE base_pdfs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_type_id uuid NOT NULL REFERENCES document_types(id),
  version integer NOT NULL,
  object_id uuid NOT NULL REFERENCES stored_objects(id),
  sha256 text NOT NULL,
  filename text NOT NULL,
  page_count integer NOT NULL,
  created_by uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_type_id, version),
  UNIQUE (document_type_id, sha256)
);
CREATE TRIGGER base_pdfs_immutable BEFORE UPDATE OR DELETE ON base_pdfs FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE template_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_type_id uuid NOT NULL REFERENCES document_types(id),
  version integer NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'retired')),
  definition jsonb NOT NULL,
  definition_hash text NOT NULL,
  base_pdf_id uuid REFERENCES base_pdfs(id),
  notes text,
  created_by uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  published_by uuid REFERENCES principals(id),
  published_at timestamptz,
  UNIQUE (document_type_id, version),
  CHECK (status = 'draft' OR published_at IS NOT NULL)
);
CREATE INDEX template_versions_published ON template_versions (document_type_id, version DESC) WHERE status = 'published';

-- Published template versions are immutable: only draft→published and published→retired transitions are allowed.
CREATE OR REPLACE FUNCTION template_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'draft' THEN RAISE EXCEPTION 'published template versions cannot be deleted'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status <> 'draft' THEN
    IF NEW.definition IS DISTINCT FROM OLD.definition OR NEW.base_pdf_id IS DISTINCT FROM OLD.base_pdf_id
       OR NEW.definition_hash IS DISTINCT FROM OLD.definition_hash OR NEW.version IS DISTINCT FROM OLD.version THEN
      RAISE EXCEPTION 'template version % is % and immutable; create a new version', OLD.version, OLD.status;
    END IF;
    IF NOT (OLD.status = 'published' AND NEW.status IN ('published', 'retired')) AND NOT (OLD.status = NEW.status) THEN
      RAISE EXCEPTION 'invalid template status transition % -> %', OLD.status, NEW.status;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER template_versions_guard BEFORE UPDATE OR DELETE ON template_versions FOR EACH ROW EXECUTE FUNCTION template_versions_guard();

CREATE TABLE ingress_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  key text NOT NULL CHECK (key ~ '^[a-z0-9_.-]+$'),
  kind text NOT NULL CHECK (kind IN ('portal', 'api', 'email', 'sftp')),
  name text NOT NULL,
  default_document_type_id uuid REFERENCES document_types(id),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, key)
);

-- ── Documents ───────────────────────────────────────────────────────────────
CREATE TABLE documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_type_id uuid NOT NULL REFERENCES document_types(id),
  title text NOT NULL,
  current_version_id uuid,
  business_key text,
  created_by uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_tenant_created ON documents (tenant_id, created_at DESC);
CREATE INDEX documents_business_key ON documents (tenant_id, document_type_id, business_key) WHERE business_key IS NOT NULL;

CREATE TABLE document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  version integer NOT NULL,
  object_id uuid NOT NULL REFERENCES stored_objects(id),
  sha256 text NOT NULL,
  filename text NOT NULL,
  size_bytes bigint NOT NULL,
  processing_status text NOT NULL DEFAULT 'received' CHECK (processing_status IN
    ('received', 'queued', 'parsing', 'extracting', 'validating', 'processed', 'superseded', 'failed_retryable', 'failed_operator')),
  failure_reason text,
  failure_action text,
  template_version_id uuid REFERENCES template_versions(id),
  baseline_version_id uuid REFERENCES document_versions(id),
  parsed_text jsonb,
  parser text,
  -- Which model providers were selected for this version and why (including any configured fallback).
  model_selection jsonb,
  page_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (document_id, version)
);
CREATE INDEX document_versions_status ON document_versions (tenant_id, processing_status);
ALTER TABLE documents ADD CONSTRAINT documents_current_version FOREIGN KEY (current_version_id) REFERENCES document_versions(id);

-- Every receipt of a file, including exact duplicates that create nothing new.
CREATE TABLE submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  ingress_id uuid REFERENCES ingress_endpoints(id),
  submitted_by uuid REFERENCES principals(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  sha256 text NOT NULL,
  filename text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('new_document', 'new_version', 'duplicate_exact')),
  idempotency_key text,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);
CREATE INDEX submissions_sha ON submissions (tenant_id, sha256);
CREATE TRIGGER submissions_append_only BEFORE UPDATE OR DELETE ON submissions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Relationships between documents that are not merged (e.g. same transaction, different file).
CREATE TABLE document_relations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  related_document_id uuid NOT NULL REFERENCES documents(id),
  kind text NOT NULL CHECK (kind IN ('possible_same_transaction')),
  reason text NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, related_document_id, kind)
);

-- ── Durable work ────────────────────────────────────────────────────────────
CREATE TABLE jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  kind text NOT NULL CHECK (kind IN ('process_version', 'generate_output')),
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'retry_wait', 'failed', 'superseded')),
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  lease_owner text,
  lease_expires_at timestamptz,
  available_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX jobs_open ON jobs (status, available_at) WHERE status IN ('queued', 'running', 'retry_wait');
CREATE INDEX jobs_subject ON jobs (subject_id);

CREATE TABLE job_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  job_id uuid NOT NULL REFERENCES jobs(id),
  attempt integer NOT NULL,
  worker_id text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  outcome text CHECK (outcome IN ('succeeded', 'failed', 'abandoned', 'superseded')),
  error text,
  UNIQUE (job_id, attempt)
);

-- Transactional outbox: written in the same transaction as the domain change.
CREATE TABLE outbox (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  topic text NOT NULL,
  job_id uuid NOT NULL REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  available_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  publish_count integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX outbox_pending ON outbox (available_at) WHERE published_at IS NULL;

-- ── Extraction, evidence, validation, review ────────────────────────────────
CREATE TABLE extracted_values (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  semantic_key text NOT NULL,
  label text NOT NULL,
  field_type text NOT NULL,
  required boolean NOT NULL DEFAULT false,
  method text NOT NULL CHECK (method IN ('pattern', 'llm')),
  value text,
  normalized_value text,
  gap_reason text,
  unverified jsonb,
  confidence numeric,
  confidence_source text NOT NULL,
  confidence_threshold numeric,
  model text,
  prompt_version text,
  interpretation_hash text NOT NULL,
  evidence_fingerprint text,
  disposition text NOT NULL CHECK (disposition IN ('gap', 'needs_review', 'auto_approved')),
  review_state text NOT NULL CHECK (review_state IN ('pending', 'approved', 'corrected', 'carried_over')),
  final_value text,
  carried_from_value_id uuid REFERENCES extracted_values(id),
  previous_value_id uuid REFERENCES extracted_values(id),
  change_reasons jsonb,
  job_id uuid REFERENCES jobs(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_version_id, semantic_key)
);
CREATE INDEX extracted_values_review ON extracted_values (tenant_id, review_state);

CREATE TABLE evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  value_id uuid NOT NULL UNIQUE REFERENCES extracted_values(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  page integer NOT NULL,
  quote text NOT NULL,
  start_offset integer NOT NULL,
  end_offset integer NOT NULL,
  box jsonb,
  verified_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER evidence_append_only BEFORE UPDATE OR DELETE ON evidence FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE validation_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  value_id uuid NOT NULL REFERENCES extracted_values(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  rule_id text NOT NULL,
  method text NOT NULL CHECK (method IN ('deterministic', 'semantic')),
  rule_version text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('pass', 'fail', 'uncertain', 'skipped', 'error')),
  explanation text NOT NULL,
  model text,
  prompt_version text,
  confidence numeric,
  confidence_source text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX validation_results_value ON validation_results (value_id);
CREATE TRIGGER validation_results_append_only BEFORE UPDATE OR DELETE ON validation_results FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Every decision about a value, human or policy. Append-only: history is never rewritten.
CREATE TABLE review_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  value_id uuid NOT NULL REFERENCES extracted_values(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  action text NOT NULL CHECK (action IN ('approve', 'correct', 'carry_over', 'auto_approve')),
  old_value text,
  new_value text,
  note text,
  actor_principal_id uuid REFERENCES principals(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user', 'agent', 'service', 'system')),
  authority jsonb NOT NULL,
  evidence_snapshot jsonb,
  carried_from_decision_id uuid REFERENCES review_decisions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX review_decisions_value ON review_decisions (value_id, created_at);
CREATE TRIGGER review_decisions_append_only BEFORE UPDATE OR DELETE ON review_decisions FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Agents propose; humans decide.
CREATE TABLE review_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  value_id uuid NOT NULL REFERENCES extracted_values(id),
  proposed_value text,
  rationale text NOT NULL,
  proposed_by uuid NOT NULL REFERENCES principals(id),
  on_behalf_of uuid REFERENCES principals(id),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'dismissed')),
  resolved_decision_id uuid REFERENCES review_decisions(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  job_id uuid REFERENCES jobs(id),
  purpose text NOT NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_version text NOT NULL,
  prompt text NOT NULL,
  raw_response text NOT NULL,
  error text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ── Generated documents ─────────────────────────────────────────────────────
CREATE TABLE generated_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  document_version_id uuid NOT NULL REFERENCES document_versions(id),
  template_version_id uuid NOT NULL REFERENCES template_versions(id),
  base_pdf_id uuid NOT NULL REFERENCES base_pdfs(id),
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  renderer_version text NOT NULL,
  config jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  output_object_id uuid REFERENCES stored_objects(id),
  output_sha256 text,
  error text,
  job_id uuid REFERENCES jobs(id),
  requested_by uuid REFERENCES principals(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE (document_version_id, snapshot_hash, renderer_version)
);

-- Workers report provider readiness here so the API can show it without loading models itself.
CREATE TABLE provider_readiness (
  worker_id text NOT NULL,
  role text NOT NULL,
  provider text NOT NULL,
  ready boolean NOT NULL,
  detail text NOT NULL,
  model text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (worker_id, role, provider)
);

-- ── Provenance ──────────────────────────────────────────────────────────────
CREATE TABLE audit_events (
  id bigserial PRIMARY KEY,
  tenant_id uuid REFERENCES tenants(id),
  actor_principal_id uuid REFERENCES principals(id),
  actor_kind text NOT NULL,
  on_behalf_of uuid REFERENCES principals(id),
  capability text,
  action text NOT NULL,
  subject_type text NOT NULL,
  subject_id uuid,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_subject ON audit_events (subject_id, created_at);
CREATE INDEX audit_events_tenant ON audit_events (tenant_id, created_at DESC);
CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON audit_events
  USING (app_bypass_rls() OR tenant_id = app_tenant_id())
  WITH CHECK (app_bypass_rls() OR tenant_id = app_tenant_id());

${rls}

-- The role application queries run as. NOLOGIN: the connecting user SETs ROLE to it.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lomi_app') THEN
    CREATE ROLE lomi_app NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO lomi_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO lomi_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO lomi_app;
REVOKE UPDATE, DELETE ON schema_migrations FROM lomi_app;
`,
  },
];
