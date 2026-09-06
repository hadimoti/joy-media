import { describe, expect, it, vi } from 'vitest';
import type { RenderFrameIR } from '@joy-media/render-ir';
import type { CompositionObserverError } from './composition-observer.js';
import {
  createCompositionObserver,
  createFrozenCompositionCaptureSnapshot,
  type CompositionCaptureSnapshotInput,
  type CompositionObservationRequest,
  type CompositionReadinessReport,
} from './composition-observer.js';

const READY: CompositionReadinessReport = {
  asset: 'ready',
  font: 'ready',
  scene: 'ready',
  shader: 'ready',
};

function snapshot(
  overrides: Partial<CompositionCaptureSnapshotInput> = {},
): CompositionCaptureSnapshotInput {
  return {
    kind: 'canonical',
    compositionId: 'composition-1',
    projectRevision: 'project-revision-1',
    rendererVersion: 'renderer-v1',
    evaluatorVersion: 'evaluator-v1',
    dependencyDigests: ['b'.repeat(64), 'a'.repeat(64)],
    state: { title: { opacity: 0.25 }, timeline: { clips: ['clip-1'] } },
    ...overrides,
  };
}

function frame(
  timeUs: number,
  compositionId = 'composition-1',
  width = 2,
  height = 2,
  dpr = 1,
): RenderFrameIR {
  return {
    version: 1,
    compositionId,
    timeUs,
    viewport: { width, height, dpr },
    background: { r: 0, g: 0, b: 0, a: 255 },
    nodes: [],
  };
}

function request(
  overrides: Partial<CompositionObservationRequest> = {},
): CompositionObservationRequest {
  return {
    snapshot: snapshot(),
    outputTimesUs: [0, 500_000],
    readiness: { check: () => READY },
    evaluator: { version: 'evaluator-v1', evaluate: (_snapshot, timeUs) => frame(timeUs) },
    renderer: {
      version: 'renderer-v1',
      renderAndReadback: () => ({
        width: 2,
        height: 2,
        data: Uint8Array.from({ length: 16 }, (_, index) => index),
      }),
    },
    ...overrides,
  };
}

describe('composition observer', () => {
  it('captures exact output times from a frozen snapshot via overlay-free isolated readback', async () => {
    let releaseReadiness: (() => void) | undefined;
    const readinessPromise = new Promise<CompositionReadinessReport>((resolve) => {
      releaseReadiness = () => resolve(READY);
    });
    const inputSnapshot = snapshot();
    const evaluator = vi.fn((captured, timeUs: number) => {
      expect(Object.isFrozen(captured)).toBe(true);
      expect(Object.isFrozen(captured.state)).toBe(true);
      expect(Object.isFrozen((captured.state as { title: object }).title)).toBe(true);
      expect((captured.state as { title: { opacity: number } }).title.opacity).toBe(0.25);
      expect(captured).not.toHaveProperty('selection');
      expect(captured).not.toHaveProperty('playhead');
      expect(captured).not.toHaveProperty('history');
      return frame(timeUs);
    });
    const rendererBytes = Uint8Array.from({ length: 16 }, (_, index) => index);
    const renderer = {
      version: 'renderer-v1',
      renderAndReadback: vi.fn((_frame, options) => {
        expect(options).toMatchObject({
          purpose: 'composition-evidence',
          includeEditorOverlays: false,
        });
        expect(options).not.toHaveProperty('selection');
        expect(options).not.toHaveProperty('playhead');
        return { width: 2, height: 2, data: rendererBytes };
      }),
    };

    const capture = createCompositionObserver().capture(
      request({
        snapshot: inputSnapshot,
        readiness: { check: () => readinessPromise },
        evaluator: { version: 'evaluator-v1', evaluate: evaluator },
        renderer,
      }),
    );
    (inputSnapshot.state as { title: { opacity: number } }).title.opacity = 0.9;
    releaseReadiness?.();

    const result = await capture;
    expect(result).toMatchObject({
      status: 'captured',
      captureScope: 'isolated-render-readback',
      encodedOutput: 'not-assessed',
    });
    if (result.status !== 'captured') throw new Error('expected captured result');
    expect(evaluator).toHaveBeenCalledTimes(2);
    expect(renderer.renderAndReadback).toHaveBeenCalledTimes(2);
    expect(result.frames.map((captured) => captured.outputTimeUs)).toEqual([0, 500_000]);
    expect(result.frames.map((captured) => captured.identity.outputTimeUs)).toEqual([0, 500_000]);
    expect(result.frames[0]?.identity).toMatchObject({
      kind: 'composition',
      compositionId: 'composition-1',
      projectRevision: 'project-revision-1',
      rendererVersion: 'renderer-v1',
      evaluatorVersion: 'evaluator-v1',
      dependencyDigests: ['a'.repeat(64), 'b'.repeat(64)],
    });
    expect(result.frames[0]?.rgba).toEqual(rendererBytes);
    expect(result.frames[0]?.rgba).not.toBe(rendererBytes);
  });

  it.each([
    ['asset', 'missing'],
    ['asset', 'failed'],
    ['font', 'missing'],
    ['font', 'failed'],
    ['scene', 'missing'],
    ['scene', 'failed'],
    ['shader', 'approximate'],
  ] as const)(
    'blocks %s readiness state %s before evaluating or rendering',
    async (kind, state) => {
      const evaluator = vi.fn();
      const renderer = vi.fn();
      const result = await createCompositionObserver().capture(
        request({
          readiness: { check: () => ({ ...READY, [kind]: state }) },
          evaluator: { version: 'evaluator-v1', evaluate: evaluator },
          renderer: { version: 'renderer-v1', renderAndReadback: renderer },
        }),
      );

      expect(result).toEqual({
        status: 'blocked',
        code: 'dependency-not-ready',
        diagnostics: [{ kind, state }],
      });
      expect(evaluator).not.toHaveBeenCalled();
      expect(renderer).not.toHaveBeenCalled();
    },
  );

  it('fails closed when the evaluator returns a different composition/time or editor overlay field', async () => {
    const renderer = vi.fn();
    const wrongTime = await createCompositionObserver().capture(
      request({
        outputTimesUs: [500_000],
        evaluator: { version: 'evaluator-v1', evaluate: () => frame(0) },
        renderer: { version: 'renderer-v1', renderAndReadback: renderer },
      }),
    );
    expect(wrongTime).toEqual({ status: 'failed', code: 'invalid-frame' });
    expect(renderer).not.toHaveBeenCalled();

    const withOverlay = await createCompositionObserver().capture(
      request({
        outputTimesUs: [0],
        evaluator: {
          version: 'evaluator-v1',
          evaluate: () => ({ ...frame(0), editorOverlay: { selections: [] } }) as RenderFrameIR,
        },
        renderer: { version: 'renderer-v1', renderAndReadback: renderer },
      }),
    );
    expect(withOverlay).toEqual({ status: 'failed', code: 'invalid-frame' });
    expect(renderer).not.toHaveBeenCalled();
  });

  it('enforces configured readback pixel and byte bounds without publishing oversized pixels', async () => {
    const result = await createCompositionObserver({ maxPixels: 1, maxReadbackBytes: 4 }).capture(
      request({
        outputTimesUs: [0],
        evaluator: { version: 'evaluator-v1', evaluate: () => frame(0, 'composition-1', 1, 1) },
        renderer: {
          version: 'renderer-v1',
          renderAndReadback: () => ({ width: 2, height: 1, data: new Uint8Array(8) }),
        },
      }),
    );

    expect(result).toEqual({ status: 'failed', code: 'readback-too-large' });
  });

  it('rejects an oversized render surface before the renderer can allocate it', async () => {
    const renderer = vi.fn();
    const result = await createCompositionObserver({ maxPixels: 4, maxReadbackBytes: 16 }).capture(
      request({
        outputTimesUs: [0],
        evaluator: { version: 'evaluator-v1', evaluate: () => frame(0, 'composition-1', 3, 2) },
        renderer: { version: 'renderer-v1', renderAndReadback: renderer },
      }),
    );

    expect(result).toEqual({ status: 'failed', code: 'render-surface-too-large' });
    expect(renderer).not.toHaveBeenCalled();
  });

  it('keeps title/keyframe changes in the frozen evaluator path visible in captured pixels', async () => {
    const evaluator = {
      version: 'evaluator-v1',
      evaluate: (
        captured: ReturnType<typeof createFrozenCompositionCaptureSnapshot>,
        timeUs: number,
      ) => {
        const opacity = (captured.state as { title: { opacity: number } }).title.opacity;
        return {
          ...frame(timeUs),
          background: { r: Math.round(opacity * 255), g: 0, b: 0, a: 255 },
        };
      },
    };
    const renderer = {
      version: 'renderer-v1',
      renderAndReadback: (evaluated: RenderFrameIR) => ({
        width: 2,
        height: 2,
        data: new Uint8Array(16).fill(evaluated.background.r),
      }),
    };

    const canonical = await createCompositionObserver().capture(
      request({
        snapshot: snapshot({ state: { title: { opacity: 0.2 } } }),
        outputTimesUs: [100_000],
        evaluator,
        renderer,
      }),
    );
    const prepared = await createCompositionObserver().capture(
      request({
        snapshot: snapshot({ kind: 'prepared', state: { title: { opacity: 0.8 } } }),
        outputTimesUs: [100_000],
        evaluator,
        renderer,
      }),
    );

    if (canonical.status !== 'captured' || prepared.status !== 'captured')
      throw new Error('expected captured results');
    expect(canonical.frames[0]?.rgba[0]).toBe(Math.round(0.2 * 255));
    expect(prepared.frames[0]?.rgba[0]).toBe(Math.round(0.8 * 255));
    expect(canonical.frames[0]?.rgba).not.toEqual(prepared.frames[0]?.rgba);
  });

  it('reports only finite redacted failures for adapter mismatch, renderer errors, and malformed pixels', async () => {
    const versionMismatch = await createCompositionObserver().capture(
      request({ evaluator: { version: 'different-evaluator', evaluate: () => frame(0) } }),
    );
    expect(versionMismatch).toEqual({ status: 'failed', code: 'adapter-version-mismatch' });

    const rendererFailure = await createCompositionObserver().capture(
      request({
        outputTimesUs: [0],
        renderer: {
          version: 'renderer-v1',
          renderAndReadback: () => {
            throw new Error('file:///owner/private-media.mov');
          },
        },
      }),
    );
    expect(rendererFailure).toEqual({ status: 'failed', code: 'renderer-failed' });
    expect(JSON.stringify(rendererFailure)).not.toContain('private-media');

    const malformedReadback = await createCompositionObserver().capture(
      request({
        outputTimesUs: [0],
        renderer: {
          version: 'renderer-v1',
          renderAndReadback: () => ({ width: 2, height: 2, data: new Uint8Array(15) }),
        },
      }),
    );
    expect(malformedReadback).toEqual({ status: 'failed', code: 'invalid-readback' });
  });

  it('propagates cancellation to the active adapter and starts no later capture batches', async () => {
    const controller = new AbortController();
    const dispose = vi.fn();
    const evaluator = vi.fn((_snapshot, timeUs: number) => frame(timeUs));
    const renderer = vi.fn((_frame, options) => {
      expect(options.signal).toBeDefined();
      controller.abort();
      return { width: 2, height: 2, data: new Uint8Array(16), dispose };
    });

    const result = await createCompositionObserver().capture(
      request({
        evaluator: { version: 'evaluator-v1', evaluate: evaluator },
        renderer: { version: 'renderer-v1', renderAndReadback: renderer },
        signal: controller.signal,
      }),
    );

    expect(result).toEqual({ status: 'cancelled' });
    expect(evaluator).toHaveBeenCalledTimes(1);
    expect(renderer).toHaveBeenCalledTimes(1);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('rejects UI state and malformed snapshot data rather than accepting a live editor object', async () => {
    await expect(
      createCompositionObserver().capture(
        request({
          snapshot: { ...snapshot(), selection: { nodeId: 'live-node' } } as never,
        }),
      ),
    ).rejects.toMatchObject({
      code: 'invalid-request',
    } satisfies Partial<CompositionObserverError>);
    let failure: unknown;
    try {
      createFrozenCompositionCaptureSnapshot({
        ...snapshot(),
        state: { render: undefined } as never,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: 'invalid-request',
    } satisfies Partial<CompositionObserverError>);

    let liveGetterRead = false;
    const accessorSnapshot = snapshot();
    Object.defineProperty(accessorSnapshot, 'state', {
      enumerable: true,
      get() {
        liveGetterRead = true;
        return { selection: 'live-editor-state' };
      },
    });
    await expect(
      createCompositionObserver().capture(request({ snapshot: accessorSnapshot })),
    ).rejects.toMatchObject({
      code: 'invalid-request',
    } satisfies Partial<CompositionObserverError>);
    expect(liveGetterRead).toBe(false);
  });
});
