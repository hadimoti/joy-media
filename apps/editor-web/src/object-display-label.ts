import type { VisualObjectV1 } from '@joy-media/project-schema';

const OBJECT_KIND_LABELS: Readonly<Record<VisualObjectV1['kind'], string>> = {
  image: 'Picture',
  text: 'Text',
  shape: 'Shape',
  null: 'Null',
  camera: 'Camera',
  'html-scene': 'HTML scene',
};

/** The name shown for a visual object: its text, or its kind. Object ids are never shown. */
export function objectDisplayLabel(object: VisualObjectV1): string {
  const text = object.kind === 'text' ? object.text?.trim() : undefined;
  if (text !== undefined && text.length > 0) return text;
  return OBJECT_KIND_LABELS[object.kind];
}

/**
 * Display label for each object, keyed by object id. Objects that would read
 * the same are numbered in order ("Picture 1", "Picture 2"), so a picker can
 * still tell them apart without showing an id.
 */
export function objectDisplayLabels(
  objects: readonly VisualObjectV1[],
): ReadonlyMap<string, string> {
  const base = objects.map((object) => [object.id, objectDisplayLabel(object)] as const);
  const totals = new Map<string, number>();
  for (const [, label] of base) totals.set(label, (totals.get(label) ?? 0) + 1);
  const seen = new Map<string, number>();
  const labels = new Map<string, string>();
  for (const [id, label] of base) {
    if ((totals.get(label) ?? 0) < 2) {
      labels.set(id, label);
      continue;
    }
    const ordinal = (seen.get(label) ?? 0) + 1;
    seen.set(label, ordinal);
    labels.set(id, `${label} ${ordinal}`);
  }
  return labels;
}
