import { describe, expect, it, vi } from 'vitest';
import {
  findSilentVideoAssetIds,
  type AudioAssetInfo,
  type SilentVideoProbe,
} from './export-audio-presence.js';
import type { AudioPresenceResult } from './media-audio-presence.js';

const blob = new Blob(['bytes']);
const assets: Record<string, AudioAssetInfo> = {
  silent: { kind: 'video', sha256: 'a'.repeat(64), bytes: 5, displayName: 'silent.mp4' },
  sound: { kind: 'video', sha256: 'b'.repeat(64), bytes: 5, displayName: 'sound.mp4' },
  unknownAudio: { kind: 'video', displayName: 'mystery.webm' },
  music: { kind: 'audio', displayName: 'track.wav' },
  picture: { kind: 'image', displayName: 'still.png' },
  unreadable: { kind: 'video', displayName: 'gone.mp4' },
};

function probe(overrides: Partial<SilentVideoProbe> = {}): SilentVideoProbe {
  return {
    loadBlob: vi.fn(async (assetId: string) => (assetId === 'unreadable' ? undefined : blob)),
    inspect: vi.fn(async (_blob: Blob, fileName: string): Promise<AudioPresenceResult> => {
      if (fileName === 'silent.mp4') return { status: 'absent' };
      if (fileName === 'sound.mp4') return { status: 'present', streams: 1 };
      return { status: 'unknown', reason: 'no metadata reader for this container' };
    }),
    ...overrides,
  };
}

describe('findSilentVideoAssetIds', () => {
  it('drops only the video proven to have no audio stream', async () => {
    const silent = await findSilentVideoAssetIds(
      ['silent', 'sound', 'unknownAudio'],
      assets,
      probe(),
    );
    expect([...silent]).toEqual(['silent']);
  });

  it('never treats an unknown result as silence, so the source still decodes and fails visibly', async () => {
    const silent = await findSilentVideoAssetIds(['unknownAudio'], assets, probe());
    expect(silent.size).toBe(0);
  });

  it('keeps a source whose bytes cannot be read in the mix', async () => {
    const silent = await findSilentVideoAssetIds(['unreadable'], assets, probe());
    expect(silent.size).toBe(0);
  });

  it('ignores audio-only and image sources entirely', async () => {
    const inspect = vi.fn();
    const silent = await findSilentVideoAssetIds(['music', 'picture'], assets, probe({ inspect }));
    expect(silent.size).toBe(0);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('prefers the desktop ffprobe answer when it is conclusive', async () => {
    const desktop = vi.fn(async (): Promise<AudioPresenceResult> => ({
      status: 'present',
      streams: 2,
    }));
    const inspect = vi.fn();
    const silent = await findSilentVideoAssetIds(['silent'], assets, probe({ desktop, inspect }));
    expect(desktop).toHaveBeenCalledOnce();
    expect(inspect).not.toHaveBeenCalled();
    expect(silent.size).toBe(0);
  });

  it('falls back to the browser check when the desktop answer is unknown', async () => {
    const desktop = vi.fn(async (): Promise<AudioPresenceResult> => ({
      status: 'unknown',
      reason: 'not-staged',
    }));
    const silent = await findSilentVideoAssetIds(['silent'], assets, probe({ desktop }));
    expect([...silent]).toEqual(['silent']);
  });

  it('falls back to the browser check when the desktop call throws', async () => {
    const desktop = vi.fn(async () => {
      throw new Error('bridge refused');
    });
    const silent = await findSilentVideoAssetIds(['silent'], assets, probe({ desktop }));
    expect([...silent]).toEqual(['silent']);
  });

  it('reports progress per video source it checks', async () => {
    const onStatus = vi.fn();
    await findSilentVideoAssetIds(['silent', 'sound'], assets, probe(), onStatus);
    expect(onStatus).toHaveBeenCalledWith('Checking audio in silent.mp4…');
    expect(onStatus).toHaveBeenCalledWith('Checking audio in sound.mp4…');
  });
});
