import type { JoyAgentRunIterator } from './engine-client.js';
import { JOY_AGENT_PROTOCOL_VERSION, type JoyAgentSafeEvent } from './protocol.js';

const FALLBACK_CODES = new Set([
  'JOY_AGENT_AUTH_FAILED',
  'JOY_AGENT_RATE_LIMITED',
  'JOY_AGENT_MODEL_NOT_FOUND',
  'JOY_AGENT_UPSTREAM_UNAVAILABLE',
  'JOY_AGENT_CORS_OR_NETWORK',
  'JOY_AGENT_TIMEOUT',
]);

/** Proxies one run and switches providers only while the primary has produced no result. */
export function createFallbackRunIterator(
  primary: JoyAgentRunIterator,
  startFallback: () => JoyAgentRunIterator,
  cancelPrimary: (runId: string) => void | Promise<void>,
): JoyAgentRunIterator {
  let active = primary;
  let fallbackStarted = false;
  let outputStarted = false;
  let seq = -1;
  let terminalFailure: JoyAgentSafeEvent | undefined;
  let closed = false;

  const resequence = (event: JoyAgentSafeEvent): JoyAgentSafeEvent => ({ ...event, seq: ++seq });
  const switchToFallback = async (): Promise<JoyAgentSafeEvent> => {
    fallbackStarted = true;
    await cancelPrimary(primary.run.runId);
    await primary.return?.();
    active = startFallback();
    return resequence({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      runId: active.run.runId,
      runEpoch: active.run.epoch,
      seq: 0,
      at: new Date().toISOString(),
      phase: 'thinking',
      message: 'Primary provider failed; switching to fallback.',
    });
  };

  const iterator: JoyAgentRunIterator = {
    get run() {
      return active.run;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
    async next(): Promise<IteratorResult<JoyAgentSafeEvent>> {
      if (closed) return { value: undefined, done: true };
      try {
        const result = await active.next();
        if (result.done) return result;
        const event = result.value;
        if (
          active === primary &&
          !outputStarted &&
          event.errorCode !== undefined &&
          FALLBACK_CODES.has(event.errorCode)
        ) {
          const activity = await switchToFallback();
          return { value: activity, done: false };
        }
        if (
          event.proposal !== undefined ||
          event.result !== undefined ||
          event.phase === 'completed'
        )
          outputStarted = true;
        return { value: resequence(event), done: false };
      } catch (error) {
        if (active === primary && !outputStarted && !fallbackStarted) {
          const activity = await switchToFallback();
          return { value: activity, done: false };
        }
        if (active !== primary && !closed) {
          closed = true;
          terminalFailure = resequence({
            protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
            runId: active.run.runId,
            runEpoch: active.run.epoch,
            seq: 0,
            at: new Date().toISOString(),
            phase: 'failed',
            errorCode: 'JOY_AGENT_UNKNOWN',
            message: 'Fallback provider failed.',
          });
          return { value: terminalFailure, done: false };
        }
        throw error;
      }
    },
    async return(): Promise<IteratorResult<JoyAgentSafeEvent>> {
      await active.return?.();
      return { value: undefined, done: true };
    },
  };
  return iterator;
}
