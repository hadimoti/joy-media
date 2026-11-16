import type { NodeBounds } from '@joy-media/render-ir';
import type { TimelineQcRgba, TimelineQcTextBox } from './qc-sampler.js';
import { projectTextLayoutBounds, type TextLayoutBoundsRecord } from './text-layout-bounds.js';

export interface TextLayoutCandidate {
  readonly id: string;
  readonly kind: 'title' | 'caption';
  readonly startUs: number;
  readonly endUs: number;
  readonly sampleUs: number;
  readonly revision: string;
  readonly hidden?: boolean;
}

export interface TextLayoutNodeMeasurement {
  readonly id: string;
  readonly bounds?: NodeBounds;
  readonly textColor?: TimelineQcRgba;
  readonly plateColor?: TimelineQcRgba;
  readonly plateBounds?: NodeBounds;
}

export interface TextLayoutFrameMeasurement {
  readonly timeUs: number;
  readonly revision: string;
  readonly composition: { readonly width: number; readonly height: number };
  readonly nodes: readonly TextLayoutNodeMeasurement[];
}

export interface TextLayoutCollection {
  readonly boxes: readonly TimelineQcTextBox[];
  readonly unavailable: readonly string[];
  readonly overflow: boolean;
  readonly notMeasured: boolean;
}

/** Maps only renderer measurements tied to the exact frame and saved revision. */
export function collectTextLayoutBounds(
  candidates: readonly TextLayoutCandidate[],
  frames: readonly TextLayoutFrameMeasurement[],
  maxBoxes = 48,
): TextLayoutCollection {
  const records: TextLayoutBoundsRecord[] = [];
  const unavailable: string[] = [];
  const seen = new Set<string>();
  const cap = Number.isSafeInteger(maxBoxes) ? Math.max(0, maxBoxes) : 0;
  const overflow = candidates.length > cap;
  for (const candidate of candidates.slice(0, cap)) {
    if (!candidate || typeof candidate.id !== 'string' || seen.has(candidate.id)) {
      unavailable.push(String(candidate?.id ?? ''));
      continue;
    }
    seen.add(candidate.id);
    if (candidate.hidden) {
      unavailable.push(candidate.id);
      continue;
    }
    const frame = frames.find(
      (entry) => entry.timeUs === candidate.sampleUs && entry.revision === candidate.revision,
    );
    const node = frame?.nodes.find((entry) => entry.id === candidate.id);
    if (frame === undefined || node?.bounds === undefined || node.textColor === undefined) {
      unavailable.push(candidate.id);
      continue;
    }
    records.push({
      id: candidate.id,
      kind: candidate.kind,
      startUs: candidate.startUs,
      endUs: candidate.endUs,
      composition: frame.composition,
      corners: node.bounds.corners,
      ...(node.plateBounds === undefined ? {} : { plateCorners: node.plateBounds.corners }),
      textColor: node.textColor,
      ...(node.plateColor === undefined ? {} : { plateColor: node.plateColor }),
    });
  }
  const projected = projectTextLayoutBounds(records);
  unavailable.push(...projected.unavailable.map((entry) => entry.id));
  return Object.freeze({
    boxes: projected.boxes,
    unavailable: Object.freeze([...new Set(unavailable)]),
    overflow,
    notMeasured: overflow || unavailable.length > 0,
  });
}
