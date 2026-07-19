import {
  captionDocumentFromTranscription,
  createLocalWhisperProvider,
} from '@joy-media/provider-sdk';
import type { CaptionDocumentV1 } from '@joy-media/project-schema';

/** Deterministic local-adapter smoke data; swap its executor for installed Whisper runtime wiring. */
const provider = createLocalWhisperProvider(async (_capability, input) => {
  const persian = input.language?.startsWith('fa') === true;
  const tokens = persian ? ['سلام', 'JOY', 'دنیا'] : ['Hello', 'JOY', 'world'];
  return {
    language: persian ? 'fa-IR' : 'en-US',
    words: tokens.map((text, index) => ({
      text,
      startUs: index * 500_000,
      endUs: (index + 1) * 500_000,
      confidence: 0.95,
      speakerId: 'speaker-1',
    })),
    speakers: [{ id: 'speaker-1', name: 'Local speaker' }],
    provenance: { providerId: 'local', modelId: 'pending', createdAt: '2026-07-19T00:00:00.000Z' },
  };
}, 'local-whisper-reference');
export async function transcribeReferenceCaption(
  documentId: string,
  language: 'fa-IR' | 'en-US',
): Promise<CaptionDocumentV1> {
  return captionDocumentFromTranscription(
    documentId,
    await provider.invoke('speech.transcribe', { assetId: `reference-${language}`, language }),
  );
}
