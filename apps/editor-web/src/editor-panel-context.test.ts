import { describe, expect, it } from 'vitest';
import { currentMissingMediaReviewRequested } from './editor-panel-context.js';

describe('editor panel live values', () => {
  it('prefers the current missing-media review request over a captured value', () => {
    expect(currentMissingMediaReviewRequested(true, false)).toBe(true);
  });
});
