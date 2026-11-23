/**
 * Creative Brief model-facing contract tests - v1.1.2 reliability fix.
 *
 * Pure and offline: no provider call, no network, no persistence.
 */

import { describe, it, expect } from 'vitest';

import {
  buildCreativeBriefModelContract,
  buildCreativeBriefModelPrompt,
  completeCreativeBriefFromModelOutput,
  CreativeBriefContractError,
  CREATIVE_BRIEF_MODEL_PROMPT_MAX_CHARS,
  CREATIVE_BRIEF_MODEL_REQUEST_MAX_CHARS,
  CREATIVE_BRIEF_REQUEST_TRUNCATED_CODE,
} from './creative-brief-contract.js';
import { containsForbiddenPattern, validateCreativeBrief } from './creative-brief.js';

const PROJECT_ID = 'project-1';
const REVISION_ID = 'rev-1';
const REQUEST = 'Improve the pacing of my reel';

function modelAnswer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    snapshotRevisionId: REVISION_ID,
    projectId: PROJECT_ID,
    request: REQUEST,
    interpretedGoal: {
      userIntent: REQUEST,
      inferredGoal: 'The reel loses attention before the payoff.',
      resolvedGoal: 'Tighten the opening scene and hold the beat.',
      confidence: 'medium',
    },
    distinction: { facts: [], inferences: [] },
    assumptions: [],
    recommendations: [
      {
        id: 'pacing-001',
        kind: 'pacing',
        confidence: 'medium',
        evidence: [],
        rationale: 'The opening scene runs long.',
        expectedBenefit: 'Better retention in the first seconds.',
        risk: 'none',
        scope: {},
      },
    ],
    blockedBy: [],
    requiresHumanDecision: [],
    intelligence: { brand: {}, scenes: [], project: {}, rules: [] },
    warnings: [],
    ...overrides,
  };
}

describe('Creative Brief model contract', () => {
  it('carries the exact project and revision bindings of the request', () => {
    const contract = buildCreativeBriefModelContract({
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
      request: REQUEST,
    });
    expect(contract.echo.projectId).toBe(PROJECT_ID);
    expect(contract.echo.snapshotRevisionId).toBe(REVISION_ID);
    expect(contract.echo.request).toBe(REQUEST);
    expect(contract.echo.schemaVersion).toBe(1);
  });

  it('describes every field the validator requires, with the allowed enums', () => {
    const contract = buildCreativeBriefModelContract({
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
      request: REQUEST,
    });
    for (const field of [
      'interpretedGoal',
      'distinction',
      'assumptions',
      'recommendations',
      'blockedBy',
      'requiresHumanDecision',
      'intelligence',
      'warnings',
    ])
      expect(Object.keys(contract.fields)).toContain(field);
    expect(JSON.stringify(contract)).toContain('pacing');
    expect(JSON.stringify(contract)).toContain('reversible-local');
    expect(JSON.stringify(contract)).toContain('low|medium|high');
  });

  it('keeps the prompt bounded and free of forbidden patterns', () => {
    const prompt = buildCreativeBriefModelPrompt({
      request: REQUEST,
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
    });
    expect(prompt.length).toBeLessThanOrEqual(CREATIVE_BRIEF_MODEL_PROMPT_MAX_CHARS);
    expect(prompt.length).toBeLessThanOrEqual(8_000);
    expect(containsForbiddenPattern(prompt)).toBe(false);
  });

  it('states the exact bindings and the required field names in the prompt', () => {
    const prompt = buildCreativeBriefModelPrompt({
      request: REQUEST,
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
    });
    expect(prompt).toContain(PROJECT_ID);
    expect(prompt).toContain(REVISION_ID);
    expect(prompt).toContain(REQUEST);
    for (const field of ['interpretedGoal', 'distinction', 'recommendations', 'intelligence'])
      expect(prompt).toContain(field);
    expect(prompt).toContain('read-only');
  });

  it('truncates an oversized request instead of the contract', () => {
    const prompt = buildCreativeBriefModelPrompt({
      request: 'A'.repeat(CREATIVE_BRIEF_MODEL_REQUEST_MAX_CHARS + 500),
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
    });
    expect(prompt.length).toBeLessThanOrEqual(CREATIVE_BRIEF_MODEL_PROMPT_MAX_CHARS);
    expect(prompt).toContain('interpretedGoal');
  });

  it('keeps the complete contract when a request expands during JSON escaping', () => {
    const request = String.fromCharCode(34, 92, 10, 0) + '🎬';
    const prompt = buildCreativeBriefModelPrompt({
      request: request.repeat(700),
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
    });
    expect(prompt.length).toBeLessThanOrEqual(CREATIVE_BRIEF_MODEL_PROMPT_MAX_CHARS);
    const json = prompt.split('\nCONTRACT (binding, version 1):\n')[1]?.split('\n\nRULES:')[0];
    expect(json).toBeDefined();
    const { echo } = JSON.parse(json!);
    expect(echo).toMatchObject({ projectId: PROJECT_ID, requestTruncated: true });
    expect(echo.request).not.toContain('\ufffd');
    expect(echo.request).not.toMatch(/[\ud800-\udbff]$/);
    expect(prompt).toMatch(/Answer with the JSON object only\.$/);
  });
});

describe('completeCreativeBriefFromModelOutput', () => {
  it('completes a contract answer into a brief that passes independent validation', () => {
    const brief = completeCreativeBriefFromModelOutput({
      output: modelAnswer(),
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
      request: REQUEST,
      generatedAt: '2026-11-23T00:00:00.000Z',
    });
    const validation = validateCreativeBrief(brief);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(brief.projectId).toBe(PROJECT_ID);
    expect(brief.snapshotRevisionId).toBe(REVISION_ID);
    expect(brief.meta.generatedAt).toBe('2026-11-23T00:00:00.000Z');
    expect(brief.meta.processingTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('rejects a brief bound to another project or revision', () => {
    expect(() =>
      completeCreativeBriefFromModelOutput({
        output: modelAnswer({ projectId: 'project-2' }),
        projectId: PROJECT_ID,
        revisionId: REVISION_ID,
        request: REQUEST,
      }),
    ).toThrow(CreativeBriefContractError);
    expect(() =>
      completeCreativeBriefFromModelOutput({
        output: modelAnswer({ snapshotRevisionId: 'rev-2' }),
        projectId: PROJECT_ID,
        revisionId: REVISION_ID,
        request: REQUEST,
      }),
    ).toThrow(CreativeBriefContractError);
  });

  it('rejects an answer that is not a JSON object', () => {
    expect(() =>
      completeCreativeBriefFromModelOutput({
        output: 'not json',
        projectId: PROJECT_ID,
        revisionId: REVISION_ID,
        request: REQUEST,
      }),
    ).toThrow(CreativeBriefContractError);
  });

  it('leaves a model answer without the interpreted goal to the independent validator', () => {
    const answer = modelAnswer();
    delete answer.interpretedGoal;
    const brief = completeCreativeBriefFromModelOutput({
      output: answer,
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
      request: REQUEST,
    });
    const validation = validateCreativeBrief(brief);
    expect(validation.valid).toBe(false);
    expect(validation.errors.some((error) => error.path === 'interpretedGoal')).toBe(true);
  });
});

describe('Creative Brief contract rejection rules', () => {
  const complete = (output: unknown, request = REQUEST) =>
    completeCreativeBriefFromModelOutput({
      output,
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
      request,
    });

  it('rejects an explicitly supplied null, blank or non-string binding instead of stamping it', () => {
    for (const binding of [null, '', '   ', 123, true, { id: 'x' }]) {
      expect(() => complete(modelAnswer({ projectId: binding }))).toThrow(
        CreativeBriefContractError,
      );
      expect(() => complete(modelAnswer({ snapshotRevisionId: binding }))).toThrow(
        CreativeBriefContractError,
      );
    }
  });

  it('redacts the rejected binding value from the error', () => {
    let thrown: unknown;
    try {
      complete(modelAnswer({ projectId: 'secret-project-id' }));
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CreativeBriefContractError);
    const error = thrown as CreativeBriefContractError;
    expect(error.code).toBe('binding-mismatch');
    expect(error.field).toBe('projectId');
    expect(error.message).not.toContain('secret-project-id');
  });

  it('rejects a binding supplied for another project or revision', () => {
    expect(() => complete(modelAnswer({ projectId: 'project-2' }))).toThrow(
      CreativeBriefContractError,
    );
    expect(() => complete(modelAnswer({ snapshotRevisionId: 'rev-2' }))).toThrow(
      CreativeBriefContractError,
    );
  });

  it('stamps an absent binding with the current values', () => {
    const answer = modelAnswer();
    delete answer.projectId;
    delete answer.snapshotRevisionId;
    const brief = complete(answer);
    expect(brief.projectId).toBe(PROJECT_ID);
    expect(brief.snapshotRevisionId).toBe(REVISION_ID);
    expect(validateCreativeBrief(brief).valid).toBe(true);
  });

  it('keeps a malformed authored list for the independent validator', () => {
    for (const field of [
      'assumptions',
      'recommendations',
      'blockedBy',
      'requiresHumanDecision',
      'warnings',
    ]) {
      const brief = complete(modelAnswer({ [field]: 'not-a-list' }));
      const validation = validateCreativeBrief(brief);
      expect(validation.valid).toBe(false);
      expect(validation.errors.some((error) => error.path === field)).toBe(true);
    }
  });

  it('keeps a missing required authored field for the independent validator', () => {
    const answer = modelAnswer();
    delete answer.interpretedGoal;
    expect(
      validateCreativeBrief(complete(answer)).errors.some((e) => e.path === 'interpretedGoal'),
    ).toBe(true);
    const withoutDistinction = modelAnswer();
    delete withoutDistinction.distinction;
    expect(
      validateCreativeBrief(complete(withoutDistinction)).errors.some(
        (e) => e.path === 'distinction',
      ),
    ).toBe(true);
  });

  it('accepts zero recommendations, as the existing validator does', () => {
    const brief = complete(modelAnswer({ recommendations: [] }));
    const validation = validateCreativeBrief(brief);
    expect(validation.errors).toEqual([]);
    expect(validation.valid).toBe(true);
    expect(brief.recommendations).toEqual([]);
  });

  it('always records the exact trusted request, never a rewritten one', () => {
    const brief = complete(modelAnswer({ request: 'make it look like a cat video' }));
    expect(brief.request).toBe(REQUEST);
  });

  it('reports a shortened request in the prompt and in the brief', () => {
    const long = 'B'.repeat(4_000);
    const prompt = buildCreativeBriefModelPrompt({
      request: long,
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
    });
    expect(prompt).toContain('shortened');
    const brief = completeCreativeBriefFromModelOutput({
      output: modelAnswer(),
      projectId: PROJECT_ID,
      revisionId: REVISION_ID,
      request: long,
    });
    const warnings = brief.warnings as readonly { code: string; severity: string }[];
    expect(warnings.some((warning) => warning.code === CREATIVE_BRIEF_REQUEST_TRUNCATED_CODE)).toBe(
      true,
    );
    expect(validateCreativeBrief(brief).valid).toBe(true);
  });
});
