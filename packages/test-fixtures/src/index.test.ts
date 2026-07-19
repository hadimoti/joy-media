import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME, REFERENCE_PROJECT } from './index.js';

describe('@joy-media/test-fixtures scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@joy-media/test-fixtures');
  });
  it('provides a 30-second dual-format social-edit acceptance fixture', () => {
    expect(REFERENCE_PROJECT.durationUs).toBe(30_000_000);
    expect(REFERENCE_PROJECT.formats).toEqual([
      { width: 1920, height: 1080 },
      { width: 1080, height: 1920 },
    ]);
  });
});
