import { describe, expect, it, vi } from 'vitest';
import { createEvidenceStore } from '../media-observation/evidence-store.js';
import {
  createMultimodalTransport,
  type MultimodalFetch,
  type ObservationEvidencePayload,
} from './multimodal-transport.js';
import { issueObservationConsent, type ObservationMediaCapability } from './observation-consent.js';
import type { JoyAgentObservationHostBridge } from './observation-tool-adapter.js';
import {
  createObservationReviewController,
  type ObservationReviewHostTransfer,
  type ObservationReviewHostTransferFactoryInput,
  type ObservationReviewPreparation,
} from './observation-review-controller.js';
import {
  createObservationTransferService,
  type ObservationTransferAuthority,
  type ObservationTransferServiceResult,
} from './observation-transfer-service.js';

const sourceRange = Object.freeze({ domain: 'source' as const, startUs: 0, endUs: 1_000_000 });
const imageCapability: ObservationMediaCapability = Object.freeze({
  modelId: 'openrouter/model-a',
  modalities: Object.freeze(['image'] as const),
});

function authority(
  overrides: Partial<ObservationTransferAuthority> = {},
): ObservationTransferAuthority {
  return Object.freeze({
    projectId: 'project-1',
    revision: 'revision-1',
    run: Object.freeze({ runId: 'run-1', epoch: 1 }),
    modelId: 'openrouter/model-a',
    promptPolicyDigest: 'policy-1',
    ...overrides,
  });
}

function manifest(scope: ObservationTransferAuthority = authority()) {
  return Object.freeze({
    manifestId: 'manifest-1',
    scope: Object.freeze({
      runId: scope.run.runId,
      identity: Object.freeze({
        projectId: scope.projectId,
        assetDigest: 'a'.repeat(64),
        projectRevision: scope.revision,
        modelId: scope.modelId,
        promptPolicyDigest: scope.promptPolicyDigest,
      }),
    }),
  });
}

function preparation(
  overrides: Partial<ObservationReviewPreparation> = {},
): ObservationReviewPreparation {
  const scope = overrides.authority ?? authority();
  return {
    authority: scope,
    manifest: overrides.manifest ?? manifest(scope),
    range: sourceRange,
    evidenceIds: ['frame-1'],
    modalities: ['image'],
    prompt: 'PRIVATE_PROMPT_CANARY: inspect the approved frame.',
    providerCapability: { state: 'plan-only', diagnostic: 'plan-only-proven' },
    mediaCapability: imageCapability,
    ...overrides,
  };
}

function success(
  text = 'The approved frame contains a subject.',
): Extract<ObservationTransferServiceResult, { readonly ok: true }> {
  return {
    ok: true,
    requestBytes: 123,
    remainingRequests: 0,
    analysis: {
      text,
      submittedEvidenceIds: ['frame-1'],
      reviewedEvidenceIds: ['frame-1'],
    },
  };
}

function createFakeTransfer(
  result: Promise<ObservationTransferServiceResult> = Promise.resolve(success()),
) {
  const grantUserApprovedConsent = vi.fn((_input: unknown) => undefined);
  const send = vi.fn((_input: unknown) => result);
  const cancel = vi.fn((_runId: string) => true);
  const dispose = vi.fn();
  const transfer: ObservationReviewHostTransfer = {
    grantUserApprovedConsent,
    send,
    cancel,
    dispose,
  };
  return { transfer, grantUserApprovedConsent, send, cancel, dispose };
}

function createBridge() {
  const resolver = Object.freeze({ resolve: () => undefined });
  const createEvidenceResolver = vi.fn(() => resolver);
  let toolsRead = false;
  const bridge = Object.create(null) as Pick<
    JoyAgentObservationHostBridge,
    'createEvidenceResolver'
  >;
  Object.defineProperty(bridge, 'createEvidenceResolver', {
    enumerable: true,
    value: createEvidenceResolver,
  });
  Object.defineProperty(bridge, 'tools', {
    enumerable: false,
    get() {
      toolsRead = true;
      throw new Error('the review controller must not access Worker tools');
    },
  });
  return {
    bridge,
    createEvidenceResolver,
    get toolsRead() {
      return toolsRead;
    },
  };
}

function controllerFixture(
  options: {
    readonly transfer?: ReturnType<typeof createFakeTransfer>;
    readonly now?: () => number;
    readonly schedule?: (callback: () => void, delayMs: number) => unknown;
    readonly clearScheduled?: (handle: unknown) => void;
  } = {},
) {
  let live: ObservationTransferAuthority | undefined = authority();
  const bridge = createBridge();
  const fake = options.transfer ?? createFakeTransfer();
  const createHostTransfer = vi.fn(
    (_input: ObservationReviewHostTransferFactoryInput) => fake.transfer,
  );
  const controller = createObservationReviewController({
    bridge: bridge.bridge,
    currentAuthority: () => live,
    createHostTransfer,
    ...(options.now === undefined ? {} : { now: options.now }),
    ...(options.schedule === undefined ? {} : { schedule: options.schedule }),
    ...(options.clearScheduled === undefined ? {} : { clearScheduled: options.clearScheduled }),
  });
  return {
    controller,
    bridge,
    fake,
    createHostTransfer,
    setLive(value: ObservationTransferAuthority | undefined) {
      live = value;
    },
  };
}

function grant(expiresAtMs = Date.now() + 60_000) {
  return { maxRequests: 1, maxBytes: 64 * 1024, expiresAtMs };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('observation review controller', () => {
  it('starts idle, opens a redacted explicit consent state, and never accesses Worker tools', () => {
    const fixture = controllerFixture();
    expect(fixture.controller.getState()).toEqual({ status: 'idle' });

    const state = fixture.controller.prepareReview(preparation());

    expect(state).toMatchObject({
      status: 'consent-required',
      request: {
        scope: authority(),
        range: sourceRange,
        evidenceIds: ['frame-1'],
        modalities: ['image'],
      },
    });
    expect(fixture.bridge.createEvidenceResolver).toHaveBeenCalledTimes(1);
    expect(fixture.bridge.toolsRead).toBe(false);
    expect(fixture.fake.grantUserApprovedConsent).not.toHaveBeenCalled();
    expect(fixture.fake.send).not.toHaveBeenCalled();
  });

  it('accepts the editor revision receipt format used by live observation manifests', () => {
    const live = authority({ revision: 'local-revision:v1:project-1:timeline=1:document=4' });
    const fixture = controllerFixture();
    fixture.setLive(live);
    expect(fixture.controller.prepareReview(preparation({ authority: live }))).toMatchObject({
      status: 'consent-required',
      request: { scope: live },
    });
  });

  it('has one host-only grant path and returns only sanitized analysis/evidence identities', async () => {
    const fixture = controllerFixture();
    const emitted: string[] = [];
    fixture.controller.subscribe((state) => emitted.push(state.status));
    fixture.controller.prepareReview(preparation());

    const state = await fixture.controller.grantUserApprovedReview(grant());

    expect(state).toEqual({
      status: 'reviewed',
      request: {
        scope: authority(),
        range: sourceRange,
        evidenceIds: ['frame-1'],
        modalities: ['image'],
      },
      analysis: {
        text: 'The approved frame contains a subject.',
        submittedEvidenceIds: ['frame-1'],
        reviewedEvidenceIds: ['frame-1'],
      },
    });
    expect(emitted).toEqual(['consent-required', 'transferring', 'reviewed']);
    expect(fixture.fake.grantUserApprovedConsent).toHaveBeenCalledWith({
      authority: authority(),
      range: sourceRange,
      evidenceIds: ['frame-1'],
      modalities: ['image'],
      mediaCapability: imageCapability,
      maxRequests: 1,
      maxBytes: 64 * 1024,
      expiresAtMs: expect.any(Number),
    });
    const transferInput = fixture.fake.send.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(transferInput).not.toHaveProperty('connection');
    expect(transferInput).not.toHaveProperty('apiKey');
    expect(transferInput).not.toHaveProperty('endpoint');
    expect(fixture.fake.cancel).toHaveBeenCalledWith('run-1');
    expect(fixture.fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('does not expose a prompt, BYOK-like fields, resolver bytes, or private model transport in state', async () => {
    const fixture = controllerFixture();
    fixture.controller.prepareReview(
      preparation({ prompt: 'PRIVATE_PROMPT_CANARY SK-PRIVATE-DO-NOT-LEAK' }),
    );
    const pendingState = JSON.stringify(fixture.controller.getState());
    await fixture.controller.grantUserApprovedReview(grant());
    const terminalState = JSON.stringify(fixture.controller.getState());

    for (const forbidden of [
      'PRIVATE_PROMPT_CANARY',
      'SK-PRIVATE-DO-NOT-LEAK',
      'apiKey',
      'connection',
      'endpoint',
      'payload',
      'byteDigest',
    ]) {
      expect(pendingState).not.toContain(forbidden);
      expect(terminalState).not.toContain(forbidden);
    }
    expect(Object.isFrozen(fixture.controller.getState())).toBe(true);
  });

  it('rejects unavailable or modality/model-mismatched provider facts before any grant or send', () => {
    const unavailable = controllerFixture();
    const unavailableState = unavailable.controller.prepareReview(
      preparation({
        providerCapability: { state: 'unavailable', diagnostic: 'provider-probe-missing' },
      }),
    );
    expect(unavailableState).toMatchObject({ status: 'failed', code: 'provider-unavailable' });
    expect(unavailable.fake.grantUserApprovedConsent).not.toHaveBeenCalled();
    expect(unavailable.fake.send).not.toHaveBeenCalled();

    const mismatch = controllerFixture();
    const mismatchState = mismatch.controller.prepareReview(
      preparation({
        mediaCapability: { modelId: 'openrouter/model-b', modalities: ['image'] },
      }),
    );
    expect(mismatchState).toMatchObject({ status: 'failed', code: 'capability-mismatch' });
    expect(mismatch.bridge.createEvidenceResolver).not.toHaveBeenCalled();
    expect(mismatch.fake.grantUserApprovedConsent).not.toHaveBeenCalled();
    expect(mismatch.fake.send).not.toHaveBeenCalled();

    const missingImage = controllerFixture();
    expect(
      missingImage.controller.prepareReview(
        preparation({ mediaCapability: { modelId: 'openrouter/model-a', modalities: ['audio'] } }),
      ),
    ).toMatchObject({ status: 'failed', code: 'capability-mismatch' });
  });

  it.each([
    ['revision', authority({ revision: 'revision-2' })],
    ['run id', authority({ run: { runId: 'run-2', epoch: 1 } })],
    ['epoch', authority({ run: { runId: 'run-1', epoch: 2 } })],
    ['model', authority({ modelId: 'openrouter/model-b' })],
    ['policy', authority({ promptPolicyDigest: 'policy-2' })],
  ])('revokes consent-required state when the exact %s authority drifts', (_label, changed) => {
    const fixture = controllerFixture();
    fixture.controller.prepareReview(preparation());
    fixture.setLive(changed as ObservationTransferAuthority);

    expect(fixture.controller.refresh()).toMatchObject({
      status: 'cancelled',
      reason: 'authority-stale',
    });
    expect(fixture.fake.cancel).toHaveBeenCalledWith('run-1');
    expect(fixture.fake.dispose).toHaveBeenCalledTimes(1);
    expect(fixture.fake.grantUserApprovedConsent).not.toHaveBeenCalled();
  });

  it('detects a project switch and a terminal authority before any transfer', () => {
    const switched = controllerFixture();
    switched.controller.prepareReview(preparation());
    switched.setLive(authority({ projectId: 'project-2' }));
    expect(switched.controller.getState()).toMatchObject({
      status: 'cancelled',
      reason: 'project-switch',
    });

    const terminal = controllerFixture();
    terminal.controller.prepareReview(preparation());
    terminal.setLive(undefined);
    expect(terminal.controller.getState()).toMatchObject({
      status: 'cancelled',
      reason: 'authority-stale',
    });
  });

  it('does not resurrect a review when cancellation wins an in-flight direct transfer', async () => {
    const pending = deferred<ObservationTransferServiceResult>();
    const fixture = controllerFixture({ transfer: createFakeTransfer(pending.promise) });
    fixture.controller.prepareReview(preparation());
    const reviewing = fixture.controller.grantUserApprovedReview(grant());
    expect(fixture.controller.getState()).toMatchObject({ status: 'transferring' });

    expect(fixture.controller.cancel()).toMatchObject({
      status: 'cancelled',
      reason: 'host-cancelled',
    });
    pending.resolve(success('This answer must not overwrite cancellation.'));

    await expect(reviewing).resolves.toMatchObject({
      status: 'cancelled',
      reason: 'host-cancelled',
    });
    expect(fixture.fake.cancel).toHaveBeenCalledWith('run-1');
    expect(fixture.fake.dispose).toHaveBeenCalledTimes(1);
  });

  it('expires an active approval, revokes private transfer work, and ignores its late result', async () => {
    const pending = deferred<ObservationTransferServiceResult>();
    const scheduled = new Map<unknown, () => void>();
    let now = 1_000;
    let nextHandle = 0;
    const fixture = controllerFixture({
      transfer: createFakeTransfer(pending.promise),
      now: () => now,
      schedule: (callback) => {
        nextHandle += 1;
        scheduled.set(nextHandle, callback);
        return nextHandle;
      },
      clearScheduled: (handle) => {
        scheduled.delete(handle);
      },
    });
    fixture.controller.prepareReview(preparation());
    const reviewing = fixture.controller.grantUserApprovedReview(grant(1_500));
    expect(fixture.controller.getState()).toMatchObject({ status: 'transferring' });

    now = 1_500;
    for (const callback of [...scheduled.values()]) callback();
    expect(fixture.controller.getState()).toMatchObject({
      status: 'failed',
      code: 'consent-expired',
    });
    expect(fixture.fake.cancel).toHaveBeenCalledWith('run-1');
    expect(fixture.fake.dispose).toHaveBeenCalledTimes(1);

    pending.resolve(success('This expired result must remain private.'));
    await expect(reviewing).resolves.toMatchObject({ status: 'failed', code: 'consent-expired' });
  });

  it('maps a malformed direct-provider response to a redacted provider-rejected state', async () => {
    const scope = authority();
    const store = createEvidenceStore();
    const lookup = manifest(scope);
    store.createManifest({
      id: lookup.manifestId,
      scope: lookup.scope,
      mode: 'focus',
      intendedFrameIdPages: [['frame-1']],
    });
    const fetcher = vi.fn(async () => {
      return new Response(JSON.stringify({ choices: [{ message: { content: 12 } }] }), {
        status: 200,
      });
    }) as unknown as MultimodalFetch;
    const bridgeResolver = Object.freeze({
      resolve: () =>
        Object.freeze([
          Object.freeze({
            evidenceId: 'frame-1',
            modality: 'image' as const,
            mimeType: 'image/png',
            data: new Uint8Array([1, 2, 3]),
          }),
        ] satisfies readonly ObservationEvidencePayload[]),
    });
    const bridge: Pick<JoyAgentObservationHostBridge, 'createEvidenceResolver'> = Object.freeze({
      createEvidenceResolver: () => bridgeResolver,
    });
    const live: ObservationTransferAuthority | undefined = scope;
    const controller = createObservationReviewController({
      bridge,
      currentAuthority: () => live,
      createHostTransfer(input) {
        const service = createObservationTransferService({
          transport: createMultimodalTransport({ fetch: fetcher }),
          evidenceStore: store,
          evidenceResolver: input.evidenceResolver,
          currentAuthority: input.currentAuthority,
        });
        // This wrapper is the future App-owned closure boundary: its volatile
        // BYOK connection and endpoint never enter the controller API/state.
        return {
          grantUserApprovedConsent(grantInput) {
            const consent = issueObservationConsent(
              {
                projectId: grantInput.authority.projectId,
                runId: grantInput.authority.run.runId,
                endpointOrigin: 'https://provider.example',
                modelId: grantInput.authority.modelId,
                range: grantInput.range,
                evidenceIds: grantInput.evidenceIds,
                modalities: grantInput.modalities,
                maxRequests: grantInput.maxRequests,
                maxBytes: grantInput.maxBytes,
                expiresAtMs: grantInput.expiresAtMs,
              },
              grantInput.mediaCapability,
            );
            service.grantUserApprovedConsent({ consent, authority: grantInput.authority });
          },
          send(input) {
            return service.send({
              connection: {
                provider: 'openrouter',
                baseUrl: 'https://provider.example/v1',
                modelId: input.authority.modelId,
                apiKey: 'PRIVATE_BYOK_KEY_NEVER_LEAVES_HOST_CLOSURE',
              },
              authority: input.authority,
              range: input.range,
              prompt: input.prompt,
              evidenceIds: input.evidenceIds,
              manifest: input.manifest,
              mediaCapability: input.mediaCapability,
              signal: input.signal,
            });
          },
          cancel: (runId) => service.cancel(runId),
          dispose: () => service.dispose(),
        };
      },
    });

    controller.prepareReview(preparation({ authority: scope, manifest: lookup }));
    const state = await controller.grantUserApprovedReview(grant());

    expect(state).toMatchObject({ status: 'failed', code: 'provider-rejected' });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(state)).not.toContain('PRIVATE_BYOK_KEY_NEVER_LEAVES_HOST_CLOSURE');
    // Keep the live variable used so an accidental future lint rule does not
    // remove the exact-authority closure from this integration-shaped test.
    expect(live).toEqual(scope);
  });
});
