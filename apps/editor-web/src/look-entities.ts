import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { LivingLooksEntityOption } from './LivingLooksPanel.js';
import { objectDisplayLabel, objectDisplayLabels } from './object-display-label.js';

/**
 * What a Look slot can be bound to: the visual objects and the caption clips of the project.
 *
 * A "Null" object (the invisible controller a media clip leaves behind) is never offered: it holds no text and no
 * picture, so a Look bound to it was rejected while it was being staged, and the owner only saw "The preview could
 * not be prepared" (found live, 16 Nov).
 */
export function lookEntityOptions(
  project: Pick<JoyProjectV1, 'visualObjects' | 'compositions'>,
): readonly LivingLooksEntityOption[] {
  const objects = Object.values(project.visualObjects ?? {});
  const objectLabels = objectDisplayLabels(objects);
  const visual = objects
    .filter((object) => object.kind !== 'null')
    .map((object) => ({
      id: object.id,
      label: objectLabels.get(object.id) ?? objectDisplayLabel(object),
      kind: 'visual-object' as const,
    }));
  // Caption clips are named by their order on the timeline, never by id.
  const captions: LivingLooksEntityOption[] = [];
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      if (track.kind !== 'caption') continue;
      for (const clip of track.clips) {
        captions.push({
          id: clip.id,
          label: `Caption ${captions.length + 1}`,
          kind: 'caption-clip',
        });
      }
    }
  }
  return [...visual, ...captions];
}
