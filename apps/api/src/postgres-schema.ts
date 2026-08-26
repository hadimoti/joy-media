/** Idempotent PostgreSQL schema for the durable metadata and job queue. */
export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id text primary key, owner_id text not null, title text not null, revision integer not null);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS asset_sync_enabled boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS project_documents (
  project_id text primary key,
  revision integer NOT NULL DEFAULT 0,
  document jsonb NOT NULL,
  document_hash text NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS project_revisions (
  project_id text NOT NULL,
  revision integer NOT NULL,
  base_revision integer NOT NULL,
  idempotency_key text NOT NULL,
  operation jsonb NOT NULL,
  document jsonb NOT NULL,
  document_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, revision),
  UNIQUE (project_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS project_revisions_project_idx ON project_revisions (project_id, revision DESC);
CREATE TABLE IF NOT EXISTS project_recovery_copies (
  source_project_id text NOT NULL,
  idempotency_key text NOT NULL,
  request_fingerprint text NOT NULL,
  recovered_project_id text NOT NULL UNIQUE,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (source_project_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS project_recovery_copies_recovered_idx ON project_recovery_copies (recovered_project_id);
CREATE TABLE IF NOT EXISTS workers (id text primary key, owner_id text not null, revoked_at timestamptz);
ALTER TABLE workers ADD COLUMN IF NOT EXISTS session_token_hash text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS session_expires_at timestamptz;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]';
ALTER TABLE workers ADD COLUMN IF NOT EXISTS local_asset_ids jsonb NOT NULL DEFAULT '[]';
ALTER TABLE workers ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;
CREATE TABLE IF NOT EXISTS jobs (id text primary key, project_id text not null, type text not null, state text not null, lease_owner text, lease_expires_at timestamptz);
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS progress integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS cancel_requested boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_kind text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_sha256 text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_bytes integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_ref text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_worker_ref text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_verified_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS asset_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_payload jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS job_requirements jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS max_attempts integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_receipt jsonb;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_asset_id text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_local_ref text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_mime_type text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_width integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS result_height integer;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS error text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS asset_revoked boolean NOT NULL DEFAULT false;
CREATE TABLE IF NOT EXISTS job_attempts (id bigserial primary key, job_id text not null, worker_id text not null, started_at timestamptz not null, completed_at timestamptz);
CREATE TABLE IF NOT EXISTS job_events (cursor bigserial primary key, job_id text not null, type text not null, created_at timestamptz not null);
CREATE TABLE IF NOT EXISTS worker_pairing_offers (worker_id text primary key, pairing_code_hash text not null, owner_id text, expires_at timestamptz not null);
CREATE TABLE IF NOT EXISTS media_assets (id text primary key, project_id text not null, kind text not null, display_name text not null, sha256 text not null, byte_length bigint not null, descriptor jsonb not null, locations jsonb not null, created_at timestamptz not null);
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS tags jsonb NOT NULL DEFAULT '[]';
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS sort_name text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS media_derivatives (id text primary key, project_id text not null, asset_id text not null, kind text not null, profile text not null, sha256 text not null, byte_length bigint not null, descriptor jsonb not null, availability text not null, locations jsonb not null, verified_at timestamptz not null);
CREATE TABLE IF NOT EXISTS render_artifacts (id text primary key, project_id text not null, job_id text not null unique, output_ref text not null, sha256 text not null, byte_length bigint not null, descriptor jsonb not null, location jsonb not null, verified_at timestamptz not null);
-- Asset deletion is a revocation event, not metadata-only deletion. These
-- tables retain only immutable metadata and opaque object references; they
-- never contain media bytes, paths, URLs, or credentials.
CREATE TABLE IF NOT EXISTS asset_object_references (
  id bigserial primary key,
  project_id text NOT NULL,
  asset_id text NOT NULL,
  derivative_id text,
  object_kind text NOT NULL,
  object_ref text NOT NULL,
  revocation_id bigint,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL
);
ALTER TABLE asset_object_references ADD COLUMN IF NOT EXISTS revocation_id bigint;
ALTER TABLE asset_object_references ADD COLUMN IF NOT EXISTS revoked_at timestamptz;
CREATE INDEX IF NOT EXISTS asset_object_references_asset_idx
  ON asset_object_references (project_id, asset_id, id);
CREATE TABLE IF NOT EXISTS asset_revocation_audits (
  revoke_id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  asset_id text NOT NULL,
  actor_id text NOT NULL,
  asset_snapshot jsonb NOT NULL,
  derivative_snapshot jsonb NOT NULL,
  object_refs jsonb NOT NULL,
  canceled_job_ids jsonb NOT NULL,
  purge_state text NOT NULL,
  purge_error text,
  requested_at timestamptz NOT NULL,
  purged_at timestamptz,
  updated_at timestamptz NOT NULL
);
ALTER TABLE asset_revocation_audits ADD COLUMN IF NOT EXISTS revoke_id bigserial;
CREATE INDEX IF NOT EXISTS asset_revocation_audits_actor_idx
  ON asset_revocation_audits (actor_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS asset_revocation_audits_asset_idx
  ON asset_revocation_audits (project_id, asset_id, revoke_id DESC);
CREATE TABLE IF NOT EXISTS private_object_cleanup_refs (
  id bigserial PRIMARY KEY,
  project_id text NOT NULL,
  asset_id text,
  job_id text,
  object_kind text NOT NULL,
  object_ref text NOT NULL,
  revocation_id bigint,
  state text NOT NULL DEFAULT 'pending',
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  cleaned_at timestamptz
);
ALTER TABLE private_object_cleanup_refs ADD COLUMN IF NOT EXISTS revocation_id bigint;
CREATE INDEX IF NOT EXISTS private_object_cleanup_pending_idx
  ON private_object_cleanup_refs (state, updated_at, id);
CREATE TABLE IF NOT EXISTS production_runs (id text primary key, project_id text not null, run_key text not null, workflow_id text not null, workflow_version text not null, project_revision text not null, state text not null, checkpoint_revision integer not null, record jsonb not null, created_at timestamptz not null, updated_at timestamptz not null);
CREATE TABLE IF NOT EXISTS production_run_events (id bigserial primary key, run_id text not null, project_id text not null, seq integer not null, type text not null, state text not null, event jsonb not null, created_at timestamptz not null);
CREATE TABLE IF NOT EXISTS production_approvals (id bigserial primary key, run_id text not null, project_id text not null, approval_id text not null, node_id text not null, state text not null, approval jsonb not null, requested_seq integer not null, responded_seq integer, expires_at timestamptz);
CREATE INDEX IF NOT EXISTS jobs_lease_queue_idx ON jobs (state, lease_expires_at, id);
CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs (project_id, id);
CREATE INDEX IF NOT EXISTS media_assets_project_idx ON media_assets (project_id, id);
CREATE INDEX IF NOT EXISTS media_derivatives_asset_idx ON media_derivatives (project_id, asset_id, id);
CREATE INDEX IF NOT EXISTS render_artifacts_project_idx ON render_artifacts (project_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS production_runs_project_run_key_idx ON production_runs (project_id, run_key);
CREATE INDEX IF NOT EXISTS production_runs_project_state_idx ON production_runs (project_id, state, id);
CREATE INDEX IF NOT EXISTS production_runs_project_id_idx ON production_runs (project_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS production_run_events_run_seq_idx ON production_run_events (run_id, seq);
CREATE INDEX IF NOT EXISTS production_run_events_project_seq_idx ON production_run_events (project_id, run_id, seq);
CREATE UNIQUE INDEX IF NOT EXISTS production_approvals_run_approval_idx ON production_approvals (run_id, approval_id);
CREATE INDEX IF NOT EXISTS production_approvals_project_state_idx ON production_approvals (project_id, state, run_id);
CREATE INDEX IF NOT EXISTS job_events_job_cursor_idx ON job_events (job_id, cursor);
CREATE INDEX IF NOT EXISTS job_attempts_job_idx ON job_attempts (job_id, id DESC);
CREATE INDEX IF NOT EXISTS workers_session_idx ON workers (session_token_hash) WHERE session_token_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS media_allowed_users (id bigserial primary key, gmail text, telegram_id text, telegram_username text, added_by text not null, added_at timestamptz not null, enabled boolean not null default true);
CREATE UNIQUE INDEX IF NOT EXISTS media_allowed_users_gmail_idx ON media_allowed_users (gmail) WHERE gmail IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS media_allowed_users_telegram_idx ON media_allowed_users (telegram_id) WHERE telegram_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS media_otp_codes (id bigserial primary key, contact text not null, method text not null, code_hash text not null, secret_id text, created_at timestamptz not null, expires_at timestamptz not null, used boolean not null default false);
ALTER TABLE media_otp_codes ADD COLUMN IF NOT EXISTS secret_id text;
CREATE INDEX IF NOT EXISTS media_otp_codes_contact_idx ON media_otp_codes (contact, method, used, expires_at);
CREATE TABLE IF NOT EXISTS media_sessions (id bigserial primary key, token_hash text not null, secret_id text, contact text not null, method text not null, created_at timestamptz not null, expires_at timestamptz not null, revoked_at timestamptz);
ALTER TABLE media_sessions ADD COLUMN IF NOT EXISTS secret_id text;
CREATE UNIQUE INDEX IF NOT EXISTS media_sessions_token_idx ON media_sessions (token_hash);
CREATE TABLE IF NOT EXISTS media_otp_rate_limits (id bigserial primary key, key_hash text not null, secret_id text, created_at timestamptz not null, window_start timestamptz, request_count integer NOT NULL DEFAULT 0, updated_at timestamptz);
ALTER TABLE media_otp_rate_limits ADD COLUMN IF NOT EXISTS created_at timestamptz;
ALTER TABLE media_otp_rate_limits ADD COLUMN IF NOT EXISTS window_start timestamptz;
ALTER TABLE media_otp_rate_limits ADD COLUMN IF NOT EXISTS request_count integer NOT NULL DEFAULT 0;
ALTER TABLE media_otp_rate_limits ADD COLUMN IF NOT EXISTS updated_at timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS media_otp_rate_limits_key_window_idx ON media_otp_rate_limits (key_hash, window_start);
-- Provider approval state is deliberately split from provider invocation state.
-- Only the signing key id is stored; the signing secret is runtime-only.
CREATE TABLE IF NOT EXISTS provider_approval_signing_keys (
  key_id text PRIMARY KEY,
  created_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS provider_approval_grants (
  grant_id text PRIMARY KEY,
  signing_key_id text NOT NULL REFERENCES provider_approval_signing_keys(key_id),
  actor_id text NOT NULL,
  provider_id text NOT NULL,
  capability text NOT NULL,
  request_digest text NOT NULL,
  grant_data jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_approval_grants_actor_idx ON provider_approval_grants (actor_id, created_at DESC);
CREATE TABLE IF NOT EXISTS provider_approval_reservations (
  reservation_id text PRIMARY KEY,
  idempotency_key text NOT NULL UNIQUE,
  provider_id text NOT NULL,
  capability text NOT NULL,
  reservation_data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_approval_reservations_provider_idx ON provider_approval_reservations (provider_id, created_at DESC);
CREATE TABLE IF NOT EXISTS provider_approval_reconciliations (
  idempotency_key text PRIMARY KEY,
  reservation_id text NOT NULL REFERENCES provider_approval_reservations(reservation_id),
  kind text NOT NULL,
  reconciliation_data jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
ALTER TABLE provider_approval_reconciliations ADD COLUMN IF NOT EXISTS kind text;
UPDATE provider_approval_reconciliations SET kind = 'final' WHERE kind IS NULL;
ALTER TABLE provider_approval_reconciliations ALTER COLUMN kind SET NOT NULL;
CREATE INDEX IF NOT EXISTS provider_approval_reconciliations_reservation_idx ON provider_approval_reconciliations (reservation_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS provider_approval_reconciliations_final_idx
  ON provider_approval_reconciliations (reservation_id) WHERE kind = 'final';
CREATE TABLE IF NOT EXISTS provider_approval_audit (
  decision_id text PRIMARY KEY,
  actor_id text NOT NULL,
  provider_id text NOT NULL,
  capability text NOT NULL,
  request_digest text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL,
  reason text NOT NULL,
  approval_grant_id text,
  budget_reservation_id text,
  estimated_cost jsonb,
  cost_cap jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS provider_approval_audit_actor_idx ON provider_approval_audit (actor_id, created_at DESC, decision_id);
`;
