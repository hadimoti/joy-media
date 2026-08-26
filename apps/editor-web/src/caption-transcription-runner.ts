import {
  captionDocumentFromTranscription,
  ProviderUnavailableError,
} from '@joy-media/provider-sdk';
import type { CaptionDocumentV1 } from '@joy-media/project-schema';
import type { BrowserControlPlaneClient } from './control-plane-client.js';
import type { CaptionTranscriptionSource } from './local-transcription.js';

async function tryLiveTranscription(
  language: 'fa-IR' | 'en-US',
  source: CaptionTranscriptionSource,
  client: BrowserControlPlaneClient,
) {
  if (source.transport === 'reference') {
    return client.transcribeSpeech(language, { referenceAssetId: source.assetId });
  }
  if (source.media === undefined) {
    throw new Error('Original media is unavailable for transcription.');
  }
  return client.transcribeSpeech(language, {
    media: source.media,
    mediaType: source.mediaType ?? source.media.type,
    sourceStartUs: source.sourceStartUs,
    sourceDurationUs: source.sourceDurationUs,
  });
}

function wordsForSourceRange<T extends { readonly startUs: number; readonly endUs: number }>(
  words: readonly T[],
  source: CaptionTranscriptionSource,
): readonly T[] {
  const startUs = source.sourceStartUs;
  const endUs = startUs + source.sourceDurationUs;
  return words.flatMap((word) => {
    if (word.endUs <= startUs || word.startUs >= endUs) return [];
    const clippedStartUs = Math.max(startUs, word.startUs);
    const clippedEndUs = Math.min(endUs, word.endUs);
    return [
      {
        ...word,
        startUs: Math.floor((clippedStartUs - startUs) / source.playbackRate),
        endUs: Math.ceil((clippedEndUs - startUs) / source.playbackRate),
      },
    ];
  });
}

export async function transcribeReferenceCaption(
  documentId: string,
  language: 'fa-IR' | 'en-US',
  source: CaptionTranscriptionSource,
  client?: BrowserControlPlaneClient,
): Promise<CaptionDocumentV1> {
  try {
    const resolvedClient =
      client ??
      new (await import('./control-plane-client.js').then(
        ({ BrowserControlPlaneClient: Client }) => Client,
      ))();
    const live = await tryLiveTranscription(language, source, resolvedClient);
    return captionDocumentFromTranscription(documentId, {
      language: live.language,
      words: wordsForSourceRange(live.words, source),
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
