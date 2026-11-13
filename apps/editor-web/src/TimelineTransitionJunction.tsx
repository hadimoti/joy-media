import type { TransitionV1 } from '@joy-media/project-schema';
import { timeToPixel, type TimelineViewport } from '@joy-media/timeline-engine';
import { getTransitionShader } from '@joy-media/transition-shaders';
import { TransitionUiIcon } from './icons.js';

/** A transition is rendered over a cut, never as a fake full-width track clip. */
export function TimelineTransitionJunction({
  transition,
  trackId,
  leftClipId,
  rightClipId,
  boundaryUs,
  viewport,
  onSeek,
}: {
  readonly transition?: TransitionV1;
  readonly trackId: string;
  readonly leftClipId: string;
  readonly rightClipId: string;
  readonly boundaryUs: number;
  readonly viewport: TimelineViewport;
  readonly onSeek: (timeUs: number) => void;
}) {
  const rawWidthPx = (transition?.durationUs ?? 0) * (viewport.pixelsPerSecond / 1_000_000);
  const widthPx = transition === undefined ? 22 : Math.max(22, Math.min(96, rawWidthPx));
  const leftPx = timeToPixel(boundaryUs, { ...viewport, originUs: 0 }) - widthPx / 2;
  // The catalogue name, read through the old-id mapping; unknown ids fall back to a tidied id.
  const label =
    transition === undefined
      ? 'Transition cut'
      : (getTransitionShader(transition.type)?.label ??
        transition.type
          .replace(/^(gl|joy):/, '')
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, (character) => character.toUpperCase()));
  return (
    <button
      type="button"
      className={`timeline-transition-junction${transition === undefined ? ' timeline-transition-junction--empty' : ''}`}
      {...(transition === undefined ? {} : { 'data-transition-id': transition.id })}
      {...(transition === undefined ? {} : { 'data-transition-type': transition.type })}
      data-editor-pointer-dnd-target="timeline-cut"
      data-track-id={trackId}
      data-left-clip-id={leftClipId}
      data-right-clip-id={rightClipId}
      aria-label={
        transition === undefined
          ? `Drop transition between clips at ${boundaryUs / 1_000_000} seconds`
          : `${label} transition at ${boundaryUs / 1_000_000} seconds`
      }
      title={
        transition === undefined
          ? 'Drop a transition at this cut'
          : `${label} · ${(transition.durationUs / 1_000_000).toFixed(2)}s`
      }
      style={{ left: `${leftPx}px`, width: `${widthPx}px` }}
      onClick={(event) => {
        event.stopPropagation();
        onSeek(boundaryUs);
      }}
    >
      {transition === undefined ? (
        <span className="sr-only">Drop transition at this cut</span>
      ) : (
        <>
          <TransitionUiIcon />
          {widthPx >= 54 && <span>{label}</span>}
        </>
      )}
    </button>
  );
}
