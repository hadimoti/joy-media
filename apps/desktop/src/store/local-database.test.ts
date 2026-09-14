import { describe, expect, it } from 'vitest';
import { LocalDatabase } from './local-database.js';

function testDb(overrides: Partial<{ now: () => string; idFactory: () => string }> = {}) {
  return new LocalDatabase({ filePath: ':memory:', ...overrides });
}

describe('LocalDatabase media manifest', () => {
  it('records and retrieves a media entry by ref id', () => {
    const db = testDb();
    db.recordMedia({
      refId: 'ref-1',
      checksum: 'abc123',
      kind: 'video',
      byteSize: 4096,
      lastVerifiedAt: '2026-09-14T00:00:00.000Z',
    });
    expect(db.getMedia('ref-1')).toEqual({
      refId: 'ref-1',
      checksum: 'abc123',
      kind: 'video',
      byteSize: 4096,
      lastVerifiedAt: '2026-09-14T00:00:00.000Z',
    });
  });

  it('returns undefined for an unknown ref', () => {
    expect(testDb().getMedia('missing')).toBeUndefined();
  });

  it('lists every recorded entry, ordered by ref id', () => {
    const db = testDb();
    db.recordMedia({
      refId: 'ref-b',
      checksum: 'b',
      kind: 'audio',
      byteSize: 1,
      lastVerifiedAt: 't',
    });
    db.recordMedia({
      refId: 'ref-a',
      checksum: 'a',
      kind: 'image',
      byteSize: 1,
      lastVerifiedAt: 't',
    });
    expect(db.listMedia().map((entry) => entry.refId)).toEqual(['ref-a', 'ref-b']);
  });

  it('replaces an existing entry for the same ref id (re-verification)', () => {
    const db = testDb();
    db.recordMedia({
      refId: 'ref-1',
      checksum: 'old',
      kind: 'video',
      byteSize: 10,
      lastVerifiedAt: 't0',
    });
    db.recordMedia({
      refId: 'ref-1',
      checksum: 'new',
      kind: 'video',
      byteSize: 20,
      lastVerifiedAt: 't1',
    });
    expect(db.getMedia('ref-1')).toMatchObject({ checksum: 'new', byteSize: 20 });
    expect(db.listMedia()).toHaveLength(1);
  });

  it('removes an entry', () => {
    const db = testDb();
    db.recordMedia({
      refId: 'ref-1',
      checksum: 'a',
      kind: 'video',
      byteSize: 1,
      lastVerifiedAt: 't',
    });
    db.removeMedia('ref-1');
    expect(db.getMedia('ref-1')).toBeUndefined();
  });
});

describe('LocalDatabase jobs', () => {
  it('enqueues a job as queued and reports it back by id', () => {
    let idCount = 0;
    const db = testDb({ idFactory: () => `job-${++idCount}`, now: () => 'T0' });
    const job = db.enqueueJob('derivative', 'ref-1');
    expect(job).toEqual({
      id: 'job-1',
      kind: 'derivative',
      refId: 'ref-1',
      status: 'queued',
      createdAt: 'T0',
      updatedAt: 'T0',
    });
    expect(db.getJob('job-1')).toEqual(job);
  });

  it('transitions status and records an error message on failure', () => {
    let tick = 0;
    const timestamps = ['T0', 'T1'];
    const db = testDb({ idFactory: () => 'job-1', now: () => timestamps[tick++] ?? 'TN' });
    db.enqueueJob('derivative', 'ref-1');
    const updated = db.updateJobStatus('job-1', 'failed', 'decoder crashed');
    expect(updated).toEqual({
      id: 'job-1',
      kind: 'derivative',
      refId: 'ref-1',
      status: 'failed',
      createdAt: 'T0',
      updatedAt: 'T1',
      error: 'decoder crashed',
    });
  });

  it('updateJobStatus on an unknown id is a no-op that returns undefined', () => {
    expect(testDb().updateJobStatus('missing', 'done')).toBeUndefined();
  });

  it('lists jobs in creation order', () => {
    let idCount = 0;
    const db = testDb({ idFactory: () => `job-${++idCount}` });
    db.enqueueJob('derivative', 'ref-1');
    db.enqueueJob('export', 'ref-2');
    expect(db.listJobs().map((job) => job.id)).toEqual(['job-1', 'job-2']);
  });

  it('recoverInterrupted cancels every queued/running job and leaves done/failed alone', () => {
    let idCount = 0;
    const db = testDb({ idFactory: () => `job-${++idCount}` });
    db.enqueueJob('derivative', 'ref-1'); // stays queued -> should be cancelled
    db.enqueueJob('export', 'ref-2');
    db.updateJobStatus('job-2', 'running'); // stays running -> should be cancelled
    db.enqueueJob('derivative', 'ref-3');
    db.updateJobStatus('job-3', 'done'); // already finished -> left alone

    const recovered = db.recoverInterrupted();
    expect(recovered.map((job) => job.id).sort()).toEqual(['job-1', 'job-2']);
    expect(recovered.every((job) => job.status === 'cancelled')).toBe(true);
    expect(recovered.every((job) => job.error === 'interrupted by shutdown')).toBe(true);
    expect(db.getJob('job-3')?.status).toBe('done');
  });

  it('recoverInterrupted is idempotent (a second pass finds nothing left to cancel)', () => {
    const db = testDb();
    db.enqueueJob('derivative', 'ref-1');
    db.recoverInterrupted();
    expect(db.recoverInterrupted()).toEqual([]);
  });
});

describe('LocalDatabase lifecycle', () => {
  it('closes cleanly and rejects further use of the same handle', () => {
    const db = testDb();
    db.enqueueJob('derivative', 'ref-1');
    db.close();
    expect(() => db.listJobs()).toThrow();
  });
});
