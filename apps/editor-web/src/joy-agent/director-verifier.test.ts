import { describe, expect, it } from 'vitest';
import {
  createDirectorVerificationReport,
  validateDirectorVerificationReport,
} from './director-verifier.js';

describe('director verifier', () => {
  it('keeps structural, rendered, audio, model, and human evidence distinct', () => {
    const report = createDirectorVerificationReport({
      projectId: 'project-1',
      revision: 'revision-1',
      checks: [
        {
          id: 'structure',
          method: 'structural',
          status: 'passed',
          evidenceIds: ['receipt-1'],
          summary: 'Prepared transaction matches the frozen revision.',
        },
        {
          id: 'render',
          method: 'rendered',
          status: 'passed',
          evidenceIds: ['composition-frame-1'],
          summary: 'Required title pixels are present.',
        },
        {
          id: 'audio',
          method: 'audio-measured',
          status: 'unavailable',
          evidenceIds: [],
          summary: 'No approved encoded audio measurement is available.',
          uncertainty: 'Audio verification remains unavailable.',
        },
      ],
    });
    expect(report.overall).toBe('incomplete');
    expect(report.checks.map((check) => check.method)).toEqual([
      'structural',
      'rendered',
      'audio-measured',
    ]);
    expect(validateDirectorVerificationReport(report)).toEqual({ valid: true, errors: [] });
  });

  it('never treats a model opinion or human approval as a rendered/export verification', () => {
    const report = createDirectorVerificationReport({
      projectId: 'project-1',
      revision: 'revision-1',
      checks: [
        {
          id: 'model-review',
          method: 'model-reviewed',
          status: 'passed',
          evidenceIds: ['frame-1'],
          summary: 'The model describes the supplied evidence.',
          uncertainty: 'Model interpretation is not guaranteed.',
        },
        {
          id: 'owner-review',
          method: 'user-approved',
          status: 'passed',
          evidenceIds: ['approval-1'],
          summary: 'Owner approved the proposed change.',
        },
      ],
    });
    expect(report.overall).toBe('incomplete');
    expect(report.checks.every((check) => check.method !== 'encoded-output')).toBe(true);
  });

  it('rejects success claims without evidence, unsafe text, or a required uncertainty label', () => {
    expect(
      validateDirectorVerificationReport({
        version: 1,
        projectId: 'project-1',
        revision: 'revision-1',
        overall: 'verified',
        checks: [
          {
            id: 'model',
            method: 'model-reviewed',
            status: 'passed',
            evidenceIds: [],
            summary: 'Trust me',
          },
        ],
      }),
    ).toMatchObject({ valid: false });
    expect(
      validateDirectorVerificationReport({
        version: 1,
        projectId: 'project-1',
        revision: 'revision-1',
        overall: 'verified',
        checks: [
          {
            id: 'render',
            method: 'rendered',
            status: 'passed',
            evidenceIds: ['frame-1'],
            summary: 'Upload https://example.invalid/raw.mp4',
          },
        ],
      }),
    ).toMatchObject({ valid: false });
  });
});
