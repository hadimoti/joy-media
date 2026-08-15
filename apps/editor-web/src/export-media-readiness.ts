import {
  decodeColorLutReference,
  colorLutReferenceIdentity,
  isColorGradeV2,
  isColorLutReferenceAvailable,
  type AssetRecordV1,
  type JoyProjectV1,
} from '@joy-media/project-schema';
import { isControlTimelineElement, type TimelineElementKind } from './timeline-element-kind.js';

/**
 * Visual media accepted by the browser export pipeline before it is decoded.
 * Image assets cover both stills and animated formats such as GIF/WebP/APNG.
 */
export function isExportVisualTimelineClip(
  elementKind: TimelineElementKind,
  assetKind: AssetRecordV1['kind'] | undefined,
): boolean {
  return (
    !isControlTimelineElement(elementKind) &&
    elementKind !== 'audio' &&
    (assetKind === undefined || assetKind === 'video' || assetKind === 'image')
  );
}

/**
 * Media that establishes the exported program's end time. Controller layers
 * (captions, effects, filters, motion, and adjustments) can outlive authored
 * media so they must not silently pad a short edit with blank frames. Audio is
 * still program content even though it is not decoded by the visual pipeline.
 */
export function isExportDurationTimelineClip(
  elementKind: TimelineElementKind,
  assetKind: AssetRecordV1['kind'] | undefined,
): boolean {
  return (
    isExportVisualTimelineClip(elementKind, assetKind) ||
    elementKind === 'audio' ||
    assetKind === 'audio'
  );
}

/**
 * A prepared export record can be rendered from a detached video, a decoded
 * still image, or a decoded animated-image source. Keep this predicate shared
 * so image media is not accidentally filtered out before captureExportClip().
 */
export interface PreparedExportMediaLike {
  readonly [key: string]: unknown;
  readonly video?: unknown;
  readonly stillFrame?: unknown;
  readonly animatedFrameSource?: unknown;
}

export function hasRenderableExportMedia(media: PreparedExportMediaLike): boolean {
  return (
    media.video !== undefined ||
    media.stillFrame !== undefined ||
    media.animatedFrameSource !== undefined
  );
}

/**
 * Export must never silently bypass a referenced custom LUT. This includes
 * static grades and every persisted hold key, even if that key is not active
 * at the current playhead.
 */
export function missingColorLutExportDependencies(project: JoyProjectV1): readonly string[] {
  const missing = new Set<string>();
  const inspectGrade = (grade: JoyProjectV1['colorGrade']) => {
    if (!isColorGradeV2(grade) || grade.lut === undefined) return;
    const reference = colorLutReferenceIdentity(grade.lut);
    if (!isColorLutReferenceAvailable(reference, project.assets))
      missing.add(reference.assetId ?? 'custom LUT');
  };
  inspectGrade(project.colorGrade);
  for (const grade of Object.values(project.clipColorGrades ?? {})) inspectGrade(grade);
  for (const animation of Object.values(project.propertyAnimations ?? {})) {
    if (
      (animation.binding.ownerKind !== 'color-output' &&
        animation.binding.ownerKind !== 'color-clip') ||
      animation.binding.propertyId !== 'lut.reference' ||
      animation.value.kind !== 'string'
    )
      continue;
    for (const key of animation.value.keys) {
      if (typeof key.value !== 'string') {
        missing.add('invalid LUT hold key');
        continue;
      }
      const reference = decodeColorLutReference(key.value);
      if (reference === undefined || !isColorLutReferenceAvailable(reference, project.assets))
        missing.add(reference?.assetId ?? key.value);
    }
  }
  return [...missing].sort();
}
