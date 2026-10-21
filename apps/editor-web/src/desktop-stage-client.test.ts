// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DESKTOP_STAGE_CHUNK_BYTES,
  stageDesktopMedia,
  waitForDesktopJob,
} from './desktop-client.js';

const source = { sha256: 'c'.repeat(64), bytes: 0, displayName: 'clip.mp4' };

/** jsdom's Blob has no arrayBuffer(); browsers do. This double gives the same slice/read surface. */
function blobOf(bytes: Uint8Array): Blob {
  const double = {
    size: bytes.byteLength,
    slice: (start: number, end: number) => blobOf(bytes.slice(start, end)),
    arrayBuffer: async () => bytes.slice().buffer,
  };
  return double as unknown as Blob;
}

function bridgeWith(handler: (channel: string, payload: unknown) => unknown) {
  const invoke = vi.fn(async (channel: string, payload?: unknown) => handler(channel, payload));
  window.joyDesktop = { channels: [], invoke };
  return invoke;
}

describe('stageDesktopMedia', () => {
  afterEach(() => {
    delete (window as { joyDesktop?: unknown }).joyDesktop;
  });

  it('sends the original in fixed-size chunks at sequential offsets, then finishes', async () => {
    const bytes = new Uint8Array(DESKTOP_STAGE_CHUNK_BYTES * 2 + 5).map((_, i) => i % 251);
    const blob = blobOf(bytes);
    const ref = { kind: 'local-file', id: 'ref-1', displayName: 'clip.mp4' };
    const invoke = bridgeWith((channel) => {
      if (channel === 'desktop.media-stage.begin') return { status: 'upload', uploadId: 'u-1' };
      if (channel === 'desktop.media-stage.finish') return ref;
      return { received: 0 };
    });

    const progress: number[] = [];
    const result = await stageDesktopMedia({ ...source, bytes: bytes.byteLength }, blob, (ratio) =>
      progress.push(ratio),
    );

    expect(result).toEqual(ref);
    const chunks = invoke.mock.calls.filter(([channel]) => channel === 'desktop.media-stage.chunk');
    expect(chunks).toHaveLength(3);
    const offsets = chunks.map(([, payload]) => (payload as { offset: number }).offset);
    expect(offsets).toEqual([0, DESKTOP_STAGE_CHUNK_BYTES, DESKTOP_STAGE_CHUNK_BYTES * 2]);
    const sizes = chunks.map(([, payload]) => (payload as { data: Uint8Array }).data.byteLength);
    expect(sizes).toEqual([DESKTOP_STAGE_CHUNK_BYTES, DESKTOP_STAGE_CHUNK_BYTES, 5]);
    expect(progress.at(-1)).toBe(1);
  });

  it('skips the upload entirely when the desktop already holds a verified copy', async () => {
    const ref = { kind: 'local-file', id: 'ref-cached', displayName: 'clip.mp4' };
    const invoke = bridgeWith((channel) =>
      channel === 'desktop.media-stage.begin' ? { status: 'cached', ref } : undefined,
    );
    const blob = blobOf(new Uint8Array(1024));

    const result = await stageDesktopMedia({ ...source, bytes: 1024 }, blob);

    expect(result).toEqual(ref);
    expect(invoke.mock.calls.map(([channel]) => channel)).toEqual(['desktop.media-stage.begin']);
  });

  it('aborts the upload and rethrows when a chunk is refused', async () => {
    const blob = blobOf(new Uint8Array(10));
    const invoke = bridgeWith((channel) => {
      if (channel === 'desktop.media-stage.begin') return { status: 'upload', uploadId: 'u-2' };
      if (channel === 'desktop.media-stage.chunk')
        throw new Error('Media chunk arrived out of order');
      return undefined;
    });

    await expect(stageDesktopMedia({ ...source, bytes: 10 }, blob)).rejects.toThrow('out of order');
    expect(invoke).toHaveBeenLastCalledWith('desktop.media-stage.abort', { uploadId: 'u-2' });
  });

  it('refuses before contacting the desktop when the bytes do not match the imported size', async () => {
    const invoke = bridgeWith(() => undefined);
    await expect(
      stageDesktopMedia({ ...source, bytes: 99 }, blobOf(new Uint8Array(10))),
    ).rejects.toThrow('do not match');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('waitForDesktopJob', () => {
  afterEach(() => {
    delete (window as { joyDesktop?: unknown }).joyDesktop;
  });

  it('polls through queued and running states until a terminal state', async () => {
    const statuses = ['queued', 'running', 'done'];
    bridgeWith((channel) =>
      channel === 'desktop.job-status'
        ? { id: 'job-1', status: statuses.shift() ?? 'done' }
        : undefined,
    );
    const seen: string[] = [];
    const job = await waitForDesktopJob('job-1', {
      intervalMs: 1,
      onUpdate: (update) => seen.push(update.status),
    });
    expect(job.status).toBe('done');
    expect(seen).toEqual(['queued', 'running', 'done']);
  });

  it('stops polling as soon as the caller aborts', async () => {
    bridgeWith((channel) =>
      channel === 'desktop.job-status' ? { id: 'job-2', status: 'running' } : undefined,
    );
    const controller = new AbortController();
    const pending = waitForDesktopJob('job-2', { intervalMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(new Error('left the editor')), 5);
    await expect(pending).rejects.toThrow('left the editor');
  });
});
