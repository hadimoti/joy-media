import type { CaptionDocumentV1 } from '@joy-media/project-schema';

export interface ProviderManifest {
  readonly id: string;
  readonly version: 1;
  readonly capabilities: readonly ['speech.transcribe'];
}
export interface TranscriptionWord {
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly confidence?: number;
  readonly speakerId?: string;
}
export interface TranscriptionResult {
  readonly language: string;
  readonly words: readonly TranscriptionWord[];
  readonly speakers?: readonly { readonly id: string; readonly name: string }[];
  readonly provenance: {
    readonly providerId: string;
    readonly modelId: string;
    readonly createdAt: string;
  };
}
export interface Provider {
  readonly manifest: ProviderManifest;
  invoke(
    capability: 'speech.transcribe',
    input: { readonly assetId: string; readonly language?: string },
  ): Promise<TranscriptionResult>;
}
export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE';
}
export function createLocalWhisperProvider(
  execute: Provider['invoke'],
  modelId = 'whisper-local',
): Provider {
  return {
    manifest: { id: 'joy.local-whisper', version: 1, capabilities: ['speech.transcribe'] },
    invoke: async (capability, input) => {
      try {
        const result = await execute(capability, input);
        return {
          ...result,
          provenance: { ...result.provenance, providerId: 'joy.local-whisper', modelId },
        };
      } catch (error) {
        throw new ProviderUnavailableError(
          `local Whisper runtime unavailable: ${(error as Error).message}`,
        );
      }
    },
  };
}
/** Normalized result -> durable source-token document; insertion remains a caption command. */
export function captionDocumentFromTranscription(
  id: string,
  result: TranscriptionResult,
): CaptionDocumentV1 {
  const words = Object.fromEntries(
    result.words.map((word, index) => [`word-${index}`, { id: `word-${index}`, ...word }]),
  );
  return {
    id,
    language: result.language,
    direction: 'auto',
    speakers: result.speakers ?? [],
    words,
    segments:
      result.words.length === 0
        ? []
        : [
            {
              id: 'segment-0',
              startUs: result.words[0]!.startUs,
              endUs: result.words.at(-1)!.endUs,
              wordIds: result.words.map((_, index) => `word-${index}`),
            },
          ],
    provenance: result.provenance,
  };
}
