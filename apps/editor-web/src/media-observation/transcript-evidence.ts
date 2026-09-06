import type { AudioCompositionTimeMapping } from '@joy-media/audio-core';
import type { ObservationPrivacyOrigin } from '@joy-media/media-core/observation';

export const TRANSCRIPT_EVIDENCE_VERSION = 'joy-transcript-evidence-v1' as const;

const DIGEST = /^[a-f0-9]{64}$/i;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:=-]{0,127}$/;
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,3}$/;
const MAX_WORDS = 8_192;
const MAX_WORD_TEXT_LENGTH = 512;
const MAX_TOTAL_WORD_TEXT_LENGTH = 262_144;
const UNSAFE_LOCATION =
  /(?:\b(?:https?|file|data|blob):|\b[A-Za-z]:|(?:^|\s|=|:|\(|\[)(?:~?\/|\\\\)|(?:^|\/)\.{1,2}(?:\/|$)|\\)/i;

export type TranscriptEvidenceDelivery =
  'direct-byok' | 'local' | 'user-import' | 'reference-fixture';

export interface TranscriptWordInput {
  readonly text: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly confidence?: number;
  readonly speakerId?: string;
}

export interface TranscriptEvidenceWord extends TranscriptWordInput {
  /** Deterministic temporal identity, never a provider-side URL or handle. */
  readonly id: string;
}

export interface TranscriptEvidenceProvenance {
  /** Opaque display IDs only; this record never contains an endpoint or key. */
  readonly providerId: string;
  readonly modelId: string;
  readonly delivery: TranscriptEvidenceDelivery;
  readonly createdAt: string;
}

export interface TranscriptEvidenceInput {
  readonly assetDigest: string;
  readonly origin: ObservationPrivacyOrigin;
  readonly language: string;
  readonly sourceRange: { readonly startUs: number; readonly endUs: number };
  readonly provenance: TranscriptEvidenceProvenance;
  readonly words: readonly TranscriptWordInput[];
}

export interface TranscriptEvidence {
  readonly version: typeof TRANSCRIPT_EVIDENCE_VERSION;
  readonly id: string;
  readonly assetDigest: string;
  readonly origin: ObservationPrivacyOrigin;
  readonly language: string;
  readonly sourceRange: { readonly startUs: number; readonly endUs: number };
  readonly provenance: TranscriptEvidenceProvenance;
  readonly words: readonly TranscriptEvidenceWord[];
}

export interface MappedTranscriptEvidenceWord extends TranscriptEvidenceWord {
  readonly compositionStartUs: number;
  readonly compositionEndUs: number;
}

export interface MappedTranscriptEvidence {
  readonly sourceEvidenceId: string;
  readonly words: readonly MappedTranscriptEvidenceWord[];
  /** Source words not wholly covered by the clip's known mapping. */
  readonly omittedWordIds: readonly string[];
  readonly completeMappedCoverage: boolean;
}

export class TranscriptEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TranscriptEvidenceError';
  }
}

/**
 * Creates bounded transcript evidence. Transcript content remains data, not
 * instructions or a provider capability. Sending it to a model remains an
 * explicit consent/transport decision outside this local validation layer.
 */
export function createTranscriptEvidence(input: TranscriptEvidenceInput): TranscriptEvidence {
  assertTranscriptInput(input);
  const assetDigest = input.assetDigest.toLowerCase();
  const words = Object.freeze(
    input.words.map((word, index) =>
      Object.freeze({
        id: `transcript-word:v1:${assetDigest}:${index}:${word.startUs}-${word.endUs}`,
        text: word.text,
        startUs: word.startUs,
        endUs: word.endUs,
        ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
        ...(word.speakerId === undefined ? {} : { speakerId: word.speakerId }),
      }),
    ),
  );
  const evidence = Object.freeze({
    version: TRANSCRIPT_EVIDENCE_VERSION,
    id: `transcript:v1:${assetDigest}:${input.sourceRange.startUs}-${input.sourceRange.endUs}`,
    assetDigest,
    origin: input.origin,
    language: input.language,
    sourceRange: Object.freeze({ ...input.sourceRange }),
    provenance: Object.freeze({ ...input.provenance }),
    words,
  });
  assertTranscriptEvidence(evidence);
  return evidence;
}

/**
 * Reference/synthetic artifacts are useful for tests but must never certify
 * that the owner’s footage was heard. A valid user-origin transcript can still
 * be stale or incomplete; this predicate only answers its provenance class.
 */
export function isTranscriptEligibleForUserObservation(evidence: TranscriptEvidence): boolean {
  assertTranscriptEvidence(evidence);
  return evidence.origin === 'user' && evidence.provenance.delivery !== 'reference-fixture';
}

/**
 * Maps known word boundaries through trim/direction/speed without inventing a
 * position for words outside the clip's covered source interval. Reverse clips
 * are normalized into an increasing composition interval for UI consumers.
 */
export function mapTranscriptEvidenceToComposition(
  evidence: TranscriptEvidence,
  mapping: AudioCompositionTimeMapping,
): MappedTranscriptEvidence {
  assertTranscriptEvidence(evidence);
  assertMapping(mapping);
  const words: MappedTranscriptEvidenceWord[] = [];
  const omittedWordIds: string[] = [];
  for (const word of evidence.words) {
    const firstBoundary = mapSourceBoundaryToComposition(word.startUs, mapping);
    const secondBoundary = mapSourceBoundaryToComposition(word.endUs, mapping);
    if (firstBoundary === undefined || secondBoundary === undefined) {
      omittedWordIds.push(word.id);
      continue;
    }
    const compositionStartUs = Math.min(firstBoundary, secondBoundary);
    const compositionEndUs = Math.max(firstBoundary, secondBoundary);
    if (compositionEndUs <= compositionStartUs) {
      omittedWordIds.push(word.id);
      continue;
    }
    words.push(
      Object.freeze({
        ...word,
        compositionStartUs,
        compositionEndUs,
      }),
    );
  }
  return Object.freeze({
    sourceEvidenceId: evidence.id,
    words: Object.freeze(words),
    omittedWordIds: Object.freeze(omittedWordIds),
    completeMappedCoverage: omittedWordIds.length === 0,
  });
}

export function assertTranscriptEvidence(value: unknown): asserts value is TranscriptEvidence {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TranscriptEvidenceError('Transcript evidence is invalid.');
  const evidence = value as Record<string, unknown>;
  if (
    !hasExactKeys(evidence, [
      'version',
      'id',
      'assetDigest',
      'origin',
      'language',
      'sourceRange',
      'provenance',
      'words',
    ]) ||
    evidence.version !== TRANSCRIPT_EVIDENCE_VERSION ||
    typeof evidence.id !== 'string' ||
    typeof evidence.assetDigest !== 'string' ||
    !DIGEST.test(evidence.assetDigest) ||
    !isOrigin(evidence.origin) ||
    typeof evidence.language !== 'string' ||
    !LANGUAGE.test(evidence.language)
  ) {
    throw new TranscriptEvidenceError('Transcript evidence is invalid.');
  }
  assertRange(evidence.sourceRange);
  assertProvenance(evidence.provenance, evidence.origin);
  if (!Array.isArray(evidence.words) || evidence.words.length > MAX_WORDS)
    throw new TranscriptEvidenceError('Transcript evidence words are invalid.');
  let previousStartUs = -1;
  let textLength = 0;
  for (let index = 0; index < evidence.words.length; index += 1) {
    const word = evidence.words[index];
    assertWord(word, evidence.assetDigest.toLowerCase(), index, evidence.sourceRange);
    const typedWord = word as TranscriptEvidenceWord;
    if (typedWord.startUs < previousStartUs)
      throw new TranscriptEvidenceError('Transcript evidence words must be chronological.');
    previousStartUs = typedWord.startUs;
    textLength += typedWord.text.length;
    if (textLength > MAX_TOTAL_WORD_TEXT_LENGTH)
      throw new TranscriptEvidenceError('Transcript evidence text exceeds its bounded size.');
  }
}

function assertTranscriptInput(input: TranscriptEvidenceInput): void {
  if (input === null || typeof input !== 'object' || Array.isArray(input))
    throw new TranscriptEvidenceError('Transcript evidence input is invalid.');
  // The output assertion checks the full normalized record; synthesize the
  // source-specific fields here so malformed input cannot reach ID generation.
  if (
    typeof input.assetDigest !== 'string' ||
    !DIGEST.test(input.assetDigest) ||
    !isOrigin(input.origin) ||
    typeof input.language !== 'string' ||
    !LANGUAGE.test(input.language) ||
    !Array.isArray(input.words) ||
    input.words.length > MAX_WORDS
  ) {
    throw new TranscriptEvidenceError('Transcript evidence input is invalid.');
  }
  assertRange(input.sourceRange);
  assertProvenance(input.provenance, input.origin);
  let previousStartUs = -1;
  let textLength = 0;
  for (const word of input.words) {
    assertInputWord(word, input.sourceRange);
    if (word.startUs < previousStartUs)
      throw new TranscriptEvidenceError('Transcript evidence words must be chronological.');
    previousStartUs = word.startUs;
    textLength += word.text.length;
    if (textLength > MAX_TOTAL_WORD_TEXT_LENGTH)
      throw new TranscriptEvidenceError('Transcript evidence text exceeds its bounded size.');
  }
}

function assertWord(
  value: unknown,
  assetDigest: string,
  index: number,
  range: { readonly startUs: number; readonly endUs: number },
): asserts value is TranscriptEvidenceWord {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TranscriptEvidenceError('Transcript evidence word is invalid.');
  const word = value as Record<string, unknown>;
  const expectedKeys = [
    'id',
    'text',
    'startUs',
    'endUs',
    ...(word.confidence === undefined ? [] : ['confidence']),
    ...(word.speakerId === undefined ? [] : ['speakerId']),
  ];
  if (
    !hasExactKeys(word, expectedKeys) ||
    word.id !==
      `transcript-word:v1:${assetDigest}:${index}:${String(word.startUs)}-${String(word.endUs)}`
  ) {
    throw new TranscriptEvidenceError('Transcript evidence word is invalid.');
  }
  assertInputWord(
    {
      text: word.text,
      startUs: word.startUs,
      endUs: word.endUs,
      ...(word.confidence === undefined ? {} : { confidence: word.confidence }),
      ...(word.speakerId === undefined ? {} : { speakerId: word.speakerId }),
    },
    range,
  );
}

function assertInputWord(
  value: unknown,
  range: { readonly startUs: number; readonly endUs: number },
): asserts value is TranscriptWordInput {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TranscriptEvidenceError('Transcript evidence word is invalid.');
  const word = value as Record<string, unknown>;
  const expectedKeys = [
    'text',
    'startUs',
    'endUs',
    ...(word.confidence === undefined ? [] : ['confidence']),
    ...(word.speakerId === undefined ? [] : ['speakerId']),
  ];
  if (
    !hasExactKeys(word, expectedKeys) ||
    typeof word.text !== 'string' ||
    word.text.trim().length === 0 ||
    word.text.length > MAX_WORD_TEXT_LENGTH ||
    !isNonNegativeSafeInteger(word.startUs) ||
    !isNonNegativeSafeInteger(word.endUs) ||
    word.endUs <= word.startUs ||
    word.startUs < range.startUs ||
    word.endUs > range.endUs ||
    (word.confidence !== undefined &&
      (typeof word.confidence !== 'number' ||
        !Number.isFinite(word.confidence) ||
        word.confidence < 0 ||
        word.confidence > 1)) ||
    (word.speakerId !== undefined && !isSafeOpaqueId(word.speakerId))
  ) {
    throw new TranscriptEvidenceError('Transcript evidence word is invalid.');
  }
}

function assertRange(
  value: unknown,
): asserts value is { readonly startUs: number; readonly endUs: number } {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !hasExactKeys(value as Record<string, unknown>, ['startUs', 'endUs']) ||
    !isNonNegativeSafeInteger((value as Record<string, unknown>).startUs) ||
    !isNonNegativeSafeInteger((value as Record<string, unknown>).endUs) ||
    (value as { readonly endUs: number }).endUs <= (value as { readonly startUs: number }).startUs
  ) {
    throw new TranscriptEvidenceError('Transcript evidence range is invalid.');
  }
}

function assertProvenance(
  value: unknown,
  origin: ObservationPrivacyOrigin,
): asserts value is TranscriptEvidenceProvenance {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TranscriptEvidenceError('Transcript evidence provenance is invalid.');
  const provenance = value as Record<string, unknown>;
  if (
    !hasExactKeys(provenance, ['providerId', 'modelId', 'delivery', 'createdAt']) ||
    !isSafeOpaqueId(provenance.providerId) ||
    !isSafeOpaqueId(provenance.modelId) ||
    !isDelivery(provenance.delivery) ||
    typeof provenance.createdAt !== 'string' ||
    provenance.createdAt.length > 64 ||
    !Number.isFinite(Date.parse(provenance.createdAt)) ||
    (origin === 'reference') !== (provenance.delivery === 'reference-fixture')
  ) {
    throw new TranscriptEvidenceError('Transcript evidence provenance is invalid.');
  }
}

function assertMapping(mapping: AudioCompositionTimeMapping): void {
  if (
    mapping === null ||
    typeof mapping !== 'object' ||
    !isNonNegativeSafeInteger(mapping.compositionStartUs) ||
    !isNonNegativeSafeInteger(mapping.compositionDurationUs) ||
    mapping.compositionDurationUs < 1 ||
    !isNonNegativeSafeInteger(mapping.sourceAnchorUs) ||
    (mapping.direction !== 'forward' && mapping.direction !== 'reverse') ||
    mapping.sourcePerComposition === null ||
    typeof mapping.sourcePerComposition !== 'object' ||
    !isPositiveSafeInteger(mapping.sourcePerComposition.numerator) ||
    !isPositiveSafeInteger(mapping.sourcePerComposition.denominator)
  ) {
    throw new TranscriptEvidenceError('Transcript evidence composition mapping is invalid.');
  }
}

function mapSourceBoundaryToComposition(
  sourceTimeUs: number,
  mapping: AudioCompositionTimeMapping,
): number | undefined {
  const deltaUs =
    mapping.direction === 'forward'
      ? sourceTimeUs - mapping.sourceAnchorUs
      : mapping.sourceAnchorUs - sourceTimeUs;
  if (deltaUs < 0) return undefined;
  const offset =
    (BigInt(deltaUs) * BigInt(mapping.sourcePerComposition.denominator)) /
    BigInt(mapping.sourcePerComposition.numerator);
  if (offset > BigInt(mapping.compositionDurationUs)) return undefined;
  const result = BigInt(mapping.compositionStartUs) + offset;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return Number(result);
}

function isOrigin(value: unknown): value is ObservationPrivacyOrigin {
  return value === 'user' || value === 'reference' || value === 'synthetic';
}

function isDelivery(value: unknown): value is TranscriptEvidenceDelivery {
  return (
    value === 'direct-byok' ||
    value === 'local' ||
    value === 'user-import' ||
    value === 'reference-fixture'
  );
}

function isSafeOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID.test(value) && !UNSAFE_LOCATION.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}
