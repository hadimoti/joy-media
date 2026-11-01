import { describe, expect, it } from 'vitest';
import {
  isMainToWorkerMessage,
  isWorkerToMainMessage,
  JOY_AGENT_PROTOCOL_VERSION,
} from './protocol.js';

const BASE_URL = 'https://openrouter.ai/api/v1';

const providerRequest = {
  protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
  type: 'provider-request',
  requestId: 'provider-1',
  profileId: 'prof-1',
  baseUrl: BASE_URL,
  modelId: 'openai/gpt-4o-mini',
  body: { messages: [{ role: 'user', content: 'hi' }] },
};

describe('provider messages on the agent protocol', () => {
  it('accepts a well-formed provider request from the Worker', () => {
    expect(isWorkerToMainMessage(providerRequest)).toBe(true);
  });

  it('refuses a provider request with an extra field, a missing URL, or a non-object body', () => {
    expect(isWorkerToMainMessage({ ...providerRequest, apiKey: 'sk-test' })).toBe(false);
    expect(isWorkerToMainMessage({ ...providerRequest, baseUrl: undefined })).toBe(false);
    expect(isWorkerToMainMessage({ ...providerRequest, body: [] })).toBe(false);
    expect(isWorkerToMainMessage({ ...providerRequest, requestId: 'bad id with spaces' })).toBe(
      false,
    );
  });

  it('refuses a provider request body larger than the largest legal observation batch', () => {
    const oversized = { messages: [{ role: 'user', content: 'x'.repeat(32 * 1024 * 1024) }] };
    expect(isWorkerToMainMessage({ ...providerRequest, body: oversized })).toBe(false);
  });

  it('accepts a provider cancel that names a request, and refuses any other field', () => {
    const cancel = {
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'provider-cancel',
      requestId: 'provider-1',
    };
    expect(isWorkerToMainMessage(cancel)).toBe(true);
    expect(isWorkerToMainMessage({ ...cancel, body: {} })).toBe(false);
    expect(isWorkerToMainMessage({ ...cancel, requestId: 'bad id with spaces' })).toBe(false);
  });

  it('counts UTF-8 bytes: 12 Mi Chinese characters are 36 MiB and are refused', () => {
    // Under 32 Mi characters, so a character count would accept it. In UTF-8 it is over the limit.
    const oversized = { messages: [{ role: 'user', content: '界'.repeat(12 * 1024 * 1024) }] };
    expect(isWorkerToMainMessage({ ...providerRequest, body: oversized })).toBe(false);
  });

  it('accepts a provider response from the main thread, a reply or a code, and nothing else', () => {
    const response = {
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'provider-response',
      requestId: 'provider-1',
    };
    expect(isMainToWorkerMessage({ ...response, result: { ok: true, text: '{}' } })).toBe(true);
    expect(
      isMainToWorkerMessage({
        ...response,
        result: {
          ok: false,
          code: 'AUTH_FAILED',
          message: 'The provider rejected the credentials.',
        },
      }),
    ).toBe(true);
    expect(isMainToWorkerMessage({ ...response, result: { ok: true } })).toBe(false);
    expect(
      isMainToWorkerMessage({ ...response, result: { ok: true, text: '{}', apiKey: 'sk-test' } }),
    ).toBe(false);
  });

  it('accepts a session config that names a profile, and refuses one that carries a key', () => {
    const configure = (config: Record<string, unknown>) => ({
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'configure',
      config,
    });
    const config = {
      provider: 'openrouter',
      baseUrl: BASE_URL,
      modelId: 'openrouter/free',
      profileId: 'prof-1',
    };
    expect(isMainToWorkerMessage(configure(config))).toBe(true);
    expect(isMainToWorkerMessage(configure({ ...config, apiKey: 'sk-test' }))).toBe(false);
    expect(isMainToWorkerMessage(configure({ ...config, profileId: undefined }))).toBe(false);
  });
});
