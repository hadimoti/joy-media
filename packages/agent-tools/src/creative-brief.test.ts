import { describe, expect, it } from 'vitest';
import {
  createSemanticIntelligenceV1,
  createSemanticSnapshotV1,
  type IntelligenceFindingV1,
  type SemanticIntelligenceV1,
  type SemanticSnapshotV1,
} from '@joy-media/project-schema';
import {
  createCreativeBrief,
  validateCreativeBriefV1,
  type CreativeBriefRequestV1,
  type CreativeBriefV1,
  type ProposedIntentV1,
} from './creative-brief.js';
import { createFakeModelAdapter } from './model-adapter.js';

const PROJECT_ID = 'project-s3-brief';

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
            label: 'Opening interview clip',
            summary: 'Speaker intro starts after a long visual pause.',
            sourceEntityId: 'clip-source-001',
            sourceEntityRevision: 3,
            startUs: 0,
            durationUs: 8_000_000,
          },
        ],
      },
      {
        id: 'captions',
        label: 'Captions',
        domain: 'captions',
        evidence: [
          {
            id: 'caption-fa-001',
            kind: 'caption-document',
            label: 'زیرنویس فارسی',
            summary: 'متن فارسی باید بدون تغییر باقی بماند',
            sourceEntityId: 'caption-source-001',
            sourceEntityRevision: 2,
          },
        ],
      },
    ],
    {
      projectId: PROJECT_ID,
      revision: 7,
      schemaVersion: 2,
      contentHash: 'snapshot-hash',
      createdBy: 'test',
    },
  );
}

function intelligenceFixture(snapshot: SemanticSnapshotV1): SemanticIntelligenceV1 {
  const finding: IntelligenceFindingV1 = {
    id: 'finding-pacing-001',
    category: 'timing',
    severity: 'notice',
    title: 'Opening pause is measurable',
    description: 'The first clip has an 8 second duration and can support a pacing recommendation.',
    evidenceIds: ['clip-001'],
    evidenceKind: 'clip',
    location: {
      evidenceId: 'clip-001',
      startUs: 0,
      durationUs: 8_000_000,
    },
  };

  return createSemanticIntelligenceV1([finding], [], {
    projectId: snapshot.metadata.projectId,
    snapshotRevision: snapshot.metadata.revision,
    createdBy: 'test',
    contentHash: 'intelligence-hash',
  });
}

function requestFixture(overrides: Partial<CreativeBriefRequestV1> = {}): CreativeBriefRequestV1 {
  return {
    projectId: PROJECT_ID,
    snapshotRevision: 7,
    intelligenceRevision: 1,
    goal: 'Make the intro feel tighter while preserving the Persian caption tone.',
    scope: {
      domains: ['timeline', 'captions'],
      boundedRangeUs: { startUs: 0, durationUs: 8_000_000 },
    },
    focusAreas: ['pacing', 'captions'],
    constraints: [{ id: 'constraint-voice', text: 'Keep the speaker voice natural.' }],
    referenceMaterials: [{ id: 'ref-tone', label: 'Tone note', excerpt: 'Warm, concise, direct.' }],
    requestId: 'brief-request-001',
    createdAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

describe('createCreativeBrief', () => {
  it('creates a valid brief with S2 facts separated from model inferences', async () => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);
    const request = requestFixture();

    const brief = await createCreativeBrief({
      snapshot,
      intelligence,
      request,
      modelAdapter: createFakeModelAdapter({ mode: 'valid' }),
    });

    expect(brief.requestId).toBe(request.requestId);
    expect(brief.snapshotRevision).toBe(snapshot.metadata.revision);
    expect(brief.intelligenceRevision).toBe(intelligence.metadata.revision);
    expect(brief.factualFindings).toHaveLength(1);
    expect(brief.factualFindings[0]).toMatchObject({
      source: 's2',
      findingId: 'finding-pacing-001',
      title: 'Opening pause is measurable',
    });
    expect(brief.modelInferences[0]?.source).toBe('model');
    expect(brief.modelInferences[0]?.evidenceReferences).toEqual(['clip-001']);

    for (const recommendation of brief.recommendations) {
      expect(recommendation.evidenceReferences.length).toBeGreaterThan(0);
      expect(recommendation.evidenceReferences.every((id) => snapshot.evidenceIndex.has(id))).toBe(
        true,
      );
      expect(recommendation.boundedRangeUs.startUs).toBeGreaterThanOrEqual(0);
      expect(recommendation.boundedRangeUs.durationUs).toBeGreaterThan(0);
    }
  });

  it('rejects a missing or mismatched snapshot revision before calling the model', async () => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);
    const calls: string[] = [];

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence,
        request: requestFixture({ snapshotRevision: 99 }),
        modelAdapter: {
          async createBrief() {
            calls.push('called');
            throw new Error('should not be called');
          },
        },
      }),
    ).rejects.toThrow(/snapshot revision/i);

    expect(calls).toEqual([]);
  });

  it('rejects unresolved evidence in S2 input and model recommendations', async () => {
    const snapshot = snapshotFixture();
    const intelligenceWithUnknownEvidence = createSemanticIntelligenceV1(
      [
        {
          id: 'finding-unknown-evidence',
          category: 'quality',
          severity: 'warning',
          title: 'Unknown evidence',
          description: 'This finding points outside the S1 snapshot.',
          evidenceIds: ['missing-evidence'],
        },
      ],
      [],
      {
        projectId: PROJECT_ID,
        snapshotRevision: snapshot.metadata.revision,
        createdBy: 'test',
        contentHash: 'unknown-evidence-hash',
      },
    );

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence: intelligenceWithUnknownEvidence,
        request: requestFixture(),
        modelAdapter: createFakeModelAdapter({ mode: 'valid' }),
      }),
    ).rejects.toThrow(/unknown evidence/i);

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence: intelligenceFixture(snapshot),
        request: requestFixture(),
        modelAdapter: createFakeModelAdapter({ mode: 'unsafe' }),
      }),
    ).rejects.toThrow(/evidence|url|secret|path|command/i);
  });

  it('rejects malformed and oversized model output', async () => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);
    const request = requestFixture();

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence,
        request,
        modelAdapter: createFakeModelAdapter({ mode: 'malformed' }),
      }),
    ).rejects.toThrow(/model output/i);

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence,
        request,
        modelAdapter: createFakeModelAdapter({ mode: 'excessive' }),
      }),
    ).rejects.toThrow(/maximum|too large|too long/i);
  });

  it('rejects request command surfaces and preserves inputs without mutation', async () => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);
    const snapshotEvidenceBefore = [...snapshot.evidenceIds];
    const findingIdsBefore = [...intelligence.findingIds];
    const request = {
      ...requestFixture(),
      commands: [{ type: 'deleteClip', id: 'clip-001' }],
    } as unknown;

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence,
        request,
        modelAdapter: createFakeModelAdapter({ mode: 'valid' }),
      }),
    ).rejects.toThrow(/command|unknown field/i);

    expect(snapshot.evidenceIds).toEqual(snapshotEvidenceBefore);
    expect(intelligence.findingIds).toEqual(findingIdsBefore);
    expect(snapshot.evidenceIndex.has('clip-001')).toBe(true);
  });

  it('preserves Persian and RTL text byte-for-byte through the valid fake adapter', async () => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);
    const persianGoal = 'ریتم شروع را بهتر کن، اما لحن فارسی را تغییر نده.';
    const persianConstraint = 'هیچ ترجمه یا نرمال‌سازی روی متن فارسی انجام نشود.';

    const brief = await createCreativeBrief({
      snapshot,
      intelligence,
      request: requestFixture({
        goal: persianGoal,
        constraints: [{ id: 'constraint-fa', text: persianConstraint }],
        referenceMaterials: [{ id: 'ref-fa', label: 'یادداشت لحن', excerpt: persianConstraint }],
      }),
      modelAdapter: createFakeModelAdapter({ mode: 'valid' }),
    });

    expect(brief.interpretedGoal).toBe(persianGoal);
    expect(brief.assumptions.some((assumption) => assumption.text === persianConstraint)).toBe(
      true,
    );
    expect(
      brief.recommendations.some((recommendation) =>
        recommendation.rationale.includes(persianGoal),
      ),
    ).toBe(true);
  });

  it('rejects model output that mislabels facts or leaks command/project mutation fields', async () => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);

    const invalidBrief: CreativeBriefV1 = {
      snapshotRevision: snapshot.metadata.revision,
      intelligenceRevision: intelligence.metadata.revision,
      requestId: 'brief-request-001',
      interpretedGoal: 'Goal',
      factualFindings: [
        {
          source: 's2',
          findingId: 'finding-pacing-001',
          title: 'Model changed the deterministic title',
          description: 'The description no longer matches S2.',
          evidenceReferences: ['clip-001'],
          category: 'timing',
          severity: 'notice',
        },
      ],
      modelInferences: [],
      assumptions: [],
      recommendations: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          kind: 'pacing-adjustment',
          confidence: 'medium',
          evidenceReferences: ['clip-001'],
          boundedRangeUs: { startUs: 0, durationUs: 1_000_000 },
          rationale: 'Tighten the intro.',
          expectedBenefit: 'Cleaner opening.',
          riskClassification: 'low',
          proposedIntent: {
            label: 'Read-only intent',
            summary: 'This is not executable.',
            commands: [{ type: 'trim' }],
          } as unknown as ProposedIntentV1,
        },
      ],
      blockers: [],
      humanDecisions: [],
      confidenceSummary: {
        overall: 'medium',
        rationale: 'Enough S1 evidence for a directional brief.',
      },
      generatedAt: '2026-08-21T00:00:00.000Z',
    };

    expect(validateCreativeBriefV1(invalidBrief, { snapshot, intelligence }).valid).toBe(false);
  });

  it('rejects stale model output request identity and interpreted goal mismatches', async () => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);
    const request = requestFixture();
    const valid = await createFakeModelAdapter({ mode: 'valid' }).createBrief({
      snapshot,
      intelligence,
      request,
    });

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence,
        request,
        modelAdapter: {
          async createBrief() {
            return {
              brief: {
                ...valid.brief,
                requestId: 'stale-request-id',
              },
            };
          },
        },
      }),
    ).rejects.toThrow(/requestId/i);

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence,
        request,
        modelAdapter: {
          async createBrief() {
            return {
              brief: {
                ...valid.brief,
                interpretedGoal: 'A different goal from a previous request.',
              },
            };
          },
        },
      }),
    ).rejects.toThrow(/interpretedGoal|goal/i);
  });

  it('rejects recommendation ranges outside cited evidence and request bounds', async () => {
    const snapshot = snapshotFixture();
    const intelligence = intelligenceFixture(snapshot);
    const request = requestFixture({
      scope: {
        domains: ['timeline'],
        boundedRangeUs: { startUs: 1_000_000, durationUs: 3_000_000 },
      },
    });
    const valid = await createFakeModelAdapter({ mode: 'valid' }).createBrief({
      snapshot,
      intelligence,
      request,
    });
    const recommendation = valid.brief.recommendations[0];
    if (recommendation === undefined) {
      throw new Error('valid fake adapter must create a recommendation');
    }

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence,
        request,
        modelAdapter: {
          async createBrief() {
            return {
              brief: {
                ...valid.brief,
                recommendations: [
                  {
                    ...recommendation,
                    boundedRangeUs: { startUs: 0, durationUs: 48 * 60 * 60 * 1_000_000 },
                  },
                ],
              },
            };
          },
        },
      }),
    ).rejects.toThrow(/range|duration|bounds/i);

    await expect(
      createCreativeBrief({
        snapshot,
        intelligence,
        request,
        modelAdapter: {
          async createBrief() {
            return {
              brief: {
                ...valid.brief,
                recommendations: [
                  {
                    ...recommendation,
                    boundedRangeUs: { startUs: 5_000_000, durationUs: 1_000_000 },
                  },
                ],
              },
            };
          },
        },
      }),
    ).rejects.toThrow(/request|bounds|range/i);
  });

  it('allows project-wide S2 factual findings with empty evidence references', async () => {
    const snapshot = snapshotFixture();
    const projectWideFinding: IntelligenceFindingV1 = {
      id: 'finding-project-wide-001',
      category: 'metadata',
      severity: 'info',
      title: 'Project-wide metadata is available',
      description: 'This fact is derived from project-level metadata and has no S1 evidence id.',
      evidenceIds: [],
    };
    const intelligence = createSemanticIntelligenceV1([projectWideFinding], [], {
      projectId: PROJECT_ID,
      snapshotRevision: snapshot.metadata.revision,
      createdBy: 'test',
      contentHash: 'project-wide-hash',
    });

    const brief = await createCreativeBrief({
      snapshot,
      intelligence,
      request: requestFixture(),
      modelAdapter: createFakeModelAdapter({ mode: 'valid' }),
    });

    expect(brief.factualFindings).toEqual([
      {
        source: 's2',
        findingId: projectWideFinding.id,
        title: projectWideFinding.title,
        description: projectWideFinding.description,
        evidenceReferences: [],
        category: projectWideFinding.category,
        severity: projectWideFinding.severity,
      },
    ]);
    expect(brief.recommendations[0]?.evidenceReferences).toEqual(['clip-001']);
  });
});
