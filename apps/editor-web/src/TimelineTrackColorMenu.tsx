import type { TimelineTrackLabelColor } from '@joy-media/project-schema';

export const TRACK_LABEL_COLORS: readonly (TimelineTrackLabelColor | undefined)[] = [
  undefined,
  'violet',
  'iris',
  'caribbean',
  'lavender',
  'cerulean',
  'forest',
  'rose',
  'mango',
];

const COLOR_LABELS: Record<TimelineTrackLabelColor, string> = {
  violet: 'Violet',
  iris: 'Iris',
  caribbean: 'Caribbean',
  lavender: 'Lavender',
  cerulean: 'Cerulean',
  forest: 'Forest',
  rose: 'Rose',
  mango: 'Mango',
};

export function TimelineTrackColorMenu({
  current,
  onSelect,
  onClose,
}: {
  readonly current: TimelineTrackLabelColor | undefined;
  readonly onSelect: (color?: TimelineTrackLabelColor) => void;
  readonly onClose: () => void;
}) {
  return (
    <div className="timeline-track-color-menu" role="menu" aria-label="Track color">
      {TRACK_LABEL_COLORS.map((color) => (
        <button
          key={color ?? 'default'}
          type="button"
          role="menuitemradio"
          aria-checked={current === color}
          className="timeline-track-color-choice"
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onPointerUp={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onSelect(color);
            onClose();
          }}
        >
          <span
            className="timeline-track-color-swatch"
            data-color={color ?? 'default'}
            aria-hidden="true"
          />
          {color === undefined ? 'Default' : COLOR_LABELS[color]}
        </button>
      ))}
    </div>
  );
}
