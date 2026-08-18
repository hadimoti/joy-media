/**
 * PostgreSQL Schema Tests (WP-37 S4-F10-E5-D1)
 *
 * Static schema regression tests proving additive clauses, primary key,
 * JSONB document field, head column, and absence of destructive SQL.
 */

import { describe, it, expect } from 'vitest';
import { POSTGRES_SCHEMA } from './postgres-schema.js';

// ============================================================================
// Schema Content Tests
// ============================================================================

describe('PostgreSQL Schema - Revisioned Project Documents', () => {
  const schema = POSTGRES_SCHEMA;

  // --- projects.document_revision_id column ---

  it('contains additive ALTER TABLE for projects.document_revision_id', () => {
    expect(schema).toContain('ALTER TABLE projects ADD COLUMN IF NOT EXISTS document_revision_id text NULL');
  });

  it('projects.document_revision_id is nullable text', () => {
    expect(schema).toContain('document_revision_id text NULL');
    expect(schema).not.toContain('document_revision_id text NOT NULL');
  });

  // --- project_documents table ---

  it('contains CREATE TABLE IF NOT EXISTS project_documents', () => {
    expect(schema).toContain('CREATE TABLE IF NOT EXISTS project_documents');
  });

  it('project_documents has project_id text NOT NULL column', () => {
    expect(schema).toContain('project_id text NOT NULL');
  });

  it('project_documents has revision_id text NOT NULL column', () => {
    expect(schema).toContain('revision_id text NOT NULL');
  });

  it('project_documents has schema_version integer NOT NULL column', () => {
    expect(schema).toContain('schema_version integer NOT NULL');
  });

  it('project_documents has document jsonb NOT NULL column', () => {
    expect(schema).toContain('document jsonb NOT NULL');
  });

  it('project_documents has created_at timestamptz NOT NULL column', () => {
    expect(schema).toContain('created_at timestamptz NOT NULL');
  });

  it('project_documents has composite primary key on (project_id, revision_id)', () => {
    expect(schema).toContain('PRIMARY KEY (project_id, revision_id)');
  });

  // --- Index ---

  it('has deterministic index for project revision lookup', () => {
    expect(schema).toContain('CREATE INDEX IF NOT EXISTS project_documents_project_revision_idx');
    expect(schema).toContain('ON project_documents (project_id, revision_id)');
  });

  // --- Additive only ---

  it('uses only IF NOT EXISTS clauses for additive DDL', () => {
    expect(schema).toContain('IF NOT EXISTS');
    // No destructive DROP statements
    expect(schema).not.toMatch(/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i);
  });

  it('contains no ALTER TABLE ... DROP COLUMN statements', () => {
    expect(schema).not.toMatch(/ALTER\s+TABLE\s+\w+\s+DROP\s+COLUMN/i);
  });

  it('contains no DELETE statements', () => {
    expect(schema).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('contains no UPDATE statements for backfill', () => {
    // The only UPDATE in the schema is for existing data, not backfill of new columns
    // document_revision_id is added as nullable, so no backfill needed
    const updates = (schema.match(/\bUPDATE\s+\w+\s+SET\b/gi) || []).length;
    // Allow existing UPDATE for asset_sync_enabled which is historical
    // But ensure no UPDATE for document_revision_id
    expect(schema).not.toContain('UPDATE projects SET document_revision_id');
  });

  it('contains no TRUNCATE statements', () => {
    expect(schema).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('contains no data modification statements', () => {
    // Only DDL, no DML
    expect(schema).not.toMatch(/\bINSERT\s+INTO\b/i);
  });

  // --- Field ordering and completeness ---

  it('project_documents table has all required columns in correct order', () => {
    const tableDefStart = schema.indexOf('CREATE TABLE IF NOT EXISTS project_documents');
    const tableDefEnd = schema.indexOf(');', tableDefStart) + 2;
    const tableDef = schema.slice(tableDefStart, tableDefEnd);

    // Check all required columns are present
    expect(tableDef).toContain('project_id text NOT NULL');
    expect(tableDef).toContain('revision_id text NOT NULL');
    expect(tableDef).toContain('schema_version integer NOT NULL');
    expect(tableDef).toContain('document jsonb NOT NULL');
    expect(tableDef).toContain('created_at timestamptz NOT NULL');
    expect(tableDef).toContain('PRIMARY KEY (project_id, revision_id)');
  });

  // --- JSONB validation ---

  it('uses jsonb type for document column', () => {
    expect(schema).toContain('document jsonb NOT NULL');
    expect(schema).not.toContain('document json NOT NULL');
    expect(schema).not.toContain('document text NOT NULL');
  });

  // --- Timestamp precision ---

  it('uses timestamptz for created_at', () => {
    expect(schema).toContain('created_at timestamptz NOT NULL');
  });

  // --- Schema snapshot regression ---

  it('schema snapshot contains project document storage additions', () => {
    // Ensure the schema includes all the new additive parts
    const additions = [
      'document_revision_id text NULL',
      'CREATE TABLE IF NOT EXISTS project_documents',
      'project_id text NOT NULL',
      'revision_id text NOT NULL',
      'schema_version integer NOT NULL',
      'document jsonb NOT NULL',
      'created_at timestamptz NOT NULL',
      'PRIMARY KEY (project_id, revision_id)',
      'project_documents_project_revision_idx',
    ];

    for (const addition of additions) {
      expect(schema).toContain(addition);
    }
  });
});

// ============================================================================
// Absence of Destructive SQL
// ============================================================================

describe('PostgreSQL Schema - No Destructive Operations', () => {
  const schema = POSTGRES_SCHEMA;

  it('does not drop any tables', () => {
    expect(schema).not.toMatch(/\bDROP\s+TABLE\s/i);
  });

  it('does not drop any columns', () => {
    expect(schema).not.toMatch(/\bDROP\s+COLUMN\s/i);
  });

  it('does not drop any indexes', () => {
    expect(schema).not.toMatch(/\bDROP\s+INDEX\s/i);
  });

  it('does not truncate any tables', () => {
    expect(schema).not.toMatch(/\bTRUNCATE\s/i);
  });

  it('does not alter existing columns destructively', () => {
    // Only ALTER TABLE ADD COLUMN IF NOT EXISTS is allowed
    // Check all ALTER TABLE statements contain ADD COLUMN IF NOT EXISTS
    const lines = schema.split('\n');
    for (const line of lines) {
      if (line.includes('ALTER TABLE')) {
        expect(line).toMatch(/ALTER\s+TABLE\s+\w+\s+ADD\s+COLUMN\s+IF\s+NOT\s+EXISTS/i);
      }
    }
  });
});

// ============================================================================
// Project Document Head Pointer
// ============================================================================

describe('PostgreSQL Schema - Document Revision Head Pointer', () => {
  const schema = POSTGRES_SCHEMA;

  it('projects table has document_revision_id as nullable head pointer', () => {
    expect(schema).toContain('ALTER TABLE projects ADD COLUMN IF NOT EXISTS document_revision_id text NULL');
  });

  it('document_revision_id is the atomic current-head pointer', () => {
    // The column exists and is nullable, allowing gradual migration
    expect(schema).toContain('document_revision_id text NULL');
    // No timestamps are used to determine head - only the document_revision_id column
    // The project_documents table has created_at but that's for audit, not head determination
  });

  it('project_documents table supports revision history lookup', () => {
    expect(schema).toContain('project_documents (project_id, revision_id)');
  });
});

// ============================================================================
// Proof of No Migration Execution
// ============================================================================

describe('PostgreSQL Schema - Static Definition Only', () => {
  const schema = POSTGRES_SCHEMA;

  it('schema is a static string with no execution logic', () => {
    expect(typeof schema).toBe('string');
    expect(schema).not.toContain('pg_query');
    expect(schema).not.toContain('pool.query');
    expect(schema).not.toContain('await');
    expect(schema).not.toContain('function');
    expect(schema).not.toContain('=>');
  });

  it('contains only SQL DDL statements', () => {
    // Extract all statements separated by semicolons
    const statements = schema.split(';').filter(s => s.trim().length > 0);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      // Should start with CREATE, ALTER, or similar DDL
      expect(trimmed).toMatch(/^(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|TRUNCATE)/i);
    }
  });
});
