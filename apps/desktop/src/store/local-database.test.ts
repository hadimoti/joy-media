import { describe, expect, it } from 'vitest';
import { LocalDatabase } from './local-database.js';
import type { ProviderProfile } from './local-database.js';

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

describe('LocalDatabase secret ciphertext', () => {
  it('stores and retrieves ciphertext by handle id, never touching plaintext', () => {
    const db = testDb();
    db.setSecretCiphertext('handle-1', 'base64-ciphertext');
    expect(db.getSecretCiphertext('handle-1')).toBe('base64-ciphertext');
  });

  it('returns undefined for an unknown handle', () => {
    expect(testDb().getSecretCiphertext('missing')).toBeUndefined();
  });

  it('replaces ciphertext for the same handle id (key rotation)', () => {
    const db = testDb();
    db.setSecretCiphertext('handle-1', 'old');
    db.setSecretCiphertext('handle-1', 'new');
    expect(db.getSecretCiphertext('handle-1')).toBe('new');
  });

  it('deletes ciphertext', () => {
    const db = testDb();
    db.setSecretCiphertext('handle-1', 'x');
    db.deleteSecretCiphertext('handle-1');
    expect(db.getSecretCiphertext('handle-1')).toBeUndefined();
  });
});

describe('LocalDatabase provider profiles', () => {
  function profile(overrides: Partial<ProviderProfile> = {}) {
    return {
      id: 'profile-1',
      provider: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1',
      modelId: 'gpt-4o-mini',
      secretHandleId: 'handle-1',
      createdAt: 'T0',
      updatedAt: 'T0',
      ...overrides,
    };
  }

  it('saves and retrieves a profile by id, without ever storing the secret value itself', () => {
    const db = testDb();
    db.saveProviderProfile(profile());
    expect(db.getProviderProfile('profile-1')).toEqual(profile());
  });

  it('returns undefined for an unknown profile id', () => {
    expect(testDb().getProviderProfile('missing')).toBeUndefined();
  });

  it('lists profiles in creation order', () => {
    const db = testDb();
    db.saveProviderProfile(profile({ id: 'profile-a', createdAt: 'T0' }));
    db.saveProviderProfile(profile({ id: 'profile-b', createdAt: 'T1' }));
    expect(db.listProviderProfiles().map((p) => p.id)).toEqual(['profile-a', 'profile-b']);
  });

  it('replaces a profile with the same id (re-save after editing)', () => {
    const db = testDb();
    db.saveProviderProfile(profile({ modelId: 'gpt-4o-mini' }));
    db.saveProviderProfile(profile({ modelId: 'gpt-4o', updatedAt: 'T1' }));
    expect(db.getProviderProfile('profile-1')).toMatchObject({ modelId: 'gpt-4o' });
    expect(db.listProviderProfiles()).toHaveLength(1);
  });

  it('deletes a profile', () => {
    const db = testDb();
    db.saveProviderProfile(profile());
    db.deleteProviderProfile('profile-1');
    expect(db.getProviderProfile('profile-1')).toBeUndefined();
  });

  it('stores and retrieves app settings and asset library directory', () => {
    const db = testDb();
    expect(db.getSetting('some_key')).toBeUndefined();
    db.setSetting('some_key', 'some_value');
    expect(db.getSetting('some_key')).toBe('some_value');

    const defaultDir = db.getDefaultAssetLibraryDirectory();
    expect(defaultDir).toBeDefined();
    expect(db.getAssetLibraryDirectory()).toBe(defaultDir);

    db.setAssetLibraryDirectory('D:\\custom-assets');
    expect(db.getAssetLibraryDirectory()).toBe('D:\\custom-assets');
    const info = db.getAssetLibraryInfo();
    expect(info.directory).toBe('D:\\custom-assets');
    expect(info.isDefault).toBe(false);
  });
});
