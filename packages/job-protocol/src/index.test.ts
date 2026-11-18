import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, QC_FILE_FINDING_TYPES } from './index.js';

describe('@joy-media/job-protocol scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@joy-media/job-protocol');
  });

  it('exports the audio and video length check', () => {
    expect(QC_FILE_FINDING_TYPES).toContain('av-length-mismatch');
  });
});
