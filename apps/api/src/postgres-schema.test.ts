import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { PostgresControlPlane } from './postgres-control-plane.js';
import { POSTGRES_SCHEMA } from './postgres-schema.js';

describe('project document schema migration', () => {
  it('creates an additive V2 head table without redefining the legacy project_documents table', () => {
    expect(POSTGRES_SCHEMA).toContain('CREATE TABLE IF NOT EXISTS project_document_heads_v2');
    expect(POSTGRES_SCHEMA).not.toContain('CREATE TABLE IF NOT EXISTS project_documents (');
  });
});

describe('asset revocation schema migration', () => {
  it('replaces only a legacy composite audit primary key with revoke_id primary key', async () => {
    const queries: string[] = [];
    const pool = {
      query: async (text: string) => {
        queries.push(text);
        if (text.includes('FROM pg_indexes')) {
          return {
            rows: [
              {
                indexname: 'asset_revocation_audits_pkey',
                indexdef:
                  'CREATE UNIQUE INDEX asset_revocation_audits_pkey ON public.asset_revocation_audits USING btree (project_id, asset_id)',
              },
            ],
          };
        }
        return { rows: [] };
      },
    } as unknown as Pool;

    await new PostgresControlPlane(pool, { skipLocked: false }).initialize();

    expect(
      queries.some((query) => query.includes('DROP CONSTRAINT "asset_revocation_audits_pkey"')),
    ).toBe(true);
    expect(
      queries.some((query) =>
        query.includes(
          'ADD CONSTRAINT asset_revocation_audits_revoke_id_pkey PRIMARY KEY (revoke_id)',
        ),
      ),
    ).toBe(true);
    expect(queries.some((query) => query.includes('DROP INDEX'))).toBe(false);
  });
});
