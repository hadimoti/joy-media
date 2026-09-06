import { describe, expect, it } from 'vitest';
import {
  EXPORT_HISTORY_KEY,
  DURABLE_EXPORT_BYTES_UNAVAILABLE_ERROR,
  LEGACY_FINAL_VERIFICATION_REQUIRED_ERROR,
  PROJECT_EXPORT_HISTORY_KEY,
  loadLegacyExportHistory,
  loadExportHistory,
  loadProjectExportHistory,
  markCompletedExportCacheUnavailable,
  migrateLegacyExportHistory,
  recoverInterruptedProjectExports,
  saveExportHistory,
  saveProjectExportHistory,
  upsertEntry,
  upsertProjectEntry,
  type ExportProcessEntry,
  type ProjectExportProcessEntry,
} from './export-history.js';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
}

const entry = (id: string, status: ExportProcessEntry['status']): ExportProcessEntry => ({
  id,
  filename: `${id}.mp4`,
  status,
  startedAt: '2026-07-23T00:00:00.000Z',
  mimeType: 'video/mp4',
});

const projectEntry = (
  projectId: string,
  id: string,
  status: ProjectExportProcessEntry['status'],
): ProjectExportProcessEntry => {
  const base = {
    id,
    filename: `${id}.mp4`,
    status,
    startedAt: '2026-07-23T00:00:00.000Z',
    mimeType: 'video/mp4',
    projectId,
    fingerprint: `${projectId}:revision-1:reels`,
    revision: 1,
    presetId: 'reels-1080',
    manifest: { width: 1080, height: 1920, durationUs: 3_000_000, frameRate: 30 },
  };
  return status === 'completed'
    ? { ...base, status, cacheState: 'ready', sha256: 'a'.repeat(64), totalBytes: 4 }
    : { ...base, status, cacheState: 'none' };
};

function verifiedProjectEntry(projectId: string, id: string): ProjectExportProcessEntry {
  return {
    ...projectEntry(projectId, id, 'completed'),
    verification: {
      verifierVersion: 'joy-final-encoded-export-verifier-v1',
      decoderVersion: 'joy-browser-final-encoded-export-decoder-v1',
      checkedAt: '2026-09-06T01:02:03.000Z',
      status: 'verified',
      scope: 'decoded-final-encoded-export',
      facts: {
        container: 'mp4',
        width: 1080,
        height: 1920,
        durationUs: 3_000_000,
        videoStreamCount: 1,
        audioStreamCount: 1,
        presentationFrameCount: 90,
      },
      checkKinds: [
        'container',
        'video-streams',
        'audio-streams',
        'dimensions',
        'duration',
        'video-pts',
        'video-decode',
        'audio-decode',
      ],
    },
  };
}

describe('export history', () => {
  it('round-trips entries and keeps newest first on upsert', () => {
    const storage = memoryStorage();
    let entries = upsertEntry([], entry('a', 'completed'));
    entries = upsertEntry(entries, entry('b', 'completed'));
    saveExportHistory(storage, entries);
    expect(loadExportHistory(storage).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('replaces an entry by id instead of duplicating it', () => {
    let entries = upsertEntry([], entry('a', 'running'));
    entries = upsertEntry(entries, { ...entry('a', 'completed'), totalBytes: 9 });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ id: 'a', status: 'completed', totalBytes: 9 });
  });

  it('persists selected and recorder-reported MP4 MIME metadata for every status', () => {
    const storage = memoryStorage();
    saveExportHistory(storage, [
      entry('running', 'running'),
      { ...entry('completed', 'completed'), mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2' },
      { ...entry('failed', 'failed'), mimeType: 'video/mp4;codecs=avc1.42E01E' },
    ]);
    expect(
      loadExportHistory(storage).map(({ status, mimeType }) => ({ status, mimeType })),
    ).toEqual([
      { status: 'interrupted-retryable', mimeType: 'video/mp4' },
      { status: 'completed', mimeType: 'video/mp4;codecs=avc1.640028,mp4a.40.2' },
      { status: 'failed', mimeType: 'video/mp4;codecs=avc1.42E01E' },
    ]);
  });

  it('marks stale running entries as retryable on load', () => {
    const storage = memoryStorage();
    saveExportHistory(storage, [entry('a', 'running')]);
    const loaded = loadExportHistory(storage);
    expect(loaded[0]).toMatchObject({
      status: 'interrupted-retryable',
      error: 'interrupted by page reload',
    });
  });

  it('ignores malformed persisted payloads', () => {
    const storage = memoryStorage();
    storage.setItem(EXPORT_HISTORY_KEY, '{broken');
    expect(loadExportHistory(storage)).toEqual([]);
    storage.setItem(EXPORT_HISTORY_KEY, JSON.stringify([{ nope: true }, entry('ok', 'completed')]));
    expect(loadExportHistory(storage).map((e) => e.id)).toEqual(['ok']);
  });

  it('caps the history at 20 entries', () => {
    let entries: readonly ExportProcessEntry[] = [];
    for (let i = 0; i < 25; i++) entries = upsertEntry(entries, entry(`e${i}`, 'completed'));
    expect(entries).toHaveLength(20);
    expect(entries[0]?.id).toBe('e24');
  });

  it('migrates v1 rows as read-only legacy data without assigning a project', () => {
    const storage = memoryStorage();
    saveExportHistory(storage, [entry('legacy-running', 'running')]);

    expect(migrateLegacyExportHistory(storage)).toEqual({ migrated: true, legacyCount: 1 });
    expect(migrateLegacyExportHistory(storage)).toEqual({ migrated: false, legacyCount: 1 });
    expect(loadProjectExportHistory(storage, 'project-a')).toEqual([]);
    expect(loadLegacyExportHistory(storage)).toEqual([
      expect.objectContaining({
        id: 'legacy-running',
        status: 'interrupted-retryable',
        error: 'interrupted by page reload',
      }),
    ]);
    expect(storage.getItem(EXPORT_HISTORY_KEY)).not.toBeNull();
    expect(storage.getItem(PROJECT_EXPORT_HISTORY_KEY)).toContain('"version":2');
  });

  it('keeps project histories isolated while preserving other project rows', () => {
    const storage = memoryStorage();
    saveProjectExportHistory(storage, 'project-a', [projectEntry('project-a', 'a-1', 'completed')]);
    saveProjectExportHistory(storage, 'project-b', [projectEntry('project-b', 'b-1', 'failed')]);
    saveProjectExportHistory(storage, 'project-a', [projectEntry('project-a', 'a-2', 'completed')]);

    expect(loadProjectExportHistory(storage, 'project-a').map(({ id }) => id)).toEqual(['a-2']);
    expect(loadProjectExportHistory(storage, 'project-b').map(({ id }) => id)).toEqual(['b-1']);
  });

  it('upserts only the matching project and logical id', () => {
    const a = projectEntry('project-a', 'same-id', 'running');
    const b = projectEntry('project-b', 'same-id', 'failed');
    const completed: ProjectExportProcessEntry = {
      ...a,
      status: 'completed',
      cacheState: 'ready',
      sha256: 'b'.repeat(64),
      totalBytes: 4,
    };

    const result = upsertProjectEntry(upsertProjectEntry([a], b), completed);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ projectId: 'project-a', status: 'completed' });
    expect(result[1]).toMatchObject({ projectId: 'project-b', status: 'failed' });
  });

  it('persists stale running exports as interrupted-retryable and quarantines legacy unverified output', () => {
    const storage = memoryStorage();
    saveProjectExportHistory(storage, 'project-a', [
      projectEntry('project-a', 'running', 'running'),
      projectEntry('project-a', 'done', 'completed'),
    ]);
    saveProjectExportHistory(storage, 'project-b', [
      projectEntry('project-b', 'other-running', 'running'),
    ]);

    expect(recoverInterruptedProjectExports(storage, 'project-a')).toEqual([
      expect.objectContaining({
        id: 'running',
        status: 'interrupted-retryable',
        cacheState: 'none',
        error: 'interrupted by page reload',
      }),
      expect.objectContaining({
        id: 'done',
        status: 'verification-required',
        cacheState: 'none',
        error: LEGACY_FINAL_VERIFICATION_REQUIRED_ERROR,
      }),
    ]);
    const persisted = JSON.parse(storage.getItem(PROJECT_EXPORT_HISTORY_KEY)!) as {
      entries: ProjectExportProcessEntry[];
    };
    expect(
      persisted.entries.find(({ projectId, id }) => projectId === 'project-a' && id === 'running'),
    ).toMatchObject({ status: 'interrupted-retryable', cacheState: 'none' });
    expect(
      persisted.entries.find(
        ({ projectId, id }) => projectId === 'project-b' && id === 'other-running',
      ),
    ).toMatchObject({ status: 'running' });
  });

  it('persists an unavailable final-Blob verification as retryable attention, never completed', () => {
    const storage = memoryStorage();
    const verificationRequired: ProjectExportProcessEntry = {
      ...projectEntry('project-a', 'needs-final-verification', 'verification-required'),
      verification: {
        verifierVersion: 'joy-final-encoded-export-verifier-v1',
        decoderVersion: 'joy-browser-final-encoded-export-decoder-v1',
        checkedAt: '2026-09-06T01:02:03.000Z',
        status: 'unavailable',
        code: 'decoder-unavailable',
      },
      error: 'Final MP4 requires browser verification (decoder-unavailable).',
    };

    saveProjectExportHistory(storage, 'project-a', [verificationRequired]);

    expect(loadProjectExportHistory(storage, 'project-a')).toEqual([
      expect.objectContaining({
        id: 'needs-final-verification',
        status: 'verification-required',
        cacheState: 'none',
        verification: expect.objectContaining({
          status: 'unavailable',
          code: 'decoder-unavailable',
        }),
      }),
    ]);
  });

  it('keeps a retryable history row when verified cache bytes disappear, without retaining a stale success receipt', () => {
    const storage = memoryStorage();
    const lostCache = markCompletedExportCacheUnavailable(
      verifiedProjectEntry('project-a', 'missing-cache'),
      '2026-09-06T02:03:04.000Z',
    );

    expect(lostCache).toMatchObject({
      id: 'missing-cache',
      status: 'failed',
      cacheState: 'none',
      error: DURABLE_EXPORT_BYTES_UNAVAILABLE_ERROR,
      verification: {
        status: 'blocked',
        code: 'artifact-not-readable',
        checkedAt: '2026-09-06T02:03:04.000Z',
      },
    });
    expect(lostCache).not.toHaveProperty('sha256');
    expect(lostCache).not.toHaveProperty('totalBytes');

    saveProjectExportHistory(storage, 'project-a', [lostCache]);
    expect(loadProjectExportHistory(storage, 'project-a')).toEqual([
      expect.objectContaining({
        id: 'missing-cache',
        status: 'failed',
        cacheState: 'none',
        verification: expect.objectContaining({
          status: 'blocked',
          code: 'artifact-not-readable',
        }),
      }),
    ]);
  });

  it('downgrades a pre-verification completed row before it can recover a cache/download', () => {
    const storage = memoryStorage();
    storage.setItem(
      PROJECT_EXPORT_HISTORY_KEY,
      JSON.stringify({
        version: 2,
        legacy: [],
        entries: [projectEntry('project-a', 'old-completed-output', 'completed')],
      }),
    );

    expect(recoverInterruptedProjectExports(storage, 'project-a')).toEqual([
      expect.objectContaining({
        id: 'old-completed-output',
        status: 'verification-required',
        cacheState: 'none',
        error: LEGACY_FINAL_VERIFICATION_REQUIRED_ERROR,
      }),
    ]);
    const persisted = JSON.parse(storage.getItem(PROJECT_EXPORT_HISTORY_KEY)!) as {
      entries: readonly ProjectExportProcessEntry[];
    };
    expect(persisted.entries[0]).toMatchObject({
      id: 'old-completed-output',
      status: 'verification-required',
      cacheState: 'none',
      error: LEGACY_FINAL_VERIFICATION_REQUIRED_ERROR,
    });
    expect(persisted.entries[0]).not.toHaveProperty('sha256');
    expect(persisted.entries[0]).not.toHaveProperty('totalBytes');
  });

  it('drops a completed row carrying an unsuccessful final-Blob receipt', () => {
    const storage = memoryStorage();
    storage.setItem(
      PROJECT_EXPORT_HISTORY_KEY,
      JSON.stringify({
        version: 2,
        legacy: [],
        entries: [
          {
            ...projectEntry('project-a', 'tampered-complete', 'completed'),
            verification: {
              verifierVersion: 'joy-final-encoded-export-verifier-v1',
              decoderVersion: 'joy-browser-final-encoded-export-decoder-v1',
              checkedAt: '2026-09-06T01:02:03.000Z',
              status: 'unavailable',
              code: 'decoder-unavailable',
            },
          },
        ],
      }),
    );

    expect(loadProjectExportHistory(storage, 'project-a')).toEqual([]);
  });

  it('drops a completed receipt whose safe facts no longer match its immutable manifest', () => {
    const storage = memoryStorage();
    storage.setItem(
      PROJECT_EXPORT_HISTORY_KEY,
      JSON.stringify({
        version: 2,
        legacy: [],
        entries: [
          {
            ...projectEntry('project-a', 'mismatched-verified-receipt', 'completed'),
            verification: {
              verifierVersion: 'joy-final-encoded-export-verifier-v1',
              decoderVersion: 'joy-browser-final-encoded-export-decoder-v1',
              checkedAt: '2026-09-06T01:02:03.000Z',
              status: 'verified',
              scope: 'decoded-final-encoded-export',
              facts: {
                container: 'mp4',
                width: 1920,
                height: 1080,
                durationUs: 3_000_000,
                videoStreamCount: 1,
                audioStreamCount: 1,
                presentationFrameCount: 90,
              },
              checkKinds: ['container', 'dimensions', 'duration', 'video-pts'],
            },
          },
        ],
      }),
    );

    expect(loadProjectExportHistory(storage, 'project-a')).toEqual([]);
  });

  it('drops a completed receipt that omits required structural final-Blob checks', () => {
    const storage = memoryStorage();
    storage.setItem(
      PROJECT_EXPORT_HISTORY_KEY,
      JSON.stringify({
        version: 2,
        legacy: [],
        entries: [
          {
            ...projectEntry('project-a', 'incomplete-verified-receipt', 'completed'),
            verification: {
              verifierVersion: 'joy-final-encoded-export-verifier-v1',
              decoderVersion: 'joy-browser-final-encoded-export-decoder-v1',
              checkedAt: '2026-09-06T01:02:03.000Z',
              status: 'verified',
              scope: 'decoded-final-encoded-export',
              facts: {
                container: 'mp4',
                width: 1080,
                height: 1920,
                durationUs: 3_000_000,
                videoStreamCount: 1,
                audioStreamCount: 1,
                presentationFrameCount: 90,
              },
              checkKinds: ['container'],
            },
          },
        ],
      }),
    );

    expect(loadProjectExportHistory(storage, 'project-a')).toEqual([]);
  });

  it('rejects an empty project id instead of creating an unscoped v2 bucket', () => {
    expect(() => loadProjectExportHistory(memoryStorage(), '   ')).toThrow(
      'projectId must not be empty',
    );
  });

  it('drops v2 rows whose persisted retry manifest is incomplete or invalid', () => {
    const storage = memoryStorage();
    storage.setItem(
      PROJECT_EXPORT_HISTORY_KEY,
      JSON.stringify({
        version: 2,
        legacy: [],
        entries: [
          projectEntry('project-a', 'valid', 'failed'),
          {
            ...projectEntry('project-a', 'invalid', 'failed'),
            manifest: { width: 1080, height: 1920, durationUs: 0, frameRate: 30 },
          },
        ],
      }),
    );

    expect(loadProjectExportHistory(storage, 'project-a').map(({ id }) => id)).toEqual(['valid']);
  });

  it('drops an unsafe persisted final-verification receipt instead of trusting arbitrary data', () => {
    const storage = memoryStorage();
    storage.setItem(
      PROJECT_EXPORT_HISTORY_KEY,
      JSON.stringify({
        version: 2,
        legacy: [],
        entries: [
          {
            ...projectEntry('project-a', 'unsafe-receipt', 'verification-required'),
            verification: {
              verifierVersion: 'joy-final-encoded-export-verifier-v1',
              decoderVersion: 'decoder-v1',
              checkedAt: '2026-09-06T01:02:03.000Z',
              status: 'unavailable',
              code: 'decoder-unavailable',
              rawArtifactUrl: 'file:///private/export.mp4?key=secret',
            },
          },
        ],
      }),
    );

    expect(loadProjectExportHistory(storage, 'project-a')).toEqual([]);
  });
});
