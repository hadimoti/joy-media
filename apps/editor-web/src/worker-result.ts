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

/**
 * Verify a Worker-produced audio derivative before it can enter a creative
 * document. The browser never trusts the job receipt alone: it checks the
 * owner-authorized bytes, length, digest, MIME, and derivative kind again.
 */
export async function verifyWorkerAudioDerivative(input: {
  readonly jobId: string;
  readonly sourceAssetId: string;
  readonly sourceAssetSha256?: string;
  readonly derivative: BrowserDerivative;
  readonly blob: Blob;
  readonly now?: string;
}): Promise<VerifiedWorkerAudioResult> {
  const { derivative, blob } = input;
  if (derivative.kind !== 'audio') throw new Error('Worker result is not an audio derivative');
  if (blob.size !== derivative.bytes)
    throw new Error('Worker audio result byte length does not match its receipt');
  const expectedMime = derivative.descriptor.mimeType.toLowerCase();
  if (blob.type !== '' && blob.type.toLowerCase() !== expectedMime)
    throw new Error('Worker audio result MIME does not match its receipt');
  const digest = hex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())),
  );
  if (digest !== derivative.sha256.toLowerCase())
    throw new Error('Worker audio result SHA-256 does not match its receipt');
  const generatedAssetId = `processed-${input.jobId}`;
  const createdAt = input.now ?? new Date().toISOString();
  return {
    jobId: input.jobId,
    sourceAssetId: input.sourceAssetId,
    derivativeId: derivative.id,
    sha256: derivative.sha256,
    bytes: derivative.bytes,
    descriptor: derivative.descriptor,
    blob,
    generatedAsset: {
      id: generatedAssetId,
      kind: 'audio',
      displayName: `Processed audio · ${input.sourceAssetId}`,
      sha256: derivative.sha256,
      bytes: derivative.bytes,
      descriptor: {
        mimeType: derivative.descriptor.mimeType,
        ...(derivative.descriptor.durationUs === undefined
          ? {}
          : { durationUs: derivative.descriptor.durationUs }),
      },
      generationProvenance: {
        providerId: 'local-worker',
        modelId: 'audio.ml-denoise',
        modelVersion: 'worker-receipt',
        prompt: '',
        inputAssetHashes: [input.sourceAssetSha256 ?? input.sourceAssetId],
        parameters: { jobId: input.jobId, derivativeId: derivative.id },
        generatedAssetId,
        createdAt,
      },
    },
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
