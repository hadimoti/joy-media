import { describe, expect, it } from 'vitest';
import { validatePropertyAnimationOperation } from './property-animation-operations.js';

const binding = {
  ownerKind: 'visual-object',
  ownerId: 'title',
  propertyId: 'transform.x',
  timeDomain: 'composition',
} as const;

const value = {
  kind: 'scalar',
  curve: { keyframes: [{ timeUs: 0, value: 1, interpolation: 'linear' }] },
} as const;

describe('agent property animation operations', () => {
  it('accepts typed enable and remove-key operations', () => {
    expect(
      validatePropertyAnimationOperation({ type: 'enable', animation: { binding, value } }).errors,
    ).toEqual([]);
    expect(
      validatePropertyAnimationOperation({ type: 'removeKey', binding, timeUs: 0 }).operation,
    ).toEqual({
      type: 'removeKey',
      binding,
      timeUs: 0,
    });
  });

  it('rejects raw paths, unknown owners, malformed values, and invalid times', () => {
    expect(
      validatePropertyAnimationOperation({ type: 'disable', path: 'visualObjects.title.x' }).errors,
    ).toContain('raw JSON paths are not accepted; use a typed binding');
    expect(
      validatePropertyAnimationOperation({
        type: 'disable',
        binding: { ...binding, ownerKind: 'unknown' },
      }).errors,
    ).toContain('unknown owner kind');
    expect(
      validatePropertyAnimationOperation({ type: 'removeKey', binding, timeUs: -1 }).errors,
    ).toContain('removeKey timeUs must be a non-negative safe integer');
    expect(
      validatePropertyAnimationOperation({
        type: 'replace',
        binding,
        value: { kind: 'scalar', curve: { keyframes: [] } },
      }).errors.length,
    ).toBeGreaterThan(0);
  });
});
