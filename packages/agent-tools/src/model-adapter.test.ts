import { describe, expect, it } from 'vitest';
import {
  createSemanticIntelligenceV1,
  createSemanticSnapshotV1,
  type SemanticIntelligenceV1,
  type SemanticSnapshotV1,
} from '@joy-media/project-schema';
import { createCreativeBrief, type CreativeBriefRequestV1 } from './creative-brief.js';
import { createFakeModelAdapter } from './model-adapter.js';

function snapshotFixture(): SemanticSnapshotV1 {
  return createSemanticSnapshotV1(
    [
      {
        id: 'timeline',
        label: 'Timeline',
        domain: 'timeline',
        evidence: [
          {
            id: 'clip-001',
            kind: 'clip',
            label: 'Intro clip',
            summary: 'The intro has a bounded range.',
            sourceEntityId: 'clip-source-001',
            sourceEntityRevision: 1,
            startUs: 0,
            durationUs: 5_000_000,
          },
        ],
      },
    ],
    {
      projectId: 'project-fake-adapter',
      revision: 2,
      schemaVersion: 2,
      contentHash: 'snapshot',
      createdBy: 'test',
    },
  );
}

function intelligenceFixture(snapshot: SemanticSnapshotV1): SemanticIntelligenceV1 {
  return createSemanticIntelligenceV1(
    [
      {
        id: 'finding-001',
        category: 'timing',
        severity: 'info',
        title: 'Intro range exists',
        description: 'The intro clip has a bounded five second duration.',
        evidenceIds: ['clip-001'],
        location: { evidenceId: 'clip-001', startUs: 0, durationUs: 5_000_000 },
      },
    ],
    [],
    {
      projectId: snapshot.metadata.projectId,
      snapshotRevision: snapshot.metadata.revision,
      createdBy: 'test',
      contentHash: 'intel',
    },
  );
}

function requestFixture(snapshot: SemanticSnapshotV1): CreativeBriefRequestV1 {
  return {
    projectId: snapshot.metadata.projectId,
    snapshotRevision: snapshot.metadata.revision,
    intelligenceRevision: 1,
    goal: 'Suggest a tighter opening.',
    scope: { domains: ['timeline'], boundedRangeUs: { startUs: 0, durationUs: 5_000_000 } },
    focusAreas: ['pacing'],
    constraints: [],
    referenceMaterials: [],
    requestId: 'request-fake-adapter',
    createdAt: '2026-08-21T12:00:00.000Z',
  };
}

describe('createFakeModelAdapter', () => {
  it('valid mode is deterministic for identical bounded inputs', async () => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);
    const request = requestFixture(snapshot);
    const adapter = createFakeModelAdapter({ mode: 'valid' });

    const first = await adapter.createBrief({ snapshot, intelligence, request });
    const second = await adapter.createBrief({ snapshot, intelligence, request });

    expect(first).toEqual(second);
    expect(first.brief.recommendations[0]?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(first.brief.recommendations[0]?.evidenceReferences).toEqual(['clip-001']);
  });

  it.each([
    ['malformed', /model output/i],
    ['unsafe', /evidence|url|secret|path|command/i],
    ['excessive', /maximum|too large|too long/i],
    ['timeout', /timeout|unavailable/i],
  ] as const)('mode %s produces a catchable orchestration failure', async (mode, message) => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence,
        request: requestFixture(snapshot),
        modelAdapter: createFakeModelAdapter({ mode }),
      }),
    ).rejects.toThrow(message);
  });

  it('empty mode returns a valid read-only brief with blockers instead of fake success', async () => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);

    const brief = await createCreativeBrief({
      snapshot,
      intelligence,
      request: requestFixture(snapshot),
      modelAdapter: createFakeModelAdapter({ mode: 'empty' }),
    });

    expect(brief.recommendations).toEqual([]);
    expect(brief.blockers[0]?.reason).toMatch(/unavailable|no recommendation/i);
    expect(brief.humanDecisions.length).toBeGreaterThan(0);
  });
});
