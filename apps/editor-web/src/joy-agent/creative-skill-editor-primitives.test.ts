import { describe, expect, it, vi } from 'vitest';
import { createDirectorVerificationReport } from './director-verifier.js';
import {
  buildCreativeSkillToolAllowList,
  createCreativeSkillEditorPrimitives,
  type CreativeSkillEditorPrimitiveDeps,
} from './creative-skill-editor-primitives.js';
import { getCreativeSkill } from '@joy-media/agent-tools';
import { createCreativeSkillHostAdapter } from './creative-skill-host-adapter.js';
import { createCreativeSkillRunner } from './skill-runner.js';
import { R1_EDITOR_CREATIVE_SKILL_SEAMS } from './creative-skill-runtime.js';
import { createEditorCreativeSkillRuntime } from './creative-skill-runtime.js';

const scope = { projectId: 'project-1', runId: 'run-1', epoch: 1, revision: 'revision-1' };

function report() {
  return createDirectorVerificationReport({
    projectId: 'project-1',
    revision: 'revision-1',
    checks: [
      {
        id: 'structural-1',
        method: 'structural',
        status: 'passed',
        evidenceIds: ['evidence-a'],
        summary: 'ok',
      },
    ],
  });
}

function deps(
  overrides: Partial<CreativeSkillEditorPrimitiveDeps> = {},
): CreativeSkillEditorPrimitiveDeps {
  return {
    readProjectContext: vi.fn(async () => ({ summary: 'Read overview, tracks and clips.' })),
    runScopedToolLoop: vi.fn(async () => ({
      kind: 'prepared' as const,
      changeSetId: 'change-set-1',
      operationDigest: 'a'.repeat(64),
      operationCount: 2,
      repairAttempts: 1,
    })),
    readObservationCoverage: vi.fn(async () => ({
      coverageSummary: 'Sampled 10 of 200 source frames.',
      coverageComplete: false,
      evidenceIds: ['evidence-a'],
    })),
    confirmPreviewRendered: vi.fn(async () => ({
      previewId: 'preview-1',
      rendererAcknowledged: true,
    })),
    verifyComposedAndEncoded: vi.fn(async () => ({ report: report(), summary: 'structural only' })),
    ...overrides,
  };
}

describe('buildCreativeSkillToolAllowList', () => {
  it('always includes read_project_context and adds observe/validate by manifest need', () => {
    expect(buildCreativeSkillToolAllowList(getCreativeSkill('creative-brief')!)).toEqual([
      'read_project_context',
    ]);
    expect(buildCreativeSkillToolAllowList(getCreativeSkill('watch-and-map')!)).toEqual(
      expect.arrayContaining([
        'read_project_context',
        'media_describe',
        'media_observe',
        'evidence_coverage',
      ]),
    );
    expect(buildCreativeSkillToolAllowList(getCreativeSkill('watch-and-map')!)).not.toContain(
      'validate_proposal',
    );
    const roughCut = buildCreativeSkillToolAllowList(getCreativeSkill('build-rough-cut')!);
    expect(roughCut).toContain('validate_proposal');
    expect(roughCut).toContain('media_observe');
    expect(
      buildCreativeSkillToolAllowList(getCreativeSkill('title-and-caption-polish')!),
    ).toContain('media_transcript');
  });
});

describe('createCreativeSkillEditorPrimitives', () => {
  it('runs one memoized tool-loop shared by observe and propose', async () => {
    const d = deps();
    const primitives = createCreativeSkillEditorPrimitives(d, scope);
    const skill = getCreativeSkill('build-rough-cut')!;
    await primitives.observeSources({
      skillId: skill.id,
      scope,
      signal: new AbortController().signal,
      privacyRequirement: skill.privacyRequirement,
      evidenceRequirements: skill.evidenceRequirements,
      budget: {
        maxObservationRequests: skill.budget.maxObservationRequests,
        maxEvidenceItems: skill.budget.maxEvidenceItems,
      },
    });
    await primitives.prepareChange({
      skillId: skill.id,
      scope,
      signal: new AbortController().signal,
      allowedOperationKinds: skill.requiredOperationKinds,
      maxRepairProposals: skill.budget.maxRepairProposals,
      priorSummaries: ['ctx'],
    });
    expect(d.runScopedToolLoop).toHaveBeenCalledTimes(1);
    expect(d.runScopedToolLoop).toHaveBeenCalledWith(
      expect.objectContaining({
        skillId: 'build-rough-cut',
        allowedToolNames: expect.arrayContaining(['validate_proposal', 'media_observe']),
        maxRepairProposals: 2,
      }),
    );
  });

  it('reports an edit recipe with a model answer and no proposal as unavailable', async () => {
    const primitives = createCreativeSkillEditorPrimitives(
      deps({
        runScopedToolLoop: vi.fn(async () => ({
          kind: 'answer' as const,
          text: 'Nothing to cut.',
        })),
      }),
      scope,
    );
    const skill = getCreativeSkill('build-rough-cut')!;
    const result = await primitives.prepareChange({
      skillId: skill.id,
      scope,
      signal: new AbortController().signal,
      allowedOperationKinds: skill.requiredOperationKinds,
      maxRepairProposals: skill.budget.maxRepairProposals,
      priorSummaries: [],
    });
    expect(result).toEqual({ kind: 'unavailable', reason: 'no-actionable-edit' });
  });

  it('drives a full build-rough-cut run through the shared runner to ready-for-approval', async () => {
    const d = deps();
    const primitives = createCreativeSkillEditorPrimitives(d, scope);
    const runner = createCreativeSkillRunner({
      runtime: createEditorCreativeSkillRuntime(R1_EDITOR_CREATIVE_SKILL_SEAMS),
      adapter: createCreativeSkillHostAdapter(primitives),
      isAuthorityCurrent: () => true,
    });
    const result = await runner.run({ skillId: 'build-rough-cut', scope });
    expect(result.kind).toBe('ready-for-approval');
    expect(result.artifacts.map((a) => a.kind)).toEqual([
      'context',
      'evidence',
      'prepared-change',
      'preview',
    ]);
    expect(d.runScopedToolLoop).toHaveBeenCalledTimes(1);
    expect(d.confirmPreviewRendered).toHaveBeenCalledWith(
      expect.objectContaining({ changeSetId: 'change-set-1' }),
    );
  });

  it('drives a find-moment run to a cited coverage answer with no prepared change', async () => {
    const d = deps({
      runScopedToolLoop: vi.fn(async () => ({ kind: 'answer' as const, text: 'Flash at 1.50s.' })),
      readObservationCoverage: vi.fn(async () => ({
        coverageSummary: 'Exhaustive scan of 90 frames.',
        coverageComplete: true,
        evidenceIds: ['flash'],
        moment: { summary: 'Single-frame flash at source 1.500s-1.533s.' },
      })),
    });
    const runner = createCreativeSkillRunner({
      runtime: createEditorCreativeSkillRuntime(R1_EDITOR_CREATIVE_SKILL_SEAMS),
      adapter: createCreativeSkillHostAdapter(createCreativeSkillEditorPrimitives(d, scope)),
      isAuthorityCurrent: () => true,
    });
    const result = await runner.run({ skillId: 'find-moment', scope });
    expect(result.kind).toBe('completed');
    expect(result.artifacts.map((a) => a.kind)).toEqual(['context', 'moment', 'verification']);
  });

  it('surfaces a failed tool-loop as a thrown adapter failure', async () => {
    const primitives = createCreativeSkillEditorPrimitives(
      deps({
        runScopedToolLoop: vi.fn(async () => ({
          kind: 'failed' as const,
          message: 'provider down',
        })),
      }),
      scope,
    );
    await expect(
      primitives.prepareChange({
        skillId: 'build-rough-cut',
        scope,
        signal: new AbortController().signal,
        allowedOperationKinds: getCreativeSkill('build-rough-cut')!.requiredOperationKinds,
        maxRepairProposals: 2,
        priorSummaries: [],
      }),
    ).rejects.toThrow();
  });

  it('fails observation before reading coverage when the scoped tool-loop fails', async () => {
    const d = deps({
      runScopedToolLoop: vi.fn(async () => ({ kind: 'failed' as const, message: 'provider down' })),
    });
    await expect(
      createCreativeSkillEditorPrimitives(d, scope).observeSources({
        skillId: 'watch-and-map',
        scope,
        signal: new AbortController().signal,
        privacyRequirement: 'local-only',
        evidenceRequirements: ['source-sampled'],
        budget: { maxObservationRequests: 2, maxEvidenceItems: 128 },
      }),
    ).rejects.toThrow('JOY_CREATIVE_SKILL_TOOL_LOOP');
    expect(d.readObservationCoverage).not.toHaveBeenCalled();
  });
});
