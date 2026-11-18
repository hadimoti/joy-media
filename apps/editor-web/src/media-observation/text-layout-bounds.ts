import type { NodePoint } from '@joy-media/render-ir';
import type { TimelineQcRgba, TimelineQcTextBox } from './qc-sampler.js';

/**
 * T-B06: trusted title and caption bounds.
 *
 * The renderer (or a shared layout) measures where a title or caption is drawn; this file only turns
 * that detached measurement into the normalized boxes QC reads. It measures nothing, reads no UI state
 * and renders no pixels. A text node whose measurement is missing or unusable is reported as
 * unavailable and gets no box: the drawn size is never guessed from the character count.
 */

/** One drawn text node, measured in frame pixels of a composition of `composition` size. */
export interface TextLayoutBoundsRecord {
  /** Stable id of the text node (a title object id, or a caption cue id). */
  readonly id: string;
  readonly kind: 'title' | 'caption';
  /** The interval, in microseconds on the composition timeline, where the text is drawn. */
  readonly startUs: number;
  readonly endUs: number;
  readonly composition: { readonly width: number; readonly height: number };
  /** Corners of the text box in frame pixels, as the renderer reports them (rotation included). */
  readonly corners: readonly [NodePoint, NodePoint, NodePoint, NodePoint];
  /** Corners of the plate behind the text, when it has one. The box then covers the plate too. */
  readonly plateCorners?: readonly [NodePoint, NodePoint, NodePoint, NodePoint];
  /** True when the renderer measured an empty or whitespace-only text node. */
  readonly emptyText?: boolean;
  readonly textColor: TimelineQcRgba;
  readonly plateColor?: TimelineQcRgba;
}

export interface TextBoundsUnavailable {
  readonly id: string;
  readonly reason:
    'invalid-record' | 'invalid-corners' | 'invalid-interval' | 'invalid-composition';
}

export interface TextBoundsProjection {
  readonly boxes: readonly TimelineQcTextBox[];
  readonly unavailable: readonly TextBoundsUnavailable[];
}

function validCorners(
  corners: readonly NodePoint[] | undefined,
): corners is readonly [NodePoint, NodePoint, NodePoint, NodePoint] {
  return (
    Array.isArray(corners) &&
    corners.length === 4 &&
    corners.every(
      (point) =>
        point !== null &&
        typeof point === 'object' &&
        Number.isFinite(point.x) &&
        Number.isFinite(point.y),
    )
  );
}

function extent(corners: readonly NodePoint[]): {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
} {
  return {
    left: Math.min(...corners.map((point) => point.x)),
    top: Math.min(...corners.map((point) => point.y)),
    right: Math.max(...corners.map((point) => point.x)),
    bottom: Math.max(...corners.map((point) => point.y)),
  };
}

/**
 * Turns measured text bounds into QC text boxes, normalized to the composition size. A rotated text box
 * becomes the axis-aligned rectangle around its corners. A box may reach outside the frame (that is what
 * the safe-area check looks for), so nothing is clamped. Output is ordered by start time, then id.
 */
export function projectTextLayoutBounds(
  records: readonly TextLayoutBoundsRecord[],
): TextBoundsProjection {
  const boxes: TimelineQcTextBox[] = [];
  const unavailable: TextBoundsUnavailable[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    if (
      record === null ||
      typeof record !== 'object' ||
      typeof record.id !== 'string' ||
      seen.has(record.id) ||
      (record.kind !== 'title' && record.kind !== 'caption')
    ) {
      unavailable.push({
        id: String((record as { id?: unknown } | null)?.id ?? ''),
        reason: 'invalid-record',
      });
      continue;
    }
    seen.add(record.id);
    const { width, height } = record.composition ?? { width: 0, height: 0 };
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      unavailable.push({ id: record.id, reason: 'invalid-composition' });
      continue;
    }
    if (
      !Number.isSafeInteger(record.startUs) ||
      !Number.isSafeInteger(record.endUs) ||
      record.startUs < 0 ||
      record.endUs <= record.startUs
    ) {
      unavailable.push({ id: record.id, reason: 'invalid-interval' });
      continue;
    }
    const plate = record.plateCorners;
    if (!validCorners(record.corners) || (plate !== undefined && !validCorners(plate))) {
      unavailable.push({ id: record.id, reason: 'invalid-corners' });
      continue;
    }
    const text = extent(record.corners);
    const covered = plate === undefined ? text : extent([...record.corners, ...plate]);
    if (
      (covered.right <= covered.left || covered.bottom <= covered.top) &&
      record.emptyText !== true
    ) {
      unavailable.push({ id: record.id, reason: 'invalid-corners' });
      continue;
    }
    boxes.push({
      id: record.id,
      kind: record.kind,
      startUs: record.startUs,
      endUs: record.endUs,
      x: covered.left / width,
      y: covered.top / height,
      width: (covered.right - covered.left) / width,
      height: (covered.bottom - covered.top) / height,
      ...(record.emptyText === true ? { emptyText: true } : {}),
      textColor: record.textColor,
      ...(record.plateColor === undefined ? {} : { backgroundColor: record.plateColor }),
    });
  }
  boxes.sort((left, right) => left.startUs - right.startUs || (left.id < right.id ? -1 : 1));
  unavailable.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return { boxes: Object.freeze(boxes), unavailable: Object.freeze(unavailable) };
}
