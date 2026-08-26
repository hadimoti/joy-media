import { describe, expect, it } from 'vitest';
import {
  migrateLegacyProjectDomains,
  serializeLegacyBackup,
  type MigrationStorage,
} from './legacy-project-migration.js';

function storage(
  initial: Record<string, string> = {},
): MigrationStorage & { values: Record<string, string> } {
  const values = { ...initial };
  return {
    values,
    getItem: (key: string) => values[key] ?? null,
    setItem: (key: string, value: string) => void (values[key] = value),
  };
}

describe('legacy project migration seam', () => {
  it('migrates valid domains, verifies a SHA-256 digest, and preserves unknown domains', async () => {
    const target = storage();
    const migrated = await migrateLegacyProjectDomains(
      {
        project: { id: 'demo', schemaVersion: 1 },
        timeline: { clips: [] },
        futureDomain: { enabled: true },
      },
      { storage: target },
    );
    expect(migrated.status).toBe('migrated');
    expect(migrated.document?.projectId).toBe('demo');
    expect(migrated.document?.futureDomain).toEqual({ enabled: true });
    expect(migrated.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(migrated.digestVerified).toBe(true);
    expect(target.values['joy-media.legacy-project-migration.v2']).toBe(migrated.digest);
  });

  it('is idempotent after the marker is written', async () => {
    const target = storage();
    await migrateLegacyProjectDomains(
      { timeline: { clips: [] } },
      { projectId: 'repeat', storage: target },
    );
    const second = await migrateLegacyProjectDomains(
      { timeline: { clips: [] } },
      { projectId: 'repeat', storage: target },
    );
    expect(second.status).toBe('already-migrated');
    expect(second.digestVerified).toBe(true);
  });

  it('does not trust a bogus or mismatched migration marker', async () => {
    const target = storage({ 'joy-media.legacy-project-migration.v2': 'not-a-digest' });
    const first = await migrateLegacyProjectDomains(
      { timeline: { clips: [] } },
      { storage: target },
    );
    expect(first.status).toBe('migrated');
    expect(first.digestVerified).toBe(false);
    target.values['joy-media.legacy-project-migration.v2'] = '0'.repeat(64);
    const second = await migrateLegacyProjectDomains(
      { timeline: { clips: [{ id: 'changed' }] } },
      { storage: target },
    );
    expect(second.status).toBe('migrated');
    expect(second.digestVerified).toBe(false);
    expect(second.digest).not.toBe('0'.repeat(64));
  });

  it('checks a marker against an explicitly supplied V2 document', async () => {
    const target = storage({ 'joy-media.legacy-project-migration.v2': 'f'.repeat(64) });
    const existingDocument = {
      schemaVersion: 2 as const,
      projectId: 'existing',
      timeline: { clips: [] },
    };
    const result = await migrateLegacyProjectDomains(
      { timeline: { clips: [] } },
      { storage: target, existingDocument },
    );
    expect(result.status).toBe('migrated');
    expect(result.digestVerified).toBe(false);
    expect(result.document).not.toBe(existingDocument);
    expect(result.digest).not.toBe('f'.repeat(64));
  });

  it('rejects raw bytes and paths through the existing V2 validator', async () => {
    const result = await migrateLegacyProjectDomains({
      timeline: { rawBytes: 'AAAA', sourcePath: 'C:/movie.mp4' },
    });
    expect(result.status).toBe('invalid');
    expect(
      result.diagnostics.map((diagnostic: { readonly code: string }) => diagnostic.code),
    ).toContain('PROJECT_DOCUMENT_V2_MEDIA_BYTES');
    expect(result.document).toBeUndefined();
  });

  it('reports no data and serializes a deterministic downloadable backup', async () => {
    expect((await migrateLegacyProjectDomains(null)).status).toBe('no-data');
    const backup = serializeLegacyBackup({ z: 1, a: { b: true } });
    expect(backup.filename).toBe('joy-media-legacy-project-backup.json');
    expect(backup.mimeType).toBe('application/json');
    expect(backup.content).toBe('{"a":{"b":true},"z":1}\n');
  });

  it('accepts JSON strings from old localStorage domains', async () => {
    const result = await migrateLegacyProjectDomains(
      { timeline: '{"clips":[]}' },
      { projectId: 'json-string' },
    );
    expect(result.status).toBe('migrated');
    expect(result.document?.timeline).toEqual({ clips: [] });
  });

  it('returns a bounded invalid result for circular, unsupported, and oversized values', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const circularResult = await migrateLegacyProjectDomains({ circular });
    expect(circularResult.status).toBe('invalid');
    expect(circularResult.backup.content.length).toBeLessThan(700);

    const unsupported = await migrateLegacyProjectDomains({ callable: () => 'nope' });
    expect(unsupported.status).toBe('invalid');
    expect(unsupported.backup.content).toContain('legacy backup unavailable');

    const oversized = await migrateLegacyProjectDomains({ text: 'x'.repeat(16_385) });
    expect(oversized.status).toBe('invalid');
    expect(oversized.backup.content.length).toBeLessThan(700);
  });
});
