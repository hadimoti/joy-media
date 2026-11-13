import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ScopePixels } from '../color-scopes.js';
import {
  colorEyedropper,
  pixelAt,
  pixelNeighbourhood,
  useColorEyedropperActive,
  type ColorEyedropperStore,
} from '../color-eyedropper.js';
import { hasPickableHue, pixelHue, type PickedColour } from '../color-hsl-math.js';
import { readUngradedMonitorPixels } from '../monitor-readback.js';
import {
  screenToCanvasPoint,
  type MonitorSize,
  type MonitorViewState,
} from './monitor-view-state.js';
import '../ColorCurvesHsl.css';

/** The magnifier shows this many pixels on each side of the picked one. */
const MAGNIFIER_RADIUS = 3;
/** The read-back is never larger than this on a side. */
const MAX_READ_SIZE = 2048;

export interface MonitorEyedropperProps {
  readonly view: MonitorViewState;
  readonly frame: MonitorSize;
  /** A new frame under the playhead is read again. */
  readonly playheadUs: number;
  readonly store?: ColorEyedropperStore;
  /** The picture before the grade; the Monitor's own read-back by default. */
  readonly readPixels?: (maxWidth: number, maxHeight: number) => ScopePixels | undefined;
}

interface Hover {
  readonly x: number;
  readonly y: number;
  readonly colour: PickedColour | undefined;
  readonly cells: readonly (PickedColour | undefined)[];
}

function rgb(colour: PickedColour): string {
  return `rgb(${colour.r} ${colour.g} ${colour.b})`;
}

/**
 * The eyedropper over the Monitor (T-K04). While a pick is on it covers the
 * picture: the cursor is an eyedropper, a magnifier shows the pixel under it
 * and its hue, a click picks the pixel and Esc cancels. The pixels are read
 * from the picture before the colour grade, so the pick does not move while
 * the grade changes.
 */
export function MonitorEyedropper({
  view,
  frame,
  playheadUs,
  store = colorEyedropper,
  readPixels = readUngradedMonitorPixels,
}: MonitorEyedropperProps) {
  const active = useColorEyedropperActive(store);
  const pixelsRef = useRef<ScopePixels | undefined>(undefined);
  const [hover, setHover] = useState<Hover | undefined>(undefined);

  const read = () => {
    pixelsRef.current = readPixels(
      Math.min(frame.width, MAX_READ_SIZE),
      Math.min(frame.height, MAX_READ_SIZE),
    );
    return pixelsRef.current;
  };
  const readRef = useRef(read);
  readRef.current = read;

  // The picture is read once when the pick starts, and again for a new frame.
  useEffect(() => {
    if (!active) {
      pixelsRef.current = undefined;
      setHover(undefined);
      return;
    }
    readRef.current();
  }, [active, playheadUs, frame.width, frame.height]);

  useEffect(() => {
    if (!active) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      store.cancel();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [active, store]);

  if (!active) return null;

  const canvasPoint = (
    event: ReactPointerEvent<HTMLDivElement> | React.MouseEvent<HTMLDivElement>,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return { screen, canvas: screenToCanvasPoint(view, screen) };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pixels = pixelsRef.current ?? read();
    const { screen, canvas } = canvasPoint(event);
    if (pixels === undefined) {
      setHover({ x: screen.x, y: screen.y, colour: undefined, cells: [] });
      return;
    }
    setHover({
      x: screen.x,
      y: screen.y,
      colour: pixelAt(pixels, frame, canvas),
      cells: pixelNeighbourhood(pixels, frame, canvas, MAGNIFIER_RADIUS),
    });
  };

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const pixels = pixelsRef.current ?? read();
    if (pixels === undefined) return;
    const colour = pixelAt(pixels, frame, canvasPoint(event).canvas);
    // A click beside the picture picks nothing; the pick stays on.
    if (colour === undefined) return;
    store.pick(colour);
  };

  const stop = (event: React.SyntheticEvent) => {
    event.stopPropagation();
  };

  const hue = hover?.colour === undefined ? undefined : pixelHue(hover.colour);
  const side = MAGNIFIER_RADIUS * 2 + 1;

  return (
    <div
      className="monitor-eyedropper"
      data-monitor-eyedropper=""
      aria-label="Eyedropper: click a colour in the picture, Esc cancels"
      onPointerDown={(event) => {
        stop(event);
        event.preventDefault();
      }}
      onPointerUp={stop}
      onPointerMove={onPointerMove}
      onPointerLeave={() => setHover(undefined)}
      onClick={onClick}
      onDoubleClick={stop}
      onWheel={stop}
    >
      {hover !== undefined && (
        <div
          className="monitor-eyedropper-loupe"
          data-eyedropper-loupe=""
          style={{ left: hover.x + 18, top: hover.y + 18 }}
        >
          {hover.cells.length > 0 && (
            <div
              className="monitor-eyedropper-grid"
              style={{ gridTemplateColumns: `repeat(${side}, 1fr)` }}
            >
              {hover.cells.map((cell, index) => (
                <span
                  key={index}
                  className={index === (side * side - 1) / 2 ? 'is-centre' : undefined}
                  style={{ background: cell === undefined ? 'transparent' : rgb(cell) }}
                />
              ))}
            </div>
          )}
          <span className="monitor-eyedropper-text" data-eyedropper-readout="">
            {hover.colour === undefined || hue === undefined
              ? 'Outside the picture'
              : hasPickableHue(hover.colour)
                ? `Hue ${Math.round(hue.hue) % 360}° · R ${hover.colour.r} G ${hover.colour.g} B ${hover.colour.b}`
                : `Grey, no hue · R ${hover.colour.r} G ${hover.colour.g} B ${hover.colour.b}`}
          </span>
        </div>
      )}
    </div>
  );
}
