import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { ensureProjectDocumentSchema, SqliteProjectDocumentStore } from './project-documents.js';

function createStore(): SqliteProjectDocumentStore {
  const db = new DatabaseSync(':memory:');
  ensureProjectDocumentSchema(db);
  return new SqliteProjectDocumentStore(db, () => 'T0');
}

describe('SqliteProjectDocumentStore', () => {
  it('keeps the latest revision of each project and reads it back as written', () => {
    const documents = createStore();
    expect(
      documents.put({ projectId: 'p', baseRevisionId: '', revisionId: 'r1', document: { n: 1 } }),
    ).toEqual({ kind: 'saved', revisionId: 'r1' });
    expect(
      documents.put({ projectId: 'p', baseRevisionId: 'r1', revisionId: 'r2', document: { n: 2 } }),
    ).toEqual({ kind: 'saved', revisionId: 'r2' });
    expect(documents.get('p')).toEqual({ projectId: 'p', revisionId: 'r2', document: { n: 2 } });
  });

  it('refuses a write built on a revision that is not stored, and names the stored one', () => {
    const documents = createStore();
    documents.put({ projectId: 'p', baseRevisionId: '', revisionId: 'r1', document: { n: 1 } });
    expect(
      documents.put({ projectId: 'p', baseRevisionId: 'r0', revisionId: 'r9', document: { n: 9 } }),
    ).toEqual({ kind: 'conflict', revisionId: 'r1' });
    expect(documents.get('p')).toEqual({ projectId: 'p', revisionId: 'r1', document: { n: 1 } });
  });

  it('treats a retry of a write that already landed as saved, and keeps the stored document', () => {
    const documents = createStore();
    documents.put({ projectId: 'p', baseRevisionId: '', revisionId: 'r1', document: { n: 1 } });
    documents.put({ projectId: 'p', baseRevisionId: 'r1', revisionId: 'r2', document: { n: 2 } });
    expect(
      documents.put({
        projectId: 'p',
        baseRevisionId: 'r1',
        revisionId: 'r2',
        document: { n: 99 },
      }),
    ).toEqual({ kind: 'saved', revisionId: 'r2' });
    expect(documents.get('p')?.document).toEqual({ n: 2 });
  });

  it('reports a missing project when the write names a base revision', () => {
    const documents = createStore();
    expect(
      documents.put({ projectId: 'p', baseRevisionId: 'r1', revisionId: 'r2', document: {} }),
    ).toEqual({ kind: 'missing' });
    expect(documents.get('p')).toBeUndefined();
  });

  it('keeps the stored Look Instances document unless a write sends a new one', () => {
    const documents = createStore();
    documents.put({
      projectId: 'p',
      baseRevisionId: '',
      revisionId: 'r1',
      document: {},
      lookInstances: { instances: { a: 1 } },
    });
    documents.put({ projectId: 'p', baseRevisionId: 'r1', revisionId: 'r2', document: { n: 2 } });
    expect(documents.get('p')).toEqual({
      projectId: 'p',
      revisionId: 'r2',
      document: { n: 2 },
      lookInstances: { instances: { a: 1 } },
    });
    documents.put({
      projectId: 'p',
      baseRevisionId: 'r2',
      revisionId: 'r3',
      document: { n: 3 },
      lookInstances: { instances: {} },
    });
    expect(documents.get('p')?.lookInstances).toEqual({ instances: {} });
  });

  it('keeps projects apart, and reads an older revision as absent', () => {
    const documents = createStore();
    documents.put({ projectId: 'a', baseRevisionId: '', revisionId: 'r1', document: { p: 'a' } });
    documents.put({ projectId: 'b', baseRevisionId: '', revisionId: 'r7', document: { p: 'b' } });
    expect(documents.get('a')?.document).toEqual({ p: 'a' });
    expect(documents.get('b')?.revisionId).toBe('r7');
    expect(documents.get('a', 'r0')).toBeUndefined();
    expect(documents.get('a', 'r1')?.revisionId).toBe('r1');
  });
});
