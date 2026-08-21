import type { SemanticIntelligenceV1, SemanticSnapshotV1 } from '@joy-media/project-schema';
import type {
  CreativeAssumptionV1,
  CreativeBlockerV1,
  CreativeBriefRequestV1,
  CreativeBriefV1,
  CreativeFactV1,
  CreativeInferenceV1,
  CreativeRecommendationV1,
  CreativeTimeRangeV1,
  HumanDecisionV1,
} from './creative-brief.js';

export interface BoundedModelInputV1 {
  readonly snapshot: SemanticSnapshotV1;
  readonly intelligence: SemanticIntelligenceV1;
  readonly request: CreativeBriefRequestV1;
}

export interface StructuredModelOutputV1 {
  readonly brief: CreativeBriefV1;
}

export interface CreativeModelAdapter {
  createBrief(input: BoundedModelInputV1): Promise<StructuredModelOutputV1>;
}

export type FakeModelAdapterMode =
  'valid' | 'malformed' | 'unsafe' | 'excessive' | 'empty' | 'timeout';

export interface FakeModelAdapterOptions {
  readonly mode?: FakeModelAdapterMode;
}

function hashString(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index++) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function deterministicUuid(seed: string): string {
  const material = [
    hashString(`${seed}:0`),
    hashString(`${seed}:1`),
    hashString(`${seed}:2`),
    hashString(`${seed}:3`),
  ].join('');
  return [
    material.slice(0, 8),
    material.slice(8, 12),
    `4${material.slice(13, 16)}`,
    `8${material.slice(17, 20)}`,
    material.slice(20, 32),
  ].join('-');
}

function firstEvidenceId(input: BoundedModelInputV1): string {
  const firstFindingEvidence = input.intelligence.findings[0]?.evidenceIds[0];
  return firstFindingEvidence ?? input.snapshot.evidenceIds[0] ?? 'missing-evidence';
}

function boundedRangeForEvidence(
  input: BoundedModelInputV1,
  evidenceId: string,
): CreativeTimeRangeV1 {
  const evidence = input.snapshot.evidenceIndex.get(evidenceId);
  const evidenceStartUs = evidence?.startUs ?? 0;
  const evidenceDurationUs = Math.max(1, evidence?.durationUs ?? 1_000_000);
  const evidenceEndUs = evidenceStartUs + evidenceDurationUs;
  const requestRange = input.request.scope.boundedRangeUs;

  if (requestRange !== undefined) {
    const requestEndUs = requestRange.startUs + requestRange.durationUs;
    const startUs = Math.max(evidenceStartUs, requestRange.startUs);
    const endUs = Math.min(evidenceEndUs, requestEndUs);
    if (endUs > startUs) {
      return {
        startUs,
        durationUs: endUs - startUs,
      };
    }
  }

  return {
    startUs: evidenceStartUs,
    durationUs: evidenceDurationUs,
  };
}

function factsFromIntelligence(intelligence: SemanticIntelligenceV1): readonly CreativeFactV1[] {
  return intelligence.findings.map((finding) => ({
    source: 's2',
    findingId: finding.id,
    title: finding.title,
    description: finding.description,
    evidenceReferences: finding.evidenceIds,
    category: finding.category,
    severity: finding.severity,
  }));
}

function validBrief(input: BoundedModelInputV1): CreativeBriefV1 {
  const evidenceId = firstEvidenceId(input);
  const range = boundedRangeForEvidence(input, evidenceId);
  const seed = `${input.request.requestId}:${input.snapshot.metadata.revision}:${input.intelligence.metadata.revision}`;
  const firstConstraint = input.request.constraints[0]?.text;

  const inferences: readonly CreativeInferenceV1[] = [
    {
      id: deterministicUuid(`${seed}:inference`),
      source: 'model',
      inference: `The opening can likely feel tighter while preserving the requested goal: ${input.request.goal}`,
      evidenceReferences: [evidenceId],
      confidence: 'medium',
    },
  ];

  const assumptions: readonly CreativeAssumptionV1[] =
    firstConstraint === undefined
      ? []
      : [
          {
            id: deterministicUuid(`${seed}:assumption`),
            text: firstConstraint,
            evidenceReferences: [],
          },
        ];

  const recommendations: readonly CreativeRecommendationV1[] = [
    {
      id: deterministicUuid(`${seed}:recommendation`),
      kind: 'pacing-adjustment',
      confidence: 'medium',
      evidenceReferences: [evidenceId],
      boundedRangeUs: range,
      rationale: `Use S1 evidence ${evidenceId} to evaluate a bounded pacing adjustment for: ${input.request.goal}`,
      expectedBenefit: 'A clearer, tighter opening without applying any edit.',
      riskClassification: 'low',
      proposedIntent: {
        label: 'Review pacing only',
        summary: 'Read-only recommendation; conversion to an edit plan is out of scope.',
        boundedRangeUs: range,
      },
    },
  ];

  return {
    snapshotRevision: input.snapshot.metadata.revision,
    intelligenceRevision: input.intelligence.metadata.revision,
    requestId: input.request.requestId,
    interpretedGoal: input.request.goal,
    factualFindings: factsFromIntelligence(input.intelligence),
    modelInferences: inferences,
    assumptions,
    recommendations,
    blockers: [],
    humanDecisions: [],
    confidenceSummary: {
      overall: 'medium',
      rationale: 'Recommendation is bounded by S1 evidence and separated from S2 facts.',
    },
    generatedAt: input.request.createdAt,
  };
}

function emptyBrief(input: BoundedModelInputV1): CreativeBriefV1 {
  const seed = `${input.request.requestId}:empty`;
  const blockers: readonly CreativeBlockerV1[] = [
    {
      id: deterministicUuid(`${seed}:blocker`),
      reason: 'Model capability unavailable; no recommendation was fabricated.',
      evidenceReferences: [],
    },
  ];
  const humanDecisions: readonly HumanDecisionV1[] = [
    {
      id: deterministicUuid(`${seed}:decision`),
      question: 'Should a human creative reviewer provide direction for this goal?',
      options: ['Request human review', 'Revise the brief goal'],
      evidenceReferences: [],
    },
  ];

  return {
    snapshotRevision: input.snapshot.metadata.revision,
    intelligenceRevision: input.intelligence.metadata.revision,
    requestId: input.request.requestId,
    interpretedGoal: input.request.goal,
    factualFindings: factsFromIntelligence(input.intelligence),
    modelInferences: [],
    assumptions: [],
    recommendations: [],
    blockers,
    humanDecisions,
    confidenceSummary: {
      overall: 'low',
      rationale: 'No model recommendation was produced.',
    },
    generatedAt: input.request.createdAt,
  };
}

export function createFakeModelAdapter(
  options: FakeModelAdapterOptions = {},
): CreativeModelAdapter {
  const mode = options.mode ?? 'valid';

  return {
    async createBrief(input) {
      if (mode === 'timeout') {
        throw new Error('Fake model unavailable: timeout');
      }

      if (mode === 'malformed') {
        return {
          brief: { requestId: input.request.requestId },
        } as unknown as StructuredModelOutputV1;
      }

      if (mode === 'empty') {
        return { brief: emptyBrief(input) };
      }

      const brief = validBrief(input);

      if (mode === 'unsafe') {
        return {
          brief: {
            ...brief,
            recommendations: [
              {
                ...brief.recommendations[0],
                evidenceReferences: ['missing-evidence'],
                rationale: 'Unsafe output includes file://private/path and api_key=secret.',
              },
            ],
          } as CreativeBriefV1,
        };
      }

      if (mode === 'excessive') {
        return {
          brief: {
            ...brief,
            recommendations: [
              {
                ...brief.recommendations[0],
                rationale: 'x'.repeat(2_001),
              },
            ],
          } as CreativeBriefV1,
        };
      }

      return { brief };
    },
  };
}
