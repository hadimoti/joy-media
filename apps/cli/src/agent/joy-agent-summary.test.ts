import { describe, expect, it } from 'vitest';
import { truthfulAgentSummary } from './joy-agent.js';

describe('truthfulAgentSummary', () => {
  it('maps applied operations by id when an earlier proposal failed', () => {
    const summary = truthfulAgentSummary({
      applyRequested: true,
      applied: true,
      appliedCount: 1,
      appliedOperationIds: ['third-op'],
      errors: [],
      notes: [],
      staged: {
        timelineOps: [
          { kind: 'remove', id: 'first-op', clipId: 'missing', dependsOn: [] },
          { kind: 'remove', id: 'middle-op', clipId: 'also-missing', dependsOn: [] },
          { kind: 'remove', id: 'third-op', clipId: 'present', dependsOn: [] },
        ],
        documentOps: [],
      },
    });

    expect(summary).toBe('Applied 1 change(s): remove (third-op).');
  });
});
