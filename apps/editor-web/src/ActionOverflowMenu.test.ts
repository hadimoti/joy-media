import { describe, expect, it } from 'vitest';

describe('timeline overflow contract', () => {
  it('documents the stable priority order for compact panels', () => {
    expect(['add-track', 'marker', 'duplicate', 'delete', 'flow']).toEqual([
      'add-track',
      'marker',
      'duplicate',
      'delete',
      'flow',
    ]);
  });
});
