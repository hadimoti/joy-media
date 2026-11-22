import {
  captionDocumentFromTranscription,
  createLocalWhisperProvider,
  ProviderUnavailableError,
} from '@joy-media/provider-sdk';
import type { CaptionDocumentV1 } from '@joy-media/project-schema';
import { BrowserControlPlaneClient } from './control-plane-client.js';
import {
  DesktopSpeechError,
  type SpeechTranscribeV1,
} from './local-media-client.js';

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

/** Fixture-backed language transcripts (WP-20). Used when live Whisper API is unavailable. */
const FIXTURES: Readonly<Record<'fa-IR' | 'en-US', TranscriptionFixture>> = {
  'fa-IR': {
    language: 'fa-IR',
    modelId: 'fixture-whisper-fa-v1',
    speakers: [{ id: 'speaker-1', name: 'Local speaker' }],
    words: [
      { text: 'سلام', startUs: 0, endUs: 400_000, confidence: 0.97, speakerId: 'speaker-1' },
      { text: 'به', startUs: 400_000, endUs: 650_000, confidence: 0.94, speakerId: 'speaker-1' },
      {
        text: 'استودیوی',
        startUs: 650_000,
        endUs: 1_200_000,
        confidence: 0.96,
        speakerId: 'speaker-1',
      },
      {
        text: 'جوی',
        startUs: 1_200_000,
        endUs: 1_550_000,
        confidence: 0.98,
        speakerId: 'speaker-1',
      },
      {
        text: 'خوش',
        startUs: 1_550_000,
        endUs: 1_850_000,
        confidence: 0.95,
        speakerId: 'speaker-1',
      },
      {
        text: 'آمدید',
        startUs: 1_850_000,
        endUs: 2_400_000,
        confidence: 0.96,
        speakerId: 'speaker-1',
      },
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
      {
        text: 'Media',
        startUs: 1_100_000,
        endUs: 1_500_000,
        confidence: 0.98,
        speakerId: 'speaker-1',
      },
      {
        text: 'studio',
        startUs: 1_500_000,
        endUs: 2_100_000,
        confidence: 0.96,
        speakerId: 'speaker-1',
      },
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
  media?: Blob,
  mediaType?: string,
) {
  if (media !== undefined) {
    return client.transcribeSpeech(
      language,
      mediaType === undefined ? { media } : { media, mediaType },
    );
  }
  return client.transcribeSpeech(language, {
    referenceAssetId: REFERENCE_ASSET_BY_LANGUAGE[language],
  });
}

/**
 * Caption transcription: prefer authenticated faster-whisper API,
 * fall back to committed fixtures when unsigned or the provider is down.
 */
export async function transcribeReferenceCaption(
  documentId: string,
  language: 'fa-IR' | 'en-US',
  client: BrowserControlPlaneClient = new BrowserControlPlaneClient(),
  options: {
    readonly media?: Blob;
    readonly mediaType?: string;
    readonly workerRequest?: {
      readonly projectId: string;
      readonly assetId: string;
      readonly request: SpeechTranscribeV1;
    };
    readonly loadMedia?: () => Promise<{ readonly media: Blob; readonly mediaType?: string }>;
    readonly signal?: AbortSignal;
    readonly onProgress?: (percent: number) => void;
  } = {},
): Promise<CaptionDocumentV1> {
  if (options.workerRequest !== undefined) {
    const worker = options.workerRequest;
    try {
      const transcript = await client.runLocalTranscription(
        worker.projectId,
        worker.assetId,
        worker.request,
        options.signal,
        options.onProgress,
      );
      return captionDocumentFromTranscription(documentId, transcript);
    } catch (error) {
      const canUseLoopback =
        error instanceof DesktopSpeechError &&
        (error.code === 'SETUP_REQUIRED' || error.code === 'SOURCE_UNAVAILABLE');
      if (!canUseLoopback || options.loadMedia === undefined) throw error;
      const loaded = await options.loadMedia();
      if (options.signal?.aborted) {
        throw new DesktopSpeechError('CANCELED', 'Speech job canceled');
      }
      const live = await client.transcribeSpeech(
        language,
        loaded.mediaType === undefined
          ? { media: loaded.media }
          : { media: loaded.media, mediaType: loaded.mediaType },
      );
      if (options.signal?.aborted) {
        throw new DesktopSpeechError('CANCELED', 'Speech job canceled');
      }
      return captionDocumentFromTranscription(documentId, {
        language: live.language,
        words: live.words,
        speakers: live.speakers,
        provenance: live.provenance,
      });
    }
  }
  try {
    const live = await tryLiveTranscription(language, client, options.media, options.mediaType);
    return captionDocumentFromTranscription(documentId, {
      language: live.language,
      words: live.words,
      speakers: live.speakers,
      provenance: live.provenance,
    });
  } catch (error) {
    if (options.media !== undefined) {
      if (
        error instanceof Error &&
        (error.message === 'Local Whisper is not configured.' ||
          error.message === 'The saved local Whisper endpoint was refused.')
      ) {
        throw new Error(error.message);
      }
      // Keep the reason, short and on one line, so the owner can tell a refused file from a down server.
      const reason = (error instanceof Error ? error.message : '').replace(/\s+/g, ' ').trim();
      throw new Error(
        reason.length === 0
          ? 'Live transcription could not process the selected media.'
          : `Live transcription could not process the selected media. ${reason.slice(0, 160)}`,
      );
    }
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
