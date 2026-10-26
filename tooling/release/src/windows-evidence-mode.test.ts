// The real-service harness's Windows evidence mode (plan section 3.4). The default is the strict check that release-candidate-v2
// keeps. release-candidate-v3 defers the check to the final gate, which requires and binds the Windows evidence itself. An unknown
// mode fails closed, so a misspelt mode can never switch the check off.
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_EVIDENCE_MODE_ENV,
  windowsEvidenceRequired,
} from '../../../ops/self-hosted/linux-runner/windows-evidence-mode.mjs';

describe('the Windows evidence mode of the real-service harness', () => {
  it('requires the Windows evidence when no mode is set, as release-candidate-v2 does', () => {
    expect(windowsEvidenceRequired({})).toBe(true);
    expect(windowsEvidenceRequired({ [WINDOWS_EVIDENCE_MODE_ENV]: '' })).toBe(true);
    expect(windowsEvidenceRequired({ [WINDOWS_EVIDENCE_MODE_ENV]: 'required' })).toBe(true);
  });

  it('defers the check only when the mode is exactly deferred', () => {
    expect(windowsEvidenceRequired({ [WINDOWS_EVIDENCE_MODE_ENV]: 'deferred' })).toBe(false);
  });

  it('fails closed on any other mode, so a typo cannot switch the check off', () => {
    expect(() => windowsEvidenceRequired({ [WINDOWS_EVIDENCE_MODE_ENV]: 'Deferred' })).toThrow(
      /unknown JOY_MEDIA_CI_WINDOWS_EVIDENCE mode/u,
    );
    expect(() => windowsEvidenceRequired({ [WINDOWS_EVIDENCE_MODE_ENV]: 'off' })).toThrow(
      /unknown JOY_MEDIA_CI_WINDOWS_EVIDENCE mode/u,
    );
  });
});
