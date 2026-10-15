// F7 (CLI half): a timeout must read as a timeout with the limit, not JOY_AGENT_UNKNOWN.
import { describe, expect, it } from 'vitest';
import { JoyAgentRunError } from '@joy-media/joy-agent-engine';
import { formatAgentRunFailure } from './agent-cmd.js';

describe('F7: timeout message', () => {
  it('names the wall-time limit', () => {
    const error = new JoyAgentRunError('JOY_AGENT_TIMEOUT', {
      detail: {
        name: 'JoyAgentTimeout',
        message: 'no complete answer within 180 s',
        responseBodySnippet: '',
      },
    } as never);
    expect(formatAgentRunFailure(error, false)).toMatch(/JOY_AGENT_TIMEOUT \(.*180 s/);
  });
});
