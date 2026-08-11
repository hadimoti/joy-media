import type { VisualObjectTransaction } from '@joy-media/property-system';

export function effectReorderTransaction(
  objectId: string,
  effectInstanceId: string,
  newIndex: number,
  label: string,
): VisualObjectTransaction {
  return {
    label: `Move ${label}`,
    commands: [
      {
        type: 'effect.reorder',
        payload: { objectId, effectInstanceId, newIndex },
      },
    ],
  };
}
