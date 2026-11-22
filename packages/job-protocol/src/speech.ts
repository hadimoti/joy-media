export type SpeechLanguage = 'fa-IR' | 'en-US';
export type SpeechModel =
  | 'faster-whisper-large-v3-turbo'
  | 'kokoro-82m'
  | 'chatterbox-en'
  | 'chatterbox-fa';

export interface SpeechWord {
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly confidence?: number;
}

export interface SpeechTranscript {
  readonly language: SpeechLanguage;
  readonly words: readonly SpeechWord[];
  readonly speakers: readonly [];
  readonly provenance: {
    readonly providerId: 'local';
    readonly modelId: SpeechModel;
    readonly createdAt: string;
  };
}

export interface SpeechTranscribeV1 {
  readonly schemaVersion: 1;
  readonly language: SpeechLanguage;
  readonly modelId: 'faster-whisper-large-v3-turbo';
  readonly range?: { readonly startUs: number; readonly endUs: number };
}

export interface SpeechSynthesizeV1 {
  readonly schemaVersion: 1;
  readonly language: SpeechLanguage;
  readonly modelId: 'kokoro-82m' | 'chatterbox-en' | 'chatterbox-fa';
  readonly text: string;
  readonly voiceId?: string;
  readonly purpose?: 'general' | 'personal-noncommercial';
}

export interface SpeechConsentRequest {
  readonly acknowledged: true;
  readonly purpose: 'general' | 'personal-noncommercial';
}

export interface SpeechSynthesisTiming {
  readonly durationUs: number;
  readonly timingSource: 'native' | 'aligned' | 'unavailable';
  readonly words: readonly SpeechWord[];
}

export const SPEECH_TEXT_MAX_GRAPHEMES = 1_000;
export const SPEECH_TEXT_MAX_BYTES = 16 * 1024;

const LANGUAGES: readonly SpeechLanguage[] = ['fa-IR', 'en-US'];
const MODELS: readonly SpeechModel[] = [
  'faster-whisper-large-v3-turbo',
  'kokoro-82m',
  'chatterbox-en',
  'chatterbox-fa',
];

export function parseSpeechTranscribeV1(value: unknown): SpeechTranscribeV1 | undefined {
  if (!isPlainObject(value) || value.schemaVersion !== 1) return undefined;
  if (!isLanguage(value.language) || value.modelId !== 'faster-whisper-large-v3-turbo')
    return undefined;
  if (value.range === undefined) {
    return { schemaVersion: 1, language: value.language, modelId: value.modelId };
  }
  if (!isPlainObject(value.range) || !isValidRange(value.range))
    return undefined;
  return {
    schemaVersion: 1,
    language: value.language,
    modelId: value.modelId,
    range: { startUs: value.range.startUs, endUs: value.range.endUs },
  };
}

export function parseSpeechSynthesizeV1(value: unknown): SpeechSynthesizeV1 | undefined {
  if (!isPlainObject(value) || value.schemaVersion !== 1) return undefined;
  if (!isLanguage(value.language) || !isSpeechSynthesisModel(value.modelId)) return undefined;
  if (typeof value.text !== 'string' || !isWithinTextBudget(value.text)) return undefined;
  if (
    value.purpose !== undefined &&
    value.purpose !== 'general' &&
    value.purpose !== 'personal-noncommercial'
  ) {
    return undefined;
  }
  if (value.modelId === 'kokoro-82m' && value.language !== 'en-US') return undefined;
  if (value.modelId === 'chatterbox-en' && value.language !== 'en-US') return undefined;
  if (value.modelId === 'chatterbox-fa' && value.language !== 'fa-IR') return undefined;
  if (value.modelId === 'chatterbox-fa' && value.purpose !== 'personal-noncommercial')
    return undefined;
  if (value.modelId === 'kokoro-82m' && value.voiceId !== undefined) return undefined;
  if (
    value.voiceId !== undefined &&
    (typeof value.voiceId !== 'string' ||
      value.voiceId.length === 0 ||
      value.voiceId.length > 128 ||
      /[\\/:]/.test(value.voiceId))
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    language: value.language,
    modelId: value.modelId,
    text: value.text,
    ...(value.voiceId === undefined ? {} : { voiceId: value.voiceId }),
    ...(value.purpose === undefined ? {} : { purpose: value.purpose }),
  };
}

export function parseSpeechTranscript(value: unknown): SpeechTranscript | undefined {
  if (!isPlainObject(value) || !isLanguage(value.language) || !Array.isArray(value.words))
    return undefined;
  if (!Array.isArray(value.speakers) || value.speakers.length !== 0) return undefined;
  if (!isPlainObject(value.provenance)) return undefined;
  const { providerId, modelId, createdAt } = value.provenance;
  if (
    providerId !== 'local' ||
    !isSpeechModel(modelId) ||
    typeof createdAt !== 'string' ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    return undefined;
  }
  if (!isModelLanguageCompatible(modelId, value.language)) return undefined;
  const words = parseWords(value.words);
  if (words === undefined) return undefined;
  return {
    language: value.language,
    words,
    speakers: [],
    provenance: { providerId, modelId, createdAt },
  };
}

export function parseSpeechSynthesisTiming(value: unknown): SpeechSynthesisTiming | undefined {
  if (!isPlainObject(value) || !isSafeNonNegativeInteger(value.durationUs)) return undefined;
  if (
    value.timingSource !== 'native' &&
    value.timingSource !== 'aligned' &&
    value.timingSource !== 'unavailable'
  ) {
    return undefined;
  }
  if (!Array.isArray(value.words)) return undefined;
  if (value.timingSource === 'unavailable' && value.words.length !== 0) return undefined;
  const words = parseWords(value.words, value.durationUs);
  if (words === undefined) return undefined;
  return { durationUs: value.durationUs, timingSource: value.timingSource, words };
}

function parseWords(value: readonly unknown[], maxEndUs?: number): readonly SpeechWord[] | undefined {
  const words: SpeechWord[] = [];
  let previousEndUs = 0;
  for (const item of value) {
    if (!isPlainObject(item) || typeof item.text !== 'string' || !isWithinTextBudget(item.text))
      return undefined;
    if (!isValidRange(item) || item.startUs < previousEndUs) return undefined;
    if (maxEndUs !== undefined && item.endUs > maxEndUs) return undefined;
    if (
      item.confidence !== undefined &&
      (typeof item.confidence !== 'number' ||
        !Number.isFinite(item.confidence) ||
        item.confidence < 0 ||
        item.confidence > 1)
    ) {
      return undefined;
    }
    words.push({
      text: item.text,
      startUs: item.startUs,
      endUs: item.endUs,
      ...(item.confidence === undefined ? {} : { confidence: item.confidence }),
    });
    previousEndUs = item.endUs;
  }
  return words;
}

function isValidRange(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { startUs: number; endUs: number } {
  return (
    isSafeNonNegativeInteger(value.startUs) &&
    isSafeNonNegativeInteger(value.endUs) &&
    value.endUs > value.startUs
  );
}

function isSafeNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isWithinTextBudget(value: string): boolean {
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  let graphemes = 0;
  for (const _segment of segmenter.segment(value)) {
    graphemes++;
    if (graphemes > SPEECH_TEXT_MAX_GRAPHEMES) return false;
  }
  return new TextEncoder().encode(value).byteLength <= SPEECH_TEXT_MAX_BYTES;
}

function isLanguage(value: unknown): value is SpeechLanguage {
  return typeof value === 'string' && LANGUAGES.includes(value as SpeechLanguage);
}

function isSpeechModel(value: unknown): value is SpeechModel {
  return typeof value === 'string' && MODELS.includes(value as SpeechModel);
}

function isSpeechSynthesisModel(
  value: unknown,
): value is Exclude<SpeechModel, 'faster-whisper-large-v3-turbo'> {
  return value === 'kokoro-82m' || value === 'chatterbox-en' || value === 'chatterbox-fa';
}

function isModelLanguageCompatible(modelId: SpeechModel, language: SpeechLanguage): boolean {
  if (modelId === 'kokoro-82m' || modelId === 'chatterbox-en') return language === 'en-US';
  if (modelId === 'chatterbox-fa') return language === 'fa-IR';
  return true;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
