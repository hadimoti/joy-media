import { describe, expect, it } from 'vitest';
import { legacyRecipeExecutionEnabled } from './AgentPanel.js';

describe('AgentPanel durable execution boundary', () => {
  it('keeps the pre-receipt deterministic recipe executor permanently disabled', () => {
    expect(legacyRecipeExecutionEnabled()).toBe(false);
  });
});
