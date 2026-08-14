import type { TransitionV1 } from '@joy-media/project-schema';
import { timeToPixel, type TimelineViewport } from '@joy-media/timeline-engine';
import { TransitionUiIcon } from './icons.js';

/** A transition is rendered over a cut, never as a fake full-width track clip. */
export function TimelineTransitionJunction({
  transition,
  boundaryUs,
  viewport,
  onSeek,
}: {
  readonly transition: TransitionV1;
  readonly boundaryUs: number;
  readonly viewport: TimelineViewport;
  readonly onSeek: (timeUs: number) => void;
}) {
  const rawWidthPx = transition.durationUs * (viewport.pixelsPerSecond / 1_000_000);
  const widthPx = Math.max(22, Math.min(96, rawWidthPx));
  const leftPx = timeToPixel(boundaryUs, { ...viewport, originUs: 0 }) - widthPx / 2;
  const label = transition.type
    .replace(/^gl:/, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (character) => character.toUpperCase());
  return (
    <button
      type="button"
      className="timeline-transition-junction"
      data-transition-id={transition.id}
      aria-label={`${label} transition at ${boundaryUs / 1_000_000} seconds`}
      title={`${label} · ${(transition.durationUs / 1_000_000).toFixed(2)}s`}
      style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
      onClick={(event) => {
        event.stopPropagation();
        onSeek(boundaryUs);
      }}
    >
      <TransitionUiIcon />
      {widthPx >= 54 && <span>{label}</span>}
    </button>
  );
}
