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

  it('#6: says the limit was hit, nothing was applied, and to retry with a smaller request', () => {
    const error = new JoyAgentRunError('JOY_AGENT_TIMEOUT', {
      detail: {
        name: 'JoyAgentTimeout',
        message: 'timeout: no complete answer within 300 s',
        responseBodySnippet: '',
      },
    } as never);
    const text = formatAgentRunFailure(error, false);
    expect(text).toMatch(/time limit: no complete answer from the model within 300 s/);
    expect(text).toMatch(/nothing was applied/);
    expect(text).toMatch(/smaller request/);
  });

  it('NEW-3: an error outside the engine is classified, not a bare JOY_AGENT_UNKNOWN', () => {
    const timeout = Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' });
    expect(formatAgentRunFailure(timeout, false)).toMatch(
      /^Joy Agent execution failed: JOY_AGENT_TIMEOUT \(The operation timed out; nothing was applied/,
    );
    const odd = new Error('socket hang up Bearer abc.def');
    const text = formatAgentRunFailure(odd, false);
    expect(text).toContain('Error: socket hang up Bearer [Redacted]');
    expect(text).not.toContain('abc.def');
  });
});
