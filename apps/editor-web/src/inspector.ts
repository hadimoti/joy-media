export interface PropertyDescriptor {
  readonly key: 'transform.x' | 'transform.y' | 'opacity';
  readonly label: string;
  readonly kind: 'number';
  readonly min?: number;
  readonly max?: number;
}

/** First schema-driven Inspector slice; values are dispatched as commands by the controller. */
export const TRANSFORM_INSPECTOR: readonly PropertyDescriptor[] = [
  { key: 'transform.x', label: 'Position X', kind: 'number' },
  { key: 'transform.y', label: 'Position Y', kind: 'number' },
  { key: 'opacity', label: 'Opacity', kind: 'number', min: 0, max: 1 },
];
