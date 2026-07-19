import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index.js';

describe('@joy-media/test-fixtures scaffold', () => {
  it('exports its package name', () => {
    expect(PACKAGE_NAME).toBe('@joy-media/test-fixtures');
  });
});
