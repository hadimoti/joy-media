import {
  captionDocumentFromTranscription,
  ProviderUnavailableError,
} from '@joy-media/provider-sdk';
import type { CaptionDocumentV1 } from '@joy-media/project-schema';
import { BrowserControlPlaneClient } from './control-plane-client.js';

const REFERENCE_ASSET_BY_LANGUAGE: Readonly<Record<'fa-IR' | 'en-US', string>> = {
  'fa-IR': 'asset-intro',
  'en-US': 'asset-intro',
};

async function tryLiveTranscription(
  language: 'fa-IR' | 'en-US',
  client: BrowserControlPlaneClient,
) {
  return client.transcribeSpeech(language, {
    referenceAssetId: REFERENCE_ASSET_BY_LANGUAGE[language],
  });
}

/**
 * Captions FA/EN transcription uses only the authenticated faster-whisper API.
 * Production must fail closed when the provider is unavailable; deterministic
 * transcripts belong in focused tests and fixture libraries, not this path.
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
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ProviderUnavailableError(
      `Live transcription is unavailable for ${language}. Connect to the transcription provider and try again (${detail}).`,
    );
  }
}
