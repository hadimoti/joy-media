import {
  decodeColorLutReference,
  colorLutReferenceIdentity,
  isColorGradeV2,
  isColorLutReferenceAvailable,
  type JoyProjectV1,
} from '@joy-media/project-schema';

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
