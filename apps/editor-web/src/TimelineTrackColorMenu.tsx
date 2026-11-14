import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
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

/**
 * The colour choices of a track: one small row of dots (the name is the tooltip and the accessible name). It is drawn
 * on the page, above every panel, at the button that opened it (`anchor`, in viewport pixels), so no track row or
 * panel can cover it. A click outside or Escape closes it.
 */
export function TimelineTrackColorMenu({
  current,
  anchor,
  onSelect,
  onClose,
}: {
  readonly current: TimelineTrackLabelColor | undefined;
  readonly anchor: { readonly left: number; readonly bottom: number };
  readonly onSelect: (color?: TimelineTrackLabelColor) => void;
  readonly onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && menuRef.current?.contains(target) === true) return;
      // The button that opened the menu toggles it itself.
      if (target instanceof Element && target.closest('.timeline-track-kind-button') !== null)
        return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="timeline-track-color-menu"
      role="menu"
      aria-label="Track color"
      style={{ left: anchor.left, top: anchor.bottom + 4 }}
    >
      {TRACK_LABEL_COLORS.map((color) => {
        const name = color === undefined ? 'Default' : COLOR_LABELS[color];
        return (
          <button
            key={color ?? 'default'}
            type="button"
            role="menuitemradio"
            aria-checked={current === color}
            aria-label={name}
            title={name}
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
              onClose();
              onSelect(color);
            }}
          >
            <span
              className="timeline-track-color-swatch"
              data-color={color ?? 'default'}
              aria-hidden="true"
            />
          </button>
        );
      })}
    </div>,
    document.body,
  );
}
