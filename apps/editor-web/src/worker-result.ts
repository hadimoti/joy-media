import type { AssetRecordV1 } from '@joy-media/project-schema';
import type { BrowserDerivative } from './control-plane-client.js';

export interface VerifiedWorkerAudioResult {
  readonly jobId: string;
  readonly sourceAssetId: string;
  readonly derivativeId: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly descriptor: {
    readonly mimeType: string;
    readonly durationUs?: number;
  };
  readonly blob: Blob;
  readonly generatedAsset: AssetRecordV1;
}

export interface DecodedWorkerAudio {
  readonly durationUs: number;
}

export type WorkerAudioDecoder = (blob: Blob) => Promise<DecodedWorkerAudio>;

/**
 * Verify a Worker-produced audio derivative before it can enter a creative
 * document. The browser never trusts the job receipt alone: it checks the
 * owner-authorized bytes, length, digest, MIME, and derivative kind again.
 */
export async function verifyWorkerAudioDerivative(input: {
  readonly jobId: string;
  readonly sourceAssetId: string;
  readonly sourceAssetSha256: string;
  readonly derivative: BrowserDerivative;
  readonly blob: Blob;
  readonly decodeAudio?: WorkerAudioDecoder;
  readonly now?: string;
}): Promise<VerifiedWorkerAudioResult> {
  const { derivative, blob } = input;
  if (derivative.kind !== 'audio') throw new Error('Worker result is not an audio derivative');
  if (derivative.assetId !== input.sourceAssetId)
    throw new Error('Worker audio result does not belong to the selected source asset');
  if (blob.size !== derivative.bytes)
    throw new Error('Worker audio result byte length does not match its receipt');
  const expectedMime = derivative.descriptor.mimeType.toLowerCase();
  if (!expectedMime.startsWith('audio/'))
    throw new Error('Worker audio result receipt does not declare an audio MIME type');
  if (blob.type !== '' && blob.type.toLowerCase() !== expectedMime)
    throw new Error('Worker audio result MIME does not match its receipt');
  if (!/^[a-f0-9]{64}$/i.test(input.sourceAssetSha256))
    throw new Error('Worker audio result source SHA-256 is unavailable');
  const digest = hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
  );
  if (digest !== derivative.sha256.toLowerCase())
    throw new Error('Worker audio result SHA-256 does not match its receipt');
  let decoded: DecodedWorkerAudio;
  try {
    decoded = await (input.decodeAudio ?? decodeWorkerAudioBlob)(blob);
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Worker audio result is not decodable${detail}`);
  }
  if (!Number.isSafeInteger(decoded.durationUs) || decoded.durationUs <= 0)
    throw new Error('Worker audio result decoded with an invalid duration');
  const generatedAssetId = `processed-${input.jobId}`;
  const createdAt = input.now ?? new Date().toISOString();
  return {
    jobId: input.jobId,
    sourceAssetId: input.sourceAssetId,
    derivativeId: derivative.id,
    sha256: derivative.sha256,
    bytes: derivative.bytes,
    descriptor: {
      ...derivative.descriptor,
      durationUs: derivative.descriptor.durationUs ?? decoded.durationUs,
    },
    blob,
    generatedAsset: {
      id: generatedAssetId,
      kind: 'audio',
      displayName: `Processed audio · ${input.sourceAssetId}`,
      sha256: derivative.sha256,
      bytes: derivative.bytes,
      descriptor: {
        mimeType: derivative.descriptor.mimeType,
        durationUs: derivative.descriptor.durationUs ?? decoded.durationUs,
      },
      generationProvenance: {
        providerId: 'local-worker',
        modelId: 'audio.ml-denoise',
        modelVersion: 'worker-receipt',
        prompt: '',
        inputAssetHashes: [input.sourceAssetSha256.toLowerCase()],
        parameters: { jobId: input.jobId, derivativeId: derivative.id },
        generatedAssetId,
        createdAt,
      },
    },
  };
}

/** Decode through the browser media stack before verified bytes enter a project. */
export async function decodeWorkerAudioBlob(blob: Blob): Promise<DecodedWorkerAudio> {
  const AudioContextConstructor = globalThis.AudioContext;
  if (AudioContextConstructor === undefined)
    throw new Error('Worker audio result cannot be decoded in this browser');

  const context = new AudioContextConstructor();
  try {
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const durationUs = Math.round(buffer.duration * 1_000_000);
    if (!Number.isSafeInteger(durationUs) || durationUs <= 0)
      throw new Error('decoded audio duration is invalid');
    return { durationUs };
  } catch (error) {
    const detail = error instanceof Error ? `: ${error.message}` : '';
    throw new Error(`Worker audio result is not decodable${detail}`);
  } finally {
    await context.close().catch(() => undefined);
  }
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
