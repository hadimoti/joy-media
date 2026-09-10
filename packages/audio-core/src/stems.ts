import { sha256Bytes } from './sha256.js';

export interface PreviewStem {
  readonly stemId: string;
  readonly clipId: string;
  readonly effectId: string;
  readonly hash: string;
  readonly samples: Float32Array;
  readonly sampleRate: number;
  readonly createdAt: string;
  readonly validUntil?: string;
}

export class PreviewStemCache {
  private stems = new Map<string, PreviewStem>();

  get(stemId: string): PreviewStem | undefined {
    return this.stems.get(stemId);
  }

  set(stem: PreviewStem): void {
    this.stems.set(stem.stemId, stem);
  }

  invalidate(clipId: string): void {
    for (const [stemId, stem] of this.stems.entries()) {
      if (stem.clipId === clipId) {
        this.stems.delete(stemId);
      }
    }
  }

  invalidateAll(): void {
    this.stems.clear();
  }

  hasValidStem(clipId: string, effectId: string, inputHash: string): boolean {
    for (const stem of this.stems.values()) {
      if (stem.clipId === clipId && stem.effectId === effectId && stem.hash === inputHash) {
        return true;
      }
    }
    return false;
  }

  getStemForClip(clipId: string, effectId: string): PreviewStem | undefined {
    for (const stem of this.stems.values()) {
      if (stem.clipId === clipId && stem.effectId === effectId) {
        return stem;
      }
    }
    return undefined;
  }
}

export function computeStemHash(effectParams: unknown, inputSamples: Float32Array): string {
  const effectParamsBytes = new TextEncoder().encode(JSON.stringify(effectParams));
  const samplesBytes = new Uint8Array(
    inputSamples.buffer,
    inputSamples.byteOffset,
    inputSamples.byteLength,
  );
  const combined = new Uint8Array(effectParamsBytes.length + samplesBytes.length);
  combined.set(effectParamsBytes);
  combined.set(samplesBytes, effectParamsBytes.length);
  return sha256Bytes(combined);
}
