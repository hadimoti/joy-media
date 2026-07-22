/** Idempotent PostgreSQL schema for the durable metadata and job queue. */
export const POSTGRES_SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (id text primary key, owner_id text not null, title text not null, revision integer not null);
CREATE TABLE IF NOT EXISTS workers (id text primary key, owner_id text not null, revoked_at timestamptz);
CREATE TABLE IF NOT EXISTS jobs (id text primary key, project_id text not null, type text not null, state text not null, lease_owner text, lease_expires_at timestamptz);
CREATE TABLE IF NOT EXISTS job_attempts (id bigserial primary key, job_id text not null, worker_id text not null, started_at timestamptz not null, completed_at timestamptz);
CREATE TABLE IF NOT EXISTS job_events (cursor bigserial primary key, job_id text not null, type text not null, created_at timestamptz not null);
CREATE INDEX IF NOT EXISTS jobs_lease_queue_idx ON jobs (state, lease_expires_at, id);
CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs (project_id, id);
CREATE INDEX IF NOT EXISTS job_events_job_cursor_idx ON job_events (job_id, cursor);
CREATE INDEX IF NOT EXISTS job_attempts_job_idx ON job_attempts (job_id, id DESC);
`;
