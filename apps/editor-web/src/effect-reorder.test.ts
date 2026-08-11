import { describe, expect, it } from 'vitest';
import { effectReorderTransaction } from './effect-reorder.js';

describe('effectReorderTransaction', () => {
  it('targets one effect instance and destination index', () => {
    expect(effectReorderTransaction('object-1', 'effect-2', 0, 'Blur')).toEqual({
      label: 'Move Blur',
      commands: [
        {
          type: 'effect.reorder',
          payload: { objectId: 'object-1', effectInstanceId: 'effect-2', newIndex: 0 },
        },
      ],
    });
  });
});
