import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Output } from 'mediabunny';
import { validateVideoChunkMetadata } from '../node_modules/mediabunny/dist/modules/src/codec.js';
import {
  createBlobSink,
  detectOfflineMp4Capability,
  exportOfflineMp4,
  type OfflineAudioFeeder,
  type OfflineMp4Capability,
  type OfflineMp4ExportDeps,
  type OfflineMp4ExportSource,
} from './offline-mp4-export.js';

/** Everything the fakes recorded, reset before every test. */
const state = {
  log: [] as string[],
  painted: [] as number[],
  adds: [] as { readonly timestamp: number; readonly duration: number | undefined }[],
  progress: [] as { readonly completed: number; readonly total: number }[],
  fedUntil: [] as number[],
  videoTrackMetadata: undefined as
    { readonly frameRate: number; readonly decoderConfig?: unknown } | undefined,
  encodingConfig: undefined as unknown,
  formatOptions: undefined as unknown,
  outputCreated: 0,
  outputStarted: 0,
  outputFinalized: 0,
  outputCancelled: 0,
  videoSourceClosed: 0,
  audioAttached: 0,
  audioFinished: 0,
  audioAborted: 0,
  attachedOutput: undefined as Output | undefined,
  /** Makes the next `add()` wait for a promise the test never resolves. */
  pendingAdd: undefined as { readonly promise: Promise<void> } | undefined,
  /** Runs when the next `add()` is called. */
  onAdd: undefined as (() => void) | undefined,
  /** Makes the next `add()` fail. */
  addError: undefined as Error | undefined,
  /** Makes the audio `finish()` wait for a promise the test controls. */
  pendingFinish: undefined as { readonly promise: Promise<void> } | undefined,
  /** Makes `finalize()` wait for a promise the test controls. */
  pendingFinalize: undefined as { readonly promise: Promise<void> } | undefined,
  /** Runs when the audio `finish()` is called. */
  onFinish: undefined as (() => void) | undefined,
  /** Runs when `finalize()` is called. */
  onFinalize: undefined as (() => void) | undefined,
  /** How many bytes the fake output writes to its target when it is finalized. */
  targetBytes: 16,
  /** When set, the fake output writes exactly these fragments instead of `targetBytes` zeros. */
  fragments: undefined as Uint8Array[] | undefined,
};

class FakeVideoSource {
  constructor(
    readonly canvas: unknown,
    readonly encodingConfig: unknown,
  ) {
    state.encodingConfig = encodingConfig;
    state.log.push('source:new');
  }

  async add(timestamp: number, duration?: number): Promise<void> {
    state.adds.push({ timestamp, duration });
    state.log.push('frame:add');
    state.onAdd?.();
    if (state.addError !== undefined) throw state.addError;
    if (state.pendingAdd !== undefined) await state.pendingAdd.promise;
  }

  close(): void {
    state.videoSourceClosed += 1;
    state.log.push('frame:close');
  }
}

class FakeAppendOnlyStreamTarget {
  constructor(readonly writable: WritableStream<Uint8Array>) {
    state.log.push('target:new');
  }
}

class FakeOutputFormat {
  constructor(readonly options: unknown) {
    state.formatOptions = options;
  }
}

class FakeOutput {
  readonly format: unknown;
  readonly target: FakeAppendOnlyStreamTarget;

  constructor(options: { readonly format: unknown; readonly target: FakeAppendOnlyStreamTarget }) {
    this.format = options.format;
    this.target = options.target;
    state.outputCreated += 1;
    state.log.push('output:new');
  }

  addVideoTrack(
    _source: unknown,
    metadata?: { readonly frameRate: number; readonly decoderConfig?: unknown },
  ): unknown {
    state.videoTrackMetadata = metadata;
    state.log.push('output:addVideoTrack');
    return {};
  }

  async start(): Promise<void> {
    state.outputStarted += 1;
    state.log.push('output:start');
  }

  async finalize(): Promise<void> {
    state.outputFinalized += 1;
    state.log.push('output:finalize');
    state.onFinalize?.();
    if (state.pendingFinalize !== undefined) await state.pendingFinalize.promise;
    // The real muxer writes the file to its target front to back; this does the same.
    const writer = this.target.writable.getWriter();
    const fragments =
      state.fragments ?? (state.targetBytes > 0 ? [new Uint8Array(state.targetBytes)] : []);
    for (const fragment of fragments) await writer.write(fragment);
    await writer.close();
  }

  async cancel(): Promise<void> {
    state.outputCancelled += 1;
    state.log.push('output:cancel');
  }
}

class FakeAudioFeeder implements OfflineAudioFeeder {
  attach(output: Output): void {
    state.audioAttached += 1;
    state.attachedOutput = output;
    state.log.push('audio:attach');
  }

  async feedUntil(untilSeconds: number): Promise<void> {
    state.fedUntil.push(untilSeconds);
    state.log.push('audio:feedUntil');
  }

  async finish(): Promise<void> {
    state.audioFinished += 1;
    state.log.push('audio:finish');
    state.onFinish?.();
    if (state.pendingFinish !== undefined) await state.pendingFinish.promise;
  }

  abort(): void {
    state.audioAborted += 1;
    state.log.push('audio:abort');
  }
}

type Deps = Required<OfflineMp4ExportDeps>;

const deps: Deps = {
  Output: FakeOutput as unknown as Deps['Output'],
  Mp4OutputFormat: FakeOutputFormat as unknown as Deps['Mp4OutputFormat'],
  AppendOnlyStreamTarget: FakeAppendOnlyStreamTarget as unknown as Deps['AppendOnlyStreamTarget'],
  CanvasSource: FakeVideoSource as unknown as Deps['CanvasSource'],
  // Short, so a test that leaves a frame pending forever does not wait for the real grace period.
  cancelGraceMs: 25,
};

const canvas = { width: 1920, height: 1080 } as unknown as HTMLCanvasElement;

function baseSource(): OfflineMp4ExportSource {
  return {
    manifest: { width: 1920, height: 1080, frameRate: 30, durationUs: 133_333 },
    frameCount: 4,
    canvas,
    paintFrame: (index: number) => {
      state.painted.push(index);
      state.log.push(`paint:${index}`);
    },
    capability: {
      ok: true,
      codec: 'avc1.640028',
      hardwareAcceleration: 'prefer-hardware',
      bitrate: 8_000_000,
    },
  };
}

/** Awaits a failing export and hands the error back instead of the rejection. */
async function captureError(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error('the export was expected to fail');
}

/** The reason a capability probe gave for refusing the export. */
function reasonOf(capability: OfflineMp4Capability): string {
  return capability.ok ? '' : capability.reason;
}

beforeEach(() => {
  state.log = [];
  state.painted = [];
  state.adds = [];
  state.progress = [];
  state.fedUntil = [];
  state.videoTrackMetadata = undefined;
  state.encodingConfig = undefined;
  state.formatOptions = undefined;
  state.outputCreated = 0;
  state.outputStarted = 0;
  state.outputFinalized = 0;
  state.outputCancelled = 0;
  state.videoSourceClosed = 0;
  state.audioAttached = 0;
  state.audioFinished = 0;
  state.audioAborted = 0;
  state.attachedOutput = undefined;
  state.pendingAdd = undefined;
  state.onAdd = undefined;
  state.addError = undefined;
  state.pendingFinish = undefined;
  state.pendingFinalize = undefined;
  state.onFinish = undefined;
  state.onFinalize = undefined;
  state.targetBytes = 16;
  state.fragments = undefined;
});

describe('exportOfflineMp4', () => {
  it('paints and adds every frame in order with exact timestamps', async () => {
    const result = await exportOfflineMp4(baseSource(), deps);

    expect(state.painted).toEqual([0, 1, 2, 3]);
    expect(state.adds).toEqual([
      { timestamp: 0, duration: 1 / 30 },
      { timestamp: 1 / 30, duration: 1 / 30 },
      { timestamp: 2 / 30, duration: 1 / 30 },
      { timestamp: 3 / 30, duration: 1 / 30 },
    ]);
    expect(state.log.filter((entry) => entry.startsWith('paint:'))).toEqual([
      'paint:0',
      'paint:1',
      'paint:2',
      'paint:3',
    ]);
    expect(result.frameCount).toBe(4);
  });

  it('reports progress after every frame', async () => {
    const source: OfflineMp4ExportSource = {
      ...baseSource(),
      onProgress: (completed, total) => {
        state.progress.push({ completed, total });
      },
    };
    await exportOfflineMp4(source, deps);

    expect(state.progress).toEqual([
      { completed: 1, total: 4 },
      { completed: 2, total: 4 },
      { completed: 3, total: 4 },
      { completed: 4, total: 4 },
    ]);
  });

  it('feeds the audio after every frame, with the frame boundary', async () => {
    const source: OfflineMp4ExportSource = { ...baseSource(), audio: new FakeAudioFeeder() };
    await exportOfflineMp4(source, deps);

    expect(state.fedUntil).toEqual([1 / 30, 2 / 30, 3 / 30, 4 / 30]);
    expect(
      state.log.filter((entry) => entry === 'frame:add' || entry === 'audio:feedUntil'),
    ).toEqual([
      'frame:add',
      'audio:feedUntil',
      'frame:add',
      'audio:feedUntil',
      'frame:add',
      'audio:feedUntil',
      'frame:add',
      'audio:feedUntil',
    ]);
  });

  it('finishes the audio once, after the last frame and before the muxer finalizes', async () => {
    const source: OfflineMp4ExportSource = { ...baseSource(), audio: new FakeAudioFeeder() };
    await exportOfflineMp4(source, deps);

    expect(state.audioFinished).toBe(1);
    expect(state.log.indexOf('audio:finish')).toBeGreaterThan(state.log.lastIndexOf('frame:add'));
    expect(state.log.indexOf('audio:finish')).toBeLessThan(state.log.indexOf('output:finalize'));
  });

  it('attaches the audio before the output starts and closes the video source', async () => {
    const source: OfflineMp4ExportSource = { ...baseSource(), audio: new FakeAudioFeeder() };
    await exportOfflineMp4(source, deps);

    expect(state.audioAttached).toBe(1);
    expect(state.attachedOutput).toBeDefined();
    expect(state.log.indexOf('audio:attach')).toBeLessThan(state.log.indexOf('output:start'));
    expect(state.videoSourceClosed).toBe(1);
  });

  it('encodes with the capability codec and tags encoded decoder metadata as BT.709', async () => {
    await exportOfflineMp4(baseSource(), deps);

    expect(state.encodingConfig).toMatchObject({
      codec: 'avc',
      bitrate: 8_000_000,
      fullCodecString: 'avc1.640028',
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
      keyFrameInterval: 2,
    });
    const packetMetadata = {
      decoderConfig: {
        codec: 'avc1.640028',
        codedWidth: 160,
        codedHeight: 90,
        description: new Uint8Array([1, 2, 3]),
      },
    };
    const encodingConfig = state.encodingConfig as {
      onEncodedPacket?: (packet: unknown, metadata: typeof packetMetadata) => void;
    };
    encodingConfig.onEncodedPacket?.({}, packetMetadata);

    expect(packetMetadata.decoderConfig).toEqual({
      codec: 'avc1.640028',
      codedWidth: 160,
      codedHeight: 90,
      description: new Uint8Array([1, 2, 3]),
      colorSpace: {
        primaries: 'bt709',
        transfer: 'bt709',
        matrix: 'bt709',
        fullRange: false,
      },
    });
    expect(() => validateVideoChunkMetadata(packetMetadata, 'avc')).not.toThrow();
    expect(state.videoTrackMetadata).toEqual({ frameRate: 30 });
    // Written front to back, one fragment at a time, so no copy of the file builds up in memory.
    expect(state.formatOptions).toEqual({ fastStart: 'fragmented' });
  });

  it('returns the encoded blob without downloading it', async () => {
    const source: OfflineMp4ExportSource = { ...baseSource(), filename: 'export.mp4' };
    const result = await exportOfflineMp4(source, deps);

    expect(result.encoded).toBe(true);
    expect(result.mimeType).toBe('video/mp4');
    expect(result.totalBytes).toBe(16);
    expect(result.blob?.size).toBe(16);
    expect(result.filename).toBe('export.mp4');
    expect(state.outputFinalized).toBe(1);
  });

  it('falls back to a generated filename', async () => {
    const result = await exportOfflineMp4(baseSource(), deps);
    expect(result.filename).toMatch(/^joy-media-export-\d+\.mp4$/);
  });

  it('rejects a broken manifest', async () => {
    await expect(exportOfflineMp4({ ...baseSource(), frameCount: 0 }, deps)).rejects.toBeInstanceOf(
      RangeError,
    );
    await expect(
      exportOfflineMp4(
        { ...baseSource(), manifest: { width: 0, height: 1080, frameRate: 30, durationUs: 1 } },
        deps,
      ),
    ).rejects.toBeInstanceOf(RangeError);
    await expect(
      exportOfflineMp4(
        { ...baseSource(), manifest: { width: 1920, height: 1080, frameRate: 0, durationUs: 1 } },
        deps,
      ),
    ).rejects.toBeInstanceOf(RangeError);
    expect(state.outputCreated).toBe(0);
  });

  it('rejects an already aborted export before it touches the encoder', async () => {
    const controller = new AbortController();
    controller.abort();
    const source: OfflineMp4ExportSource = { ...baseSource(), signal: controller.signal };

    const error = await captureError(exportOfflineMp4(source, deps));
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(state.outputCreated).toBe(0);
    expect(state.outputFinalized).toBe(0);
  });

  it('aborts before the first frame and cancels the output', async () => {
    const controller = new AbortController();
    const source: OfflineMp4ExportSource = {
      ...baseSource(),
      signal: controller.signal,
      audio: new FakeAudioFeeder(),
      paintFrame: (index: number) => {
        state.painted.push(index);
        controller.abort();
      },
    };

    const error = await captureError(exportOfflineMp4(source, deps));
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(state.painted).toEqual([0]);
    expect(state.adds).toHaveLength(0);
    expect(state.audioAborted).toBe(1);
    expect(state.outputCancelled).toBe(1);
    expect(state.outputFinalized).toBe(0);
    expect(state.audioFinished).toBe(0);
  });

  it('aborts mid-loop and cancels the output', async () => {
    const controller = new AbortController();
    const source: OfflineMp4ExportSource = {
      ...baseSource(),
      signal: controller.signal,
      audio: new FakeAudioFeeder(),
      paintFrame: (index: number) => {
        state.painted.push(index);
        if (index === 2) controller.abort();
      },
    };

    const error = await captureError(exportOfflineMp4(source, deps));
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(state.painted).toEqual([0, 1, 2]);
    expect(state.adds).toHaveLength(2);
    expect(state.audioAborted).toBe(1);
    expect(state.outputCancelled).toBe(1);
    expect(state.outputFinalized).toBe(0);
  });

  it('aborts while a frame is still being encoded', async () => {
    const controller = new AbortController();
    state.pendingAdd = { promise: new Promise<void>(() => {}) };
    const addStarted = new Promise<void>((resolve) => {
      state.onAdd = () => resolve();
    });
    const source: OfflineMp4ExportSource = {
      ...baseSource(),
      frameCount: 2,
      signal: controller.signal,
      audio: new FakeAudioFeeder(),
    };

    const pending = exportOfflineMp4(source, deps);
    await addStarted;
    controller.abort();

    const error = await captureError(pending);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(state.outputCancelled).toBe(1);
    expect(state.outputFinalized).toBe(0);
    expect(state.audioAborted).toBe(1);
  });

  it('lets a frame that is still being encoded settle before it cancels the output', async () => {
    // mediabunny builds its encoder on the first add(), after an asynchronous support query. An
    // encoder created after cancel() returned would never be closed, so the cancel waits.
    const controller = new AbortController();
    let finishAdd!: () => void;
    state.pendingAdd = { promise: new Promise<void>((resolve) => (finishAdd = resolve)) };
    const addStarted = new Promise<void>((resolve) => {
      state.onAdd = () => resolve();
    });
    const source: OfflineMp4ExportSource = {
      ...baseSource(),
      frameCount: 2,
      signal: controller.signal,
      audio: new FakeAudioFeeder(),
    };

    const errorPromise = captureError(exportOfflineMp4(source, deps));
    await addStarted;
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Still inside the grace period: the frame has not settled, so nothing was cancelled yet.
    expect(state.outputCancelled).toBe(0);

    finishAdd();
    const error = await errorPromise;
    expect((error as DOMException).name).toBe('AbortError');
    expect(state.outputCancelled).toBe(1);
    expect(state.log.indexOf('output:cancel')).toBeGreaterThan(state.log.indexOf('frame:add'));
  });

  it('cancels the output before it aborts the audio feeder', async () => {
    // Aborting the feeder first would start a polite flush of its audio source that cancel() can
    // no longer turn into a forced close.
    state.addError = new Error('the encoder gave up');
    const source: OfflineMp4ExportSource = { ...baseSource(), audio: new FakeAudioFeeder() };

    await captureError(exportOfflineMp4(source, deps));
    expect(state.log.indexOf('output:cancel')).toBeGreaterThanOrEqual(0);
    expect(state.log.indexOf('output:cancel')).toBeLessThan(state.log.indexOf('audio:abort'));
  });

  // A long grace period: if a cancel during the final steps waited for it, these tests would be slow.
  const slowGraceDeps: Deps = { ...deps, cancelGraceMs: 2_000 };

  it('stops waiting for the final audio flush when the export is cancelled', async () => {
    const controller = new AbortController();
    state.pendingFinish = { promise: new Promise<void>(() => {}) };
    const finishStarted = new Promise<void>((resolve) => {
      state.onFinish = () => resolve();
    });
    const source: OfflineMp4ExportSource = {
      ...baseSource(),
      signal: controller.signal,
      audio: new FakeAudioFeeder(),
    };

    const errorPromise = captureError(exportOfflineMp4(source, slowGraceDeps));
    await finishStarted;
    const cancelledAt = Date.now();
    controller.abort();

    const error = await errorPromise;
    expect((error as DOMException).name).toBe('AbortError');
    expect(Date.now() - cancelledAt).toBeLessThan(1_000);
    expect(state.outputFinalized).toBe(0);
    expect(state.outputCancelled).toBe(1);
    // The video source stays open until the audio is done, so cancel() can force-close it.
    expect(state.videoSourceClosed).toBe(0);
  });

  it('stops waiting for the muxer to finish the file when the export is cancelled', async () => {
    const controller = new AbortController();
    state.pendingFinalize = { promise: new Promise<void>(() => {}) };
    const finalizeStarted = new Promise<void>((resolve) => {
      state.onFinalize = () => resolve();
    });
    const source: OfflineMp4ExportSource = { ...baseSource(), signal: controller.signal };

    const errorPromise = captureError(exportOfflineMp4(source, slowGraceDeps));
    await finalizeStarted;
    const cancelledAt = Date.now();
    controller.abort();

    const error = await errorPromise;
    expect((error as DOMException).name).toBe('AbortError');
    // mediabunny cannot cancel a file that is being finalized, so the cancel must not wait for it.
    expect(Date.now() - cancelledAt).toBeLessThan(1_000);
  });

  it('drops a fragment the muxer writes after the export was cancelled, without an error', async () => {
    // mediabunny cannot cancel a file that is already being finalized, so it may still write its
    // last fragments after the export has returned. They must be dropped quietly: a write to a
    // sink that rejected would surface as an unhandled rejection, which fails this test run.
    const controller = new AbortController();
    let finishFinalize!: () => void;
    state.pendingFinalize = { promise: new Promise<void>((resolve) => (finishFinalize = resolve)) };
    state.fragments = [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])];
    const finalizeStarted = new Promise<void>((resolve) => {
      state.onFinalize = () => resolve();
    });
    const source: OfflineMp4ExportSource = { ...baseSource(), signal: controller.signal };

    const errorPromise = captureError(exportOfflineMp4(source, deps));
    await finalizeStarted;
    controller.abort();
    expect(((await errorPromise) as DOMException).name).toBe('AbortError');

    finishFinalize();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(state.outputFinalized).toBe(1);
  });

  it('closes the video source after the audio finished and just before the file is written', async () => {
    const source: OfflineMp4ExportSource = { ...baseSource(), audio: new FakeAudioFeeder() };
    await exportOfflineMp4(source, deps);

    const finish = state.log.indexOf('audio:finish');
    const close = state.log.indexOf('frame:close');
    const finalize = state.log.indexOf('output:finalize');
    expect(finish).toBeGreaterThan(state.log.lastIndexOf('frame:add'));
    expect(close).toBeGreaterThan(finish);
    expect(close).toBeLessThan(finalize);
  });

  it('does not hand out a file when the cancel arrives as the last step completes', async () => {
    const controller = new AbortController();
    state.onFinalize = () => controller.abort();
    const source: OfflineMp4ExportSource = { ...baseSource(), signal: controller.signal };

    const error = await captureError(exportOfflineMp4(source, deps));
    expect((error as DOMException).name).toBe('AbortError');
    expect(state.outputFinalized).toBe(1);
  });

  it('does not finalize when the cancel arrives while the audio finishes', async () => {
    const controller = new AbortController();
    state.onFinish = () => controller.abort();
    const source: OfflineMp4ExportSource = {
      ...baseSource(),
      signal: controller.signal,
      audio: new FakeAudioFeeder(),
    };

    const error = await captureError(exportOfflineMp4(source, deps));
    expect((error as DOMException).name).toBe('AbortError');
    expect(state.outputFinalized).toBe(0);
    expect(state.audioAborted).toBe(1);
  });

  it('cancels and rethrows when a frame cannot be encoded', async () => {
    state.addError = new Error('the encoder gave up');
    const source: OfflineMp4ExportSource = { ...baseSource(), audio: new FakeAudioFeeder() };

    const error = await captureError(exportOfflineMp4(source, deps));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('the encoder gave up');
    expect(state.outputCancelled).toBe(1);
    expect(state.outputFinalized).toBe(0);
    expect(state.audioAborted).toBe(1);
  });

  it('returns every fragment the muxer wrote, in order, as one blob', async () => {
    state.fragments = [new Uint8Array([1, 2]), new Uint8Array([3]), new Uint8Array([4, 5, 6])];
    const result = await exportOfflineMp4(baseSource(), deps);

    expect(result.blob?.type).toBe('video/mp4');
    expect(result.totalBytes).toBe(6);
    expect(Array.from(new Uint8Array(await result.blob!.arrayBuffer()))).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
  });

  it('reports an empty file instead of handing out an empty blob', async () => {
    state.targetBytes = 0;
    const error = await captureError(exportOfflineMp4(baseSource(), deps));
    expect((error as Error).message).toContain('empty file');
  });
});

describe('createBlobSink', () => {
  async function write(sink: ReturnType<typeof createBlobSink>, ...chunks: number[][]) {
    const writer = sink.writable.getWriter();
    for (const chunk of chunks) await writer.write(new Uint8Array(chunk));
    writer.releaseLock();
  }

  it('keeps every chunk, in order, as parts of one blob', async () => {
    const sink = createBlobSink();
    await write(sink, [1, 2, 3], [4], [5, 6]);

    expect(sink.size()).toBe(6);
    const blob = sink.toBlob('video/mp4');
    expect(blob.size).toBe(6);
    expect(blob.type).toBe('video/mp4');
    expect(Array.from(new Uint8Array(await blob.arrayBuffer()))).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('does not keep a view on the chunk it was given', async () => {
    const sink = createBlobSink();
    const chunk = new Uint8Array([7, 8, 9]);
    await write(sink, [0]);
    const writer = sink.writable.getWriter();
    await writer.write(chunk);
    chunk.fill(0);
    writer.releaseLock();

    expect(Array.from(new Uint8Array(await sink.toBlob('video/mp4').arrayBuffer()))).toEqual([
      0, 7, 8, 9,
    ]);
  });

  it('is empty before anything is written', () => {
    const sink = createBlobSink();
    expect(sink.size()).toBe(0);
    expect(sink.toBlob('video/mp4').size).toBe(0);
  });

  it('drops what it holds on discard and ignores later writes', async () => {
    const sink = createBlobSink();
    await write(sink, [1, 2, 3]);
    sink.discard();
    await write(sink, [4, 5]);

    expect(sink.size()).toBe(0);
    expect(sink.toBlob('video/mp4').size).toBe(0);
  });
});

describe('detectOfflineMp4Capability', () => {
  const input = { width: 1920, height: 1080, frameRate: 30, needsAudio: false };

  it('takes the first supported candidate', async () => {
    const queried: string[] = [];
    const capability = await detectOfflineMp4Capability(input, {
      videoEncoder: {
        isConfigSupported: async (config) => {
          queried.push(config.codec);
          return { supported: config.codec === 'avc1.640029' };
        },
      },
    });

    expect(capability).toEqual({
      ok: true,
      codec: 'avc1.640029',
      hardwareAcceleration: 'prefer-hardware',
      bitrate: 62_208_000,
    });
    expect(queried[0]).toBe('avc1.640029');
  });

  it('asks for the hardware encoder', async () => {
    const configs: VideoEncoderConfig[] = [];
    await detectOfflineMp4Capability(input, {
      videoEncoder: {
        isConfigSupported: async (config) => {
          configs.push(config);
          return { supported: true };
        },
      },
    });

    expect(configs[0]).toMatchObject({
      codec: 'avc1.640029',
      width: 1920,
      height: 1080,
      framerate: 30,
      bitrate: 62_208_000,
      hardwareAcceleration: 'prefer-hardware',
      latencyMode: 'quality',
    });
  });

  it('falls back to a lower profile when the preferred one is refused', async () => {
    const queried: string[] = [];
    const capability = await detectOfflineMp4Capability(input, {
      videoEncoder: {
        isConfigSupported: async (config) => {
          queried.push(config.codec);
          return { supported: config.codec === 'avc1.4D0032' };
        },
      },
    });

    expect(capability).toMatchObject({ ok: true, codec: 'avc1.4D0032' });
    // Main is only asked for levels that cover the bit rate, so level 4.1 is never tried for it.
    expect(queried.filter((codec) => codec.startsWith('avc1.4D'))).toEqual(['avc1.4D0032']);
  });

  it('keeps the bit rate floor and ceiling of the default', async () => {
    const encoder = { videoEncoder: { isConfigSupported: async () => ({ supported: true }) } };
    const small = await detectOfflineMp4Capability(
      { width: 320, height: 240, frameRate: 1, needsAudio: false },
      encoder,
    );
    const large = await detectOfflineMp4Capability(
      { width: 3840, height: 2160, frameRate: 60, needsAudio: false },
      encoder,
    );

    expect(small).toMatchObject({ ok: true, bitrate: 2_000_000 });
    expect(large).toMatchObject({ ok: true, bitrate: 300_000_000 });
  });

  it('reports a plain reason when no candidate is supported', async () => {
    const capability = await detectOfflineMp4Capability(input, {
      videoEncoder: { isConfigSupported: async () => ({ supported: false }) },
    });

    expect(capability.ok).toBe(false);
    expect(reasonOf(capability)).toContain('1920x1080');
  });

  it('requires an AAC encoder when the export needs audio', async () => {
    const capability = await detectOfflineMp4Capability(
      { ...input, needsAudio: true },
      {
        videoEncoder: { isConfigSupported: async () => ({ supported: true }) },
        audioEncoder: { isConfigSupported: async () => ({ supported: false }) },
      },
    );

    expect(capability.ok).toBe(false);
    expect(reasonOf(capability)).toContain('AAC');
  });

  it('accepts an export with audio when both encoders are available', async () => {
    const audioQueries: AudioEncoderConfig[] = [];
    const capability = await detectOfflineMp4Capability(
      { ...input, needsAudio: true },
      {
        videoEncoder: { isConfigSupported: async () => ({ supported: true }) },
        audioEncoder: {
          isConfigSupported: async (config) => {
            audioQueries.push(config);
            return { supported: true };
          },
        },
      },
    );

    expect(capability.ok).toBe(true);
    expect(audioQueries[0]).toMatchObject({
      codec: 'mp4a.40.2',
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 128000,
    });
  });

  it('refuses an odd width or height, which mediabunny rejects for H.264', async () => {
    let queries = 0;
    const videoEncoder = {
      isConfigSupported: async () => {
        queries += 1;
        return { supported: true };
      },
    };
    for (const size of [
      { width: 1081, height: 1920 },
      { width: 1080, height: 1921 },
    ]) {
      const capability = await detectOfflineMp4Capability({ ...input, ...size }, { videoEncoder });
      expect(capability.ok).toBe(false);
      expect(reasonOf(capability)).toContain(`${size.width}x${size.height}`);
    }
    expect(queries).toBe(0);
  });

  it('refuses a canvas above the H.264 export limit before probing browser support', async () => {
    let queries = 0;
    const capability = await detectOfflineMp4Capability(
      { ...input, width: 3840, height: 2162 },
      {
        videoEncoder: {
          isConfigSupported: async () => {
            queries += 1;
            return { supported: true };
          },
        },
      },
    );

    expect(capability.ok).toBe(false);
    expect(reasonOf(capability)).toMatch(/8,294,400|export limit|maximum/i);
    expect(queries).toBe(0);
  });

  it('asks the AAC encoder about the sample rate of the mixed audio', async () => {
    const audioQueries: AudioEncoderConfig[] = [];
    await detectOfflineMp4Capability(
      { ...input, needsAudio: true, audioSampleRate: 44100 },
      {
        videoEncoder: { isConfigSupported: async () => ({ supported: true }) },
        audioEncoder: {
          isConfigSupported: async (config) => {
            audioQueries.push(config);
            return { supported: true };
          },
        },
      },
    );

    expect(audioQueries[0]).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 44100 });
  });

  it('probes the preset video and audio bitrate and channel settings', async () => {
    const videoQueries: VideoEncoderConfig[] = [];
    const audioQueries: AudioEncoderConfig[] = [];
    const capability = await detectOfflineMp4Capability(
      {
        ...input,
        needsAudio: true,
        bitrate: 8_000_000,
        audioSampleRate: 44_100,
        audioChannels: 1,
        audioBitrate: 96_000,
      },
      {
        videoEncoder: {
          isConfigSupported: async (config) => {
            videoQueries.push(config);
            return { supported: true };
          },
        },
        audioEncoder: {
          isConfigSupported: async (config) => {
            audioQueries.push(config);
            return { supported: true };
          },
        },
      },
    );

    expect(capability.ok).toBe(true);
    expect(videoQueries[0]).toMatchObject({ bitrate: 8_000_000 });
    expect(audioQueries[0]).toMatchObject({
      sampleRate: 44_100,
      numberOfChannels: 1,
      bitrate: 96_000,
    });
  });

  it('reports a missing WebCodecs encoder instead of throwing', async () => {
    const capability = await detectOfflineMp4Capability(input);
    expect(capability.ok).toBe(false);
    expect(reasonOf(capability)).toContain('WebCodecs');
  });

  it('reports a failing support query instead of throwing', async () => {
    const capability = await detectOfflineMp4Capability(input, {
      videoEncoder: {
        isConfigSupported: async () => {
          throw new Error('the encoder crashed');
        },
      },
    });

    expect(capability.ok).toBe(false);
    expect(reasonOf(capability)).toContain('the encoder crashed');
  });

  it('gives up on a support query that never answers', async () => {
    vi.useFakeTimers();
    try {
      const pending = detectOfflineMp4Capability(input, {
        videoEncoder: { isConfigSupported: () => new Promise(() => {}) },
      });
      await vi.advanceTimersByTimeAsync(8_000);
      const capability = await pending;
      expect(capability.ok).toBe(false);
      expect(reasonOf(capability)).toContain('did not answer');
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses the bitrate the caller asked for', async () => {
    const capability = await detectOfflineMp4Capability(
      { ...input, bitrate: 5_000_000 },
      { videoEncoder: { isConfigSupported: async () => ({ supported: true }) } },
    );

    expect(capability).toMatchObject({ ok: true, bitrate: 5_000_000 });
  });
});
