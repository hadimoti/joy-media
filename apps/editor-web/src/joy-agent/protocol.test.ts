import { describe, expect, it } from 'vitest';
import {
  isMainToWorkerMessage,
  isWorkerToMainMessage,
  JOY_AGENT_PROTOCOL_VERSION,
} from './protocol.js';

const digest = 'a'.repeat(64);
const proposal = {
  summary: 'Move the selected clip',
  baseRevision: 'revision-1',
  changeSetId: 'change-set-1',
  operationDigest: digest,
  bindingDigest: 'b'.repeat(64),
  operationCount: 1,
};

const safeEvent = {
  protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
  runId: 'run-1',
  runEpoch: 1,
  seq: 1,
  at: '2026-09-05T00:00:00.000Z',
  phase: 'previewing',
};

describe('JOY Agent Worker protocol V2', () => {
  it('rejects cached V1 envelopes and requires an epoch on every run', () => {
    expect(isWorkerToMainMessage({ protocolVersion: 1, type: 'event', event: safeEvent })).toBe(
      false,
    );
    expect(
      isMainToWorkerMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'run',
        request: { runId: 'run-1', prompt: 'trim it', mode: 'tool-loop' },
      }),
    ).toBe(false);
    expect(
      isMainToWorkerMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'run',
        request: { runId: 'run-1', runEpoch: 0, prompt: 'trim it', mode: 'tool-loop' },
      }),
    ).toBe(false);
    expect(
      isMainToWorkerMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'run',
        request: { runId: 'run-1', runEpoch: 1.5, prompt: 'trim it', mode: 'tool-loop' },
      }),
    ).toBe(false);
  });

  it('allows bounded plan-only context but blocks secrets, URLs, paths, and structured context', () => {
    const base = {
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'run' as const,
      request: {
        runId: 'brief-1',
        runEpoch: 1,
        taskKind: 'creative-brief' as const,
        prompt: 'write a brief',
        mode: 'plan-only' as const,
      },
    };
    expect(
      isMainToWorkerMessage({
        ...base,
        request: { ...base.request, context: { projectId: 'project-1', revision: 'revision-1' } },
      }),
    ).toBe(true);
    for (const context of [
      { secret: 'value' },
      { note: 'Bearer abcdefghijklmnopqrstuvwxyz' },
      { note: 'https://example.invalid/private' },
      { note: 'C:\\Users\\owner\\Desktop\\secret.txt' },
    ])
      expect(isMainToWorkerMessage({ ...base, request: { ...base.request, context } })).toBe(false);
    expect(
      isMainToWorkerMessage({
        ...base,
        request: { ...base.request, mode: 'tool-loop', context: { projectId: 'project-1' } },
      }),
    ).toBe(false);
  });

  it('accepts only a closed, context-rooted host tool subset for structured runs', () => {
    const base = {
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'run' as const,
      request: {
        runId: 'tools-1',
        runEpoch: 1,
        taskKind: 'joy-code' as const,
        prompt: 'inspect the intro',
        mode: 'tool-loop' as const,
      },
    };
    expect(
      isMainToWorkerMessage({
        ...base,
        request: {
          ...base.request,
          allowedToolNames: ['read_project_context', 'media_describe', 'media_observe'],
        },
      }),
    ).toBe(true);
    for (const allowedToolNames of [
      ['media_describe'],
      ['read_project_context', 'media_describe', 'media_describe'],
      ['read_project_context', 'evidence_clear'],
    ])
      expect(
        isMainToWorkerMessage({ ...base, request: { ...base.request, allowedToolNames } }),
      ).toBe(false);
    expect(
      isMainToWorkerMessage({
        ...base,
        request: {
          ...base.request,
          taskKind: 'creative-brief',
          mode: 'plan-only',
          allowedToolNames: ['read_project_context'],
        },
      }),
    ).toBe(false);
  });

  it('accepts opaque prepared proposals only and rejects provider operations or unsafe display data', () => {
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'event',
        event: { ...safeEvent, proposal },
      }),
    ).toBe(true);
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'event',
        event: {
          ...safeEvent,
          proposal: { ...proposal, operations: [{ id: 'provider-operation' }] },
        },
      }),
    ).toBe(false);
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'event',
        event: { ...safeEvent, result: { text: 'https://secret.invalid/value' } },
      }),
    ).toBe(false);
    // Ordinary prose that merely contains denylisted key words as substrings
    // (path, secret, url, authorization) must not be rejected: the denylist
    // guards object keys, and unsafe value patterns are matched separately.
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'event',
        event: {
          ...safeEvent,
          proposal: {
            ...proposal,
            summary: 'Follow the path of the hero through the authorization arc',
          },
        },
      }),
    ).toBe(true);
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'event',
        event: {
          ...safeEvent,
          result: { headline: 'The secret path to a better url', note: 'no credential needed' },
        },
      }),
    ).toBe(true);
  });

  it('separates directional host RPC envelopes', () => {
    const request = {
      protocolVersion: 1 as const,
      type: 'host-rpc-request' as const,
      requestId: 'rpc-1',
      runId: 'run-1',
      runEpoch: 1,
      method: 'read_project_context',
      arguments: {},
      deadlineMs: 100,
    };
    const response = {
      protocolVersion: 1 as const,
      type: 'host-rpc-response' as const,
      requestId: 'rpc-1',
      runId: 'run-1',
      runEpoch: 1,
      method: 'read_project_context',
      ok: true as const,
      result: { projectId: 'project-1' },
    };
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'host-rpc',
        message: request,
      }),
    ).toBe(true);
    expect(
      isMainToWorkerMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'host-rpc',
        message: response,
      }),
    ).toBe(true);
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'host-rpc',
        message: response,
      }),
    ).toBe(false);
    expect(
      isMainToWorkerMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'host-rpc',
        message: request,
      }),
    ).toBe(false);
  });

  it('accepts only bounded public status and phase data', () => {
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'test-result',
        status: {
          provider: 'openrouter',
          modelId: 'openrouter/auto',
          capability: 'tool-loop',
        },
      }),
    ).toBe(true);
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'test-result',
        status: {
          provider: 'openrouter',
          modelId: 'openrouter/auto',
          capability: 'tool-loop',
          apiKey: 'never-forward',
        },
      }),
    ).toBe(false);
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'event',
        event: { ...safeEvent, phase: 'provider-secret' },
      }),
    ).toBe(false);
  });

  it('keeps explicit media capability probes and reports strictly redacted', () => {
    const request = {
      protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
      type: 'probe-media-capabilities' as const,
      requestId: 'media-probe-1',
    };
    expect(isMainToWorkerMessage(request)).toBe(true);
    expect(isMainToWorkerMessage({ ...request, prompt: 'never accepted' })).toBe(false);
    expect(
      isWorkerToMainMessage({
        protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
        type: 'media-capability-result',
        requestId: 'media-probe-1',
        report: {
          modelId: 'openrouter/example',
          image: 'supported',
          audio: 'unavailable',
          video: 'supported',
          modalities: ['image', 'video'],
        },
      }),
    ).toBe(true);

    for (const report of [
      {
        modelId: 'openrouter/example',
        image: 'supported',
        audio: 'unavailable',
        video: 'supported',
        modalities: ['video', 'image'],
      },
      {
        modelId: 'sk-owner-secret-must-not-appear',
        image: 'unavailable',
        audio: 'unavailable',
        video: 'unavailable',
        modalities: [],
      },
      {
        modelId: 'openrouter/example',
        image: 'unavailable',
        audio: 'unavailable',
        video: 'unavailable',
        modalities: [],
        rawProviderBody: 'never-forward',
      },
    ])
      expect(
        isWorkerToMainMessage({
          protocolVersion: JOY_AGENT_PROTOCOL_VERSION,
          type: 'media-capability-result',
          requestId: 'media-probe-1',
          report,
        }),
      ).toBe(false);
  });
});
