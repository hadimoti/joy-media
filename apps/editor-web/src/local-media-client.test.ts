import { describe, expect, it, vi } from 'vitest';
import type { BrowserAssetRegistration } from './control-plane-client.js';
import {
  BrowserControlPlaneClient,
  DesktopSpeechError,
  type DesktopMediaBridge,
  type SpeechSynthesizeV1,
  type SpeechTranscribeV1,
} from './local-media-client.js';

describe('BrowserControlPlaneClient internal staged exports', () => {
  it('registers the internal flag and cleans up by the staged registration id', async () => {
    const bridge: DesktopMediaBridge = {
      invoke: vi.fn(async () => ({ removed: true })),
    };
    const client = new BrowserControlPlaneClient(bridge);
    const asset = {
      id: 'stage-attempt-4',
      kind: 'video',
      displayName: 'render.mp4.stage',
      sha256: 'c'.repeat(64),
      bytes: 42,
      descriptor: { mimeType: 'video/mp4' },
      locations: [{ kind: 'opfs-cache', ref: 'export-stage-4' }],
      internal: true,
    } as BrowserAssetRegistration;

    await client.registerAsset('project-1', asset);
    expect(bridge.invoke).toHaveBeenNthCalledWith(
      1,
      'desktop.media.asset.register',
      expect.objectContaining({ internal: true }),
    );

    await client.deleteInternalAsset('project-1', asset.id);
    expect(bridge.invoke).toHaveBeenNthCalledWith(2, 'desktop.media.asset.remove-internal', {
      assetId: asset.id,
    });
  });
});

describe('BrowserControlPlaneClient local masks', () => {
  it('sends a mask job through desktop.media.mask.run and reports its result as a mask derivative', async () => {
    const view = {
      id: 'desktop-job-1',
      jobType: 'mask.video',
      status: 'done',
      progress: 100,
      cancelRequested: false,
      derivative: { sha256: 'd'.repeat(64), bytes: 1234, mimeType: 'video/webm' },
    };
    const invoke = vi.fn(async (channel: string) =>
      channel === 'desktop.media.mask.run' ? { jobId: 'desktop-job-1' } : view,
    );
    const client = new BrowserControlPlaneClient({ invoke } as DesktopMediaBridge);

    const queued = await client.enqueueMask('p-mask', 'editor-job-1', 'mask.video', 'asset-1', {
      mode: 'subject',
    });
    expect(invoke).toHaveBeenCalledWith('desktop.media.mask.run', {
      refId: 'asset-1',
      jobType: 'mask.video',
      payload: { mode: 'subject' },
    });
    expect(queued).toMatchObject({ id: 'editor-job-1', type: 'mask.video', state: 'queued' });

    const [job] = await client.jobs('p-mask');
    expect(job).toMatchObject({
      id: 'editor-job-1',
      state: 'completed',
      derivative: { kind: 'mask', bytes: 1234 },
    });
    const [derivative] = await client.derivatives('p-mask', 'asset-1');
    expect(derivative).toMatchObject({
      // The editor picks its result by this id; a different id would fall back to the newest mask of the asset.
      id: 'editor-job-1',
      kind: 'mask',
      profile: 'mask-matte',
      descriptor: { mimeType: 'video/webm' },
    });
  });
});

describe('BrowserControlPlaneClient local speech jobs', () => {
  const request: SpeechTranscribeV1 = {
    schemaVersion: 1,
    language: 'fa-IR',
    modelId: 'faster-whisper-large-v3-turbo',
  };

  it('starts transcription by asset and reads its checked JSON derivative', async () => {
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        language: 'fa-IR',
        words: [{ text: 'سلام', startUs: 0, endUs: 400_000, confidence: 0.9 }],
        speakers: [],
        provenance: {
          providerId: 'local',
          modelId: 'faster-whisper-large-v3-turbo',
          createdAt: '2026-11-22T00:00:00.000Z',
        },
      }),
    );
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.media.speech.run') return { jobId: 'desktop-speech-1' };
      if (channel === 'desktop.media.job.status') {
        return {
          id: 'desktop-speech-1',
          jobType: 'speech.transcribe',
          status: 'done',
          progress: 100,
          cancelRequested: false,
          derivative: {
            sha256: 'a'.repeat(64),
            bytes: bytes.byteLength,
            mimeType: 'application/json',
          },
        };
      }
      if (channel === 'desktop.media.derivative.transfer.begin') {
        return {
          transferId: 'transfer-1',
          mimeType: 'application/json',
          sha256: 'a'.repeat(64),
          size: bytes.byteLength,
          chunkBytes: bytes.byteLength,
        };
      }
      if (channel === 'desktop.media.derivative.transfer.chunk') {
        return { offset: 0, bytes };
      }
      if (channel === 'desktop.media.derivative.transfer.finish') {
        return { sha256: 'a'.repeat(64), size: bytes.byteLength };
      }
      return {};
    });
    const client = new BrowserControlPlaneClient({ invoke } as DesktopMediaBridge);
    const progress: number[] = [];

    const transcript = await client.runLocalTranscription(
      'project-speech',
      'asset-speech',
      request,
      undefined,
      (percent) => progress.push(percent),
    );

    expect(invoke).toHaveBeenCalledWith('desktop.media.speech.run', {
      jobType: 'speech.transcribe',
      refId: 'asset-speech',
      payload: request,
    });
    expect(transcript.words[0]?.text).toBe('سلام');
    expect(progress).toEqual([100]);
    expect(invoke).toHaveBeenCalledWith('desktop.media.derivative.transfer.finish', {
      transferId: 'transfer-1',
    });
  });

  it('sends only one cancellation request and ignores the late poll result', async () => {
    let finishStatus!: (value: unknown) => void;
    const invoke = vi.fn((channel: string): Promise<unknown> => {
      if (channel === 'desktop.media.speech.run')
        return Promise.resolve({ jobId: 'desktop-speech-2' });
      if (channel === 'desktop.media.job.status') {
        return new Promise((resolve) => {
          finishStatus = resolve;
        });
      }
      return Promise.resolve({ canceled: true });
    });
    const client = new BrowserControlPlaneClient({ invoke } as DesktopMediaBridge);
    const controller = new AbortController();

    const work = client.runLocalTranscription(
      'project-cancel',
      'asset-cancel',
      request,
      controller.signal,
    );
    await vi.waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('desktop.media.job.status', {
        jobId: 'desktop-speech-2',
      }),
    );
    controller.abort();
    await expect(work).rejects.toMatchObject({ code: 'CANCELED' });
    finishStatus({ status: 'done', progress: 100 });
    await Promise.resolve();

    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'desktop.media.job.cancel'),
    ).toHaveLength(1);
    expect(invoke).not.toHaveBeenCalledWith(
      'desktop.media.derivative.transfer.begin',
      expect.anything(),
    );
  });

  it('preserves typed polling errors and stops after the failed poll', async () => {
    const failure = new DesktopSpeechError('SETUP_REQUIRED', 'Speech model setup is required');
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.media.speech.run') return { jobId: 'desktop-speech-3' };
      if (channel === 'desktop.media.job.status') throw failure;
      return {};
    });
    const client = new BrowserControlPlaneClient({ invoke } as DesktopMediaBridge);

    await expect(
      client.runLocalTranscription('project-fail', 'asset-fail', request),
    ).rejects.toMatchObject({ code: 'SETUP_REQUIRED' });
    expect(
      invoke.mock.calls.filter(([channel]) => channel === 'desktop.media.job.status'),
    ).toHaveLength(1);
  });

  it('reports speech models and omits the reference for built-in synthesis', async () => {
    const audioBytes = new Uint8Array([82, 73, 70, 70]);
    const timing = { durationUs: 1_000_000, timingSource: 'unavailable', words: [] } as const;
    const invoke = vi.fn(async (channel: string) => {
      if (channel === 'desktop.media.speech.status') {
        return { models: [{ modelId: 'kokoro-82m', state: 'ready' }] };
      }
      if (channel === 'desktop.media.speech.run') return { jobId: 'desktop-speech-tts' };
      if (channel === 'desktop.media.job.status') {
        return {
          status: 'done',
          progress: 100,
          cancelRequested: false,
          speech: timing,
        };
      }
      if (channel === 'desktop.media.derivative.transfer.begin') {
        return {
          transferId: 'audio-transfer',
          mimeType: 'audio/wav',
          sha256: 'c'.repeat(64),
          size: audioBytes.byteLength,
          chunkBytes: audioBytes.byteLength,
        };
      }
      if (channel === 'desktop.media.derivative.transfer.chunk') {
        return { offset: 0, bytes: audioBytes };
      }
      if (channel === 'desktop.media.derivative.transfer.finish') {
        return { sha256: 'c'.repeat(64), size: audioBytes.byteLength };
      }
      return {};
    });
    const client = new BrowserControlPlaneClient({ invoke } as DesktopMediaBridge);
    const status = await client.speechStatus();
    const request: SpeechSynthesizeV1 = {
      schemaVersion: 1,
      language: 'en-US',
      modelId: 'kokoro-82m',
      text: 'Hello',
    };

    expect(status.models).toEqual([{ modelId: 'kokoro-82m', state: 'ready' }]);
    const result = await client.runLocalSynthesis('project-tts', request, {
      consent: { acknowledged: true, purpose: 'general' },
    });
    expect(invoke).toHaveBeenCalledWith('desktop.media.speech.run', {
      jobType: 'speech.synthesize',
      payload: request,
      consent: { acknowledged: true, purpose: 'general' },
    });
    expect(result.audio.type).toBe('audio/wav');
    expect(result.timing).toEqual(timing);
  });

  it('surfaces derivative expiry and malformed chunks', async () => {
    const makeClient = (failureMode: 'expired' | 'malformed') => {
      const invoke = vi.fn(async (channel: string) => {
        if (channel === 'desktop.media.speech.run') return { jobId: `desktop-${failureMode}` };
        if (channel === 'desktop.media.job.status') {
          return { status: 'done', progress: 100, cancelRequested: false };
        }
        if (channel === 'desktop.media.derivative.transfer.begin') {
          if (failureMode === 'expired') throw new Error('Derivative transfer expired');
          return {
            transferId: 'bad-transfer',
            mimeType: 'application/json',
            sha256: 'b'.repeat(64),
            size: 4,
            chunkBytes: 4,
          };
        }
        if (channel === 'desktop.media.derivative.transfer.chunk') {
          return { offset: 1, bytes: new Uint8Array([1, 2, 3, 4]) };
        }
        return {};
      });
      return new BrowserControlPlaneClient({ invoke } as DesktopMediaBridge);
    };

    await expect(
      makeClient('expired').runLocalTranscription('project-expired', 'asset-1', request),
    ).rejects.toThrow('Derivative transfer expired');
    await expect(
      makeClient('malformed').runLocalTranscription('project-malformed', 'asset-1', request),
    ).rejects.toThrow('invalid derivative transfer chunk');
  });
});
