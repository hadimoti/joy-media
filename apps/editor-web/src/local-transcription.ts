import {
  captionDocumentFromTranscription,
  createLocalWhisperProvider,
  ProviderUnavailableError,
} from '@joy-media/provider-sdk';
import type { CaptionDocumentV1 } from '@joy-media/project-schema';
import { BrowserControlPlaneClient } from './control-plane-client.js';

interface TranscriptionFixture {
  readonly language: string;
  readonly modelId: string;
  readonly speakers: readonly { readonly id: string; readonly name: string }[];
  readonly words: readonly {
    readonly text: string;
    readonly startUs: number;
    readonly endUs: number;
    readonly confidence: number;
    readonly speakerId: string;
  }[];
}

/** Fixture-backed FA/EN transcripts (WP-20). Used when live Whisper API is unavailable. */
const FIXTURES: Readonly<Record<'fa-IR' | 'en-US', TranscriptionFixture>> = {
  'fa-IR': {
    language: 'fa-IR',
    modelId: 'fixture-whisper-fa-v1',
    speakers: [{ id: 'speaker-1', name: 'گوینده محلی' }],
    words: [
      { text: 'سلام', startUs: 0, endUs: 400_000, confidence: 0.97, speakerId: 'speaker-1' },
      { text: 'به', startUs: 400_000, endUs: 650_000, confidence: 0.94, speakerId: 'speaker-1' },
      { text: 'استودیوی', startUs: 650_000, endUs: 1_200_000, confidence: 0.96, speakerId: 'speaker-1' },
      { text: 'جوی', startUs: 1_200_000, endUs: 1_550_000, confidence: 0.98, speakerId: 'speaker-1' },
      { text: 'خوش', startUs: 1_550_000, endUs: 1_850_000, confidence: 0.95, speakerId: 'speaker-1' },
      { text: 'آمدید', startUs: 1_850_000, endUs: 2_400_000, confidence: 0.96, speakerId: 'speaker-1' },
    ],
  },
  'en-US': {
    language: 'en-US',
    modelId: 'fixture-whisper-en-v1',
    speakers: [{ id: 'speaker-1', name: 'Local speaker' }],
    words: [
      { text: 'Welcome', startUs: 0, endUs: 450_000, confidence: 0.97, speakerId: 'speaker-1' },
      { text: 'to', startUs: 450_000, endUs: 650_000, confidence: 0.95, speakerId: 'speaker-1' },
      { text: 'the', startUs: 650_000, endUs: 800_000, confidence: 0.94, speakerId: 'speaker-1' },
      { text: 'JOY', startUs: 800_000, endUs: 1_100_000, confidence: 0.99, speakerId: 'speaker-1' },
      { text: 'Media', startUs: 1_100_000, endUs: 1_500_000, confidence: 0.98, speakerId: 'speaker-1' },
      { text: 'studio', startUs: 1_500_000, endUs: 2_100_000, confidence: 0.96, speakerId: 'speaker-1' },
    ],
  },
};

const REFERENCE_ASSET_BY_LANGUAGE: Readonly<Record<'fa-IR' | 'en-US', string>> = {
  'fa-IR': 'asset-intro',
  'en-US': 'asset-intro',
};

function fixtureProvider(language: 'fa-IR' | 'en-US') {
  const fixture = FIXTURES[language];
  return createLocalWhisperProvider(async (_capability, input) => {
    if (input.language !== undefined && !String(input.language).startsWith(language.slice(0, 2))) {
      throw new ProviderUnavailableError(
        `No transcription fixture for language ${String(input.language)}`,
      );
    }
    return {
      language: fixture.language,
      words: fixture.words.map((word) => ({ ...word })),
      speakers: fixture.speakers.map((speaker) => ({ ...speaker })),
      provenance: {
        providerId: 'local',
        modelId: fixture.modelId,
        createdAt: '2026-07-23T00:00:00.000Z',
      },
    };
  }, fixture.modelId);
}

async function tryLiveTranscription(
  language: 'fa-IR' | 'en-US',
  client: BrowserControlPlaneClient,
) {
  return client.transcribeSpeech(language, {
    referenceAssetId: REFERENCE_ASSET_BY_LANGUAGE[language],
  });
}

/**
 * Captions FA/EN transcription: prefer authenticated faster-whisper API,
 * fall back to committed fixtures when unsigned or the provider is down.
 */
export async function transcribeReferenceCaption(
  documentId: string,
  language: 'fa-IR' | 'en-US',
  client: BrowserControlPlaneClient = new BrowserControlPlaneClient(),
): Promise<CaptionDocumentV1> {
  try {
    const live = await tryLiveTranscription(language, client);
    return captionDocumentFromTranscription(documentId, {
      language: live.language,
      words: live.words,
      speakers: live.speakers,
      provenance: live.provenance,
    });
  } catch {
    const provider = fixtureProvider(language);
    return captionDocumentFromTranscription(
      documentId,
      await provider.invoke('speech.transcribe', {
        assetId: `reference-${language}`,
        language,
      }),
    );
  }
}
