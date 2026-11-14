import { useEffect, useRef, useState } from 'react';
import {
  TRANSITION_STRIP_FRAME_COUNT,
  TRANSITION_STRIP_FRAME_HEIGHT,
  TRANSITION_STRIP_FRAME_WIDTH,
  transitionStripUrl,
} from './transition-preview-url.js';

/** About 24 frames per second: the strip holds, transitions, then holds again in one second. */
const FRAME_STEP_MS = 42;
const LAST_FRAME = TRANSITION_STRIP_FRAME_COUNT - 1;

/**
 * Plays a pre-rendered 24-frame transition strip: the still first frame at rest,
 * frame stepping while `playing` (hover or focus on the card, never with reduced
 * motion), and a scrub bar that works with the mouse and the arrow keys at any time.
 */
export function TransitionStripPreview({
  transitionId,
  label,
  playing,
}: {
  readonly transitionId: string;
  readonly label: string;
  readonly playing: boolean;
}) {
  const [frame, setFrame] = useState(0);
  const [scrubbed, setScrubbed] = useState(false);
  const [failed, setFailed] = useState(false);
  const wasPlaying = useRef(false);

  useEffect(() => {
    if (!playing || scrubbed) return undefined;
    const timer = window.setInterval(() => {
      setFrame((current) => (current >= LAST_FRAME ? 0 : current + 1));
    }, FRAME_STEP_MS);
    return () => window.clearInterval(timer);
  }, [playing, scrubbed]);

  useEffect(() => {
    // Back to the still when the pointer or focus leaves the card.
    if (wasPlaying.current && !playing) {
      setFrame(0);
      setScrubbed(false);
    }
    wasPlaying.current = playing;
  }, [playing]);

  const classes = [
    'transition-strip',
    failed ? 'is-fallback' : undefined,
    playing && !scrubbed ? 'is-playing' : undefined,
  ]
    .filter((value): value is string => value !== undefined)
    .join(' ');

  return (
    <div
      className={classes}
      data-transition-id={transitionId}
      data-strip-frame={frame}
      data-preview-playing={playing && !scrubbed ? 'true' : 'false'}
    >
      {!failed && (
        <img
          className="transition-strip-image"
          src={transitionStripUrl(transitionId)}
          alt=""
          width={TRANSITION_STRIP_FRAME_WIDTH * TRANSITION_STRIP_FRAME_COUNT}
          height={TRANSITION_STRIP_FRAME_HEIGHT}
          loading="lazy"
          decoding="async"
          style={{ transform: `translateX(-${(frame / TRANSITION_STRIP_FRAME_COUNT) * 100}%)` }}
          onError={() => setFailed(true)}
        />
      )}
      <input
        className="transition-strip-scrub"
        type="range"
        min={0}
        max={LAST_FRAME}
        step={1}
        value={frame}
        aria-label={`Scrub ${label} preview`}
        aria-valuetext={`Frame ${frame + 1} of ${TRANSITION_STRIP_FRAME_COUNT}`}
        title="Drag to scrub the transition"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onChange={(event) => {
          setScrubbed(true);
          setFrame(Number(event.currentTarget.value));
        }}
      />
    </div>
  );
}
