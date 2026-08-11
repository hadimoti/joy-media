import { describe, expect, it } from 'vitest';
import { BrowserControlPlaneClient } from './control-plane-client.js';

describe('BrowserControlPlaneClient denoiseAudio', () => {
  it('posts authenticated base64 media and returns the verified denoise result', async () => {
    let request:
      | { readonly url: string; readonly authorization: string | null; readonly body: unknown }
      | undefined;
    const result = {
      assetId: 'asset-clean',
      mimeType: 'audio/wav',
      bytesBase64: 'Y2xlYW4=',
      method: 'ffmpeg-afftdn' as const,
      strength: 0.72,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      request = {
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization'),
        body: JSON.parse(String(init?.body)) as unknown,
      };
      return new Response(JSON.stringify({ data: result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(
        client.denoiseAudio({
          projectId: 'project-1',
          operationId: 'cloud-audio-asset-original-podcast',
          assetId: 'asset-original',
          media: new Blob(['noise'], { type: 'audio/wav' }),
          sampleRate: 48_000,
          strength: 0.72,
        }),
      ).resolves.toEqual(result);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(request).toEqual({
      url: 'https://media.joyteam.ir/api/v1/providers/audio/denoise',
      authorization: 'Bearer joy-session-token',
      body: {
        projectId: 'project-1',
        operationId: 'cloud-audio-asset-original-podcast',
        assetId: 'asset-original',
        mediaBase64: 'bm9pc2U=',
        sampleRate: 48_000,
        strength: 0.72,
      },
    });
  });

  it('looks up an accepted operation without sending source media again', async () => {
    let requestUrl: string | undefined;
    const operation = {
      projectId: 'project with space',
      operationId: 'cloud/audio?one',
      status: 'succeeded' as const,
      result: {
        assetId: 'asset-clean',
        mimeType: 'audio/wav',
        bytesBase64: 'Y2xlYW4=',
        method: 'ffmpeg-afftdn' as const,
        strength: 0.8,
      },
      createdAt: 1,
      updatedAt: 2,
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input: RequestInfo | URL) => {
      requestUrl = String(input);
      return new Response(JSON.stringify({ data: operation }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(
        client.denoiseAudioOperation('project with space', 'cloud/audio?one'),
      ).resolves.toEqual(operation);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(requestUrl).toBe(
      'https://media.joyteam.ir/api/v1/providers/audio/denoise?projectId=project+with+space&operationId=cloud%2Faudio%3Fone',
    );
  });

  it('returns undefined only for the typed operation-not-found recovery response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 'PROVIDER_OPERATION_NOT_FOUND',
            message: 'operation was not claimed',
          },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );

    try {
      const client = new BrowserControlPlaneClient(
        'https://media.joyteam.ir/api',
        () => 'joy-session-token',
      );
      await expect(
        client.denoiseAudioOperation('project-1', 'unclaimed-operation'),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
