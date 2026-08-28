import { describe, expect, it } from 'vitest';
import {
  createSemanticIntelligenceV1,
  createSemanticSnapshotV1,
  type IntelligenceFindingV1,
  type SemanticIntelligenceV1,
  type SemanticSnapshotV1,
} from '@joy-media/project-schema';
import {
  CREATIVE_BRIEF_V2_SCHEMA_VERSION,
  CreativeBriefV2,
  validateCreativeBriefV2Request,
  validateCreativeBriefV2Result,
  type CreativeBriefV2Request,
  type CreativeBriefV2Result,
} from './index.js';

const PROJECT_ID = 'project-creative-brief-v2';
const PROJECT_REVISION = 'local-revision:v1:project-creative-brief-v2:timeline=2:document=4';

describe('Creative Brief v2 compatibility contract', () => {
  it('validates an evidence-bounded request and result through the additive index export', () => {
    const request = requestFixture();
    const result = resultFixture(request);

    expect(CREATIVE_BRIEF_V2_SCHEMA_VERSION).toBe(2);
    expect(CreativeBriefV2.validateRequest(request)).toEqual({ valid: true, errors: [] });
    expect(CreativeBriefV2.validateResult(result, request)).toEqual({ valid: true, errors: [] });
  });

  it.each([
    ['blank revision', { projectRevisionId: ' ' }],
    ['wrong project', { projectId: 'other-project' }],
    ['unknown evidence', { evidenceIds: ['missing-evidence'] }],
    ['URL content', { goal: 'Review https://private.example/project' }],
    ['secret content', { goal: 'Use api_key=sk-secret-value-123456' }],
    ['command content', { goal: 'Execute this command to change the timeline' }],
    ['command surface', { command: { type: 'timeline.removeClip' } }],
  ])('rejects unsafe or malformed request input: %s', (_label, override) => {
    const request = { ...requestFixture(), ...override };
    const validation = validateCreativeBriefV2Request(request, {
      expectedProjectId: PROJECT_ID,
      expectedProjectRevisionId: PROJECT_REVISION,
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  it('rejects stale result identity, unknown evidence, and executable output', () => {
    const request = requestFixture();
    const result = {
      ...resultFixture(request),
      projectRevisionId: 'stale-revision',
      evidenceIds: ['missing-evidence'],
      recommendations: [
        {
          id: 'recommendation-1',
          summary: 'Run this command now',
          rationale: 'api_token=sk-private-token-123456',
          confidence: 'high',
          evidenceIds: ['missing-evidence'],
          tool: 'timeline.removeClip',
        },
      ],
    };

    const validation = validateCreativeBriefV2Result(result, request);
    expect(validation.valid).toBe(false);
    expect(validation.errors.join('\n')).toMatch(
      /revision|unknown evidence|command|credential|tool/i,
    );
  });

  it('rejects snapshot/intelligence project or revision parity failures', () => {
    const request = requestFixture();
    const wrongIntelligence = intelligenceFixture(request.snapshot, {
      projectId: 'other-project',
      snapshotRevision: request.snapshot.metadata.revision + 1,
    });
    const validation = validateCreativeBriefV2Request({
      ...request,
      intelligence: wrongIntelligence,
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors.join('\n')).toMatch(/projectId|snapshot revision/i);
  });

  it('labels unknown result fields as result diagnostics', () => {
    const request = requestFixture();
    const validation = validateCreativeBriefV2Result(
      { ...resultFixture(request), unexpected: true },
      request,
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('result contains unknown field unexpected');
  });
});

function requestFixture(): CreativeBriefV2Request {
  const snapshot = snapshotFixture();
  return {
    schemaVersion: 2,
    requestId: 'request-creative-brief-v2',
    projectId: PROJECT_ID,
    projectRevisionId: PROJECT_REVISION,
    goal: 'ریتم شروع را بدون تغییر لحن زیرنویس بررسی کن.',
    evidenceIds: ['clip-opening'],
    snapshot,
    intelligence: intelligenceFixture(snapshot),
  };
}

function resultFixture(request: CreativeBriefV2Request): CreativeBriefV2Result {
  return {
    schemaVersion: 2,
    requestId: request.requestId,
    projectId: request.projectId,
    projectRevisionId: request.projectRevisionId,
    summary: 'The opening duration is measurable.',
    rationale: 'The cited clip provides bounded timing evidence.',
    evidenceIds: ['clip-opening'],
    recommendations: [
      {
        id: 'recommendation-opening-pacing',
        summary: 'Consider a shorter opening pause.',
        rationale: 'The opening clip is eight seconds long.',
        confidence: 'medium',
        evidenceIds: ['clip-opening'],
      },
    ],
    warnings: [],
  };
}

function snapshotFixture(): SemanticSnapshotV1 {
  return createSemanticSnapshotV1(
    [
      {
        id: 'timeline',
        label: 'Timeline',
        domain: 'timeline',
        evidence: [
          {
            id: 'clip-opening',
            kind: 'clip',
            label: 'Opening clip',
            summary: 'Opening clip lasts eight seconds.',
            sourceEntityId: 'clip-1',
            sourceEntityRevision: 1,
            startUs: 0,
            durationUs: 8_000_000,
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

function intelligenceFixture(
  snapshot: SemanticSnapshotV1,
  override: { readonly projectId?: string; readonly snapshotRevision?: number } = {},
): SemanticIntelligenceV1 {
  const finding: IntelligenceFindingV1 = {
    id: 'finding-opening-duration',
    category: 'timing',
    severity: 'notice',
    title: 'Opening duration',
    description: 'The opening clip lasts eight seconds.',
    evidenceIds: ['clip-opening'],
    evidenceKind: 'clip',
  };
  return createSemanticIntelligenceV1([finding], [], {
    projectId: override.projectId ?? snapshot.metadata.projectId,
    snapshotRevision: override.snapshotRevision ?? snapshot.metadata.revision,
    createdBy: 'test',
    contentHash: 'intelligence-hash',
  });
}
