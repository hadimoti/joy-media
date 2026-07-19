/** PostgreSQL migration contract; the local adapter is used until X01 deployment. */
export const POSTGRES_SCHEMA = `
CREATE TABLE projects (id text primary key, owner_id text not null, title text not null, revision integer not null);
CREATE TABLE workers (id text primary key, owner_id text not null, revoked_at timestamptz);
CREATE TABLE jobs (id text primary key, project_id text not null, type text not null, state text not null, lease_owner text, lease_expires_at timestamptz);
CREATE TABLE job_attempts (id bigserial primary key, job_id text not null, worker_id text not null, started_at timestamptz not null, completed_at timestamptz);
CREATE TABLE job_events (cursor bigserial primary key, job_id text not null, type text not null, created_at timestamptz not null);
`;
