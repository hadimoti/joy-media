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
