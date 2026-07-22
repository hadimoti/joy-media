/** Idempotent PostgreSQL schema for the durable metadata and job queue. */
export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id text primary key, owner_id text not null, title text not null, revision integer not null);
CREATE TABLE IF NOT EXISTS workers (id text primary key, owner_id text not null, revoked_at timestamptz);
ALTER TABLE workers ADD COLUMN IF NOT EXISTS session_token_hash text;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS session_expires_at timestamptz;
ALTER TABLE workers ADD COLUMN IF NOT EXISTS capabilities jsonb NOT NULL DEFAULT '[]';
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
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS error text;
CREATE TABLE IF NOT EXISTS job_attempts (id bigserial primary key, job_id text not null, worker_id text not null, started_at timestamptz not null, completed_at timestamptz);
CREATE TABLE IF NOT EXISTS job_events (cursor bigserial primary key, job_id text not null, type text not null, created_at timestamptz not null);
CREATE TABLE IF NOT EXISTS worker_pairing_offers (worker_id text primary key, pairing_code_hash text not null, owner_id text, expires_at timestamptz not null);
CREATE INDEX IF NOT EXISTS jobs_lease_queue_idx ON jobs (state, lease_expires_at, id);
CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs (project_id, id);
CREATE INDEX IF NOT EXISTS job_events_job_cursor_idx ON job_events (job_id, cursor);
CREATE INDEX IF NOT EXISTS job_attempts_job_idx ON job_attempts (job_id, id DESC);
CREATE INDEX IF NOT EXISTS workers_session_idx ON workers (session_token_hash) WHERE session_token_hash IS NOT NULL;
`;
