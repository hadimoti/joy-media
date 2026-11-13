import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  colorEyedropper,
  createMagnifierCells,
  pixelAt,
  pixelNeighbourhood,
  readBackCovers,
  readWindowAround,
  useColorEyedropperActive,
  type ColorEyedropperStore,
  type UngradedPixelReader,
  type WindowPixels,
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
/**
 * While picking during playback, a new frame is read again at most this often
 * (each read draws the frame without the grade, copies it and draws it again).
 */
export const EYEDROPPER_REREAD_INTERVAL_MS = 120;

export interface MonitorEyedropperProps {
  readonly view: MonitorViewState;
  readonly frame: MonitorSize;
  /** A new frame under the playhead is read again (when the pointer is over the picture). */
  readonly playheadUs: number;
  readonly store?: ColorEyedropperStore;
  /** The picture before the grade; the Monitor's own read-back by default. */
  readonly readPixels?: UngradedPixelReader;
}

interface Hover {
  readonly x: number;
  readonly y: number;
  readonly colour: PickedColour | undefined;
  readonly cells: readonly (PickedColour | undefined)[];
}

interface PointerAt {
  readonly screen: { readonly x: number; readonly y: number };
  readonly canvas: { readonly x: number; readonly y: number };
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
 *
 * Reading is kept cheap: the picture is read when the pick starts, and after
 * that only when the pointer moves or the frame changes while the pointer is
 * over the picture, at most every `EYEDROPPER_REREAD_INTERVAL_MS` for a new
 * frame. A large frame is read as a window of at most 512 frame pixels around
 * the pointer, read again when the pointer leaves it.
 */
export function MonitorEyedropper({
  view,
  frame,
  playheadUs,
  store = colorEyedropper,
  readPixels = readUngradedMonitorPixels,
}: MonitorEyedropperProps) {
  const active = useColorEyedropperActive(store);
  const pixelsRef = useRef<WindowPixels | undefined>(undefined);
  /** The playhead and frame size the pixels were read at. */
  const readAtRef = useRef<{ playheadUs: number; width: number; height: number } | undefined>(
    undefined,
  );
  /** When the last read happened (for the throttle). */
  const lastReadMsRef = useRef(Number.NEGATIVE_INFINITY);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pointerRef = useRef<PointerAt | undefined>(undefined);
  /** One cell array (and one set of colour objects) for every magnifier update. */
  const cellsRef = useRef(createMagnifierCells());
  const [hover, setHover] = useState<Hover | undefined>(undefined);
  /** The latest render's handlers, for the effects and the throttle timer. */
  const syncRef = useRef<{ readonly changed: () => void; readonly reread: () => void }>({
    changed: () => undefined,
    reread: () => undefined,
  });

  const read = (around: { readonly x: number; readonly y: number } | undefined) => {
    const maxWidth = Math.min(frame.width, MAX_READ_SIZE);
    const maxHeight = Math.min(frame.height, MAX_READ_SIZE);
    const region = readWindowAround(frame, around);
    pixelsRef.current =
      region === undefined
        ? readPixels(maxWidth, maxHeight)
        : readPixels(maxWidth, maxHeight, region);
    readAtRef.current = { playheadUs, width: frame.width, height: frame.height };
    lastReadMsRef.current = Date.now();
    return pixelsRef.current;
  };

  const isStale = () => {
    const at = readAtRef.current;
    return (
      at === undefined ||
      at.playheadUs !== playheadUs ||
      at.width !== frame.width ||
      at.height !== frame.height
    );
  };

  /** The pixels that hold the point: read again when there are none, or they are old or elsewhere. */
  const pixelsFor = (canvas: { readonly x: number; readonly y: number }, fresh: boolean) => {
    const pixels = pixelsRef.current;
    if (
      pixels === undefined ||
      (fresh && isStale()) ||
      !readBackCovers(pixels, frame, canvas, MAGNIFIER_RADIUS)
    )
      return read(canvas);
    return pixels;
  };

  const showHover = (pointer: PointerAt) => {
    const pixels = pixelsRef.current;
    if (pixels === undefined) {
      setHover({ x: pointer.screen.x, y: pointer.screen.y, colour: undefined, cells: [] });
      return;
    }
    setHover({
      x: pointer.screen.x,
      y: pointer.screen.y,
      colour: pixelAt(pixels, frame, pointer.canvas),
      cells: pixelNeighbourhood(pixels, frame, pointer.canvas, MAGNIFIER_RADIUS, cellsRef.current),
    });
  };

  /** Reads a new frame again soon, at most once per interval, while the pointer is over it. */
  const scheduleReread = () => {
    if (timerRef.current !== undefined || pointerRef.current === undefined) return;
    const wait = Math.max(0, lastReadMsRef.current + EYEDROPPER_REREAD_INTERVAL_MS - Date.now());
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      syncRef.current.reread();
    }, wait);
  };

  const sync = {
    /** The pick, the frame size or the frame under the playhead changed. */
    changed() {
      if (!active) {
        if (timerRef.current !== undefined) clearTimeout(timerRef.current);
        timerRef.current = undefined;
        pixelsRef.current = undefined;
        readAtRef.current = undefined;
        pointerRef.current = undefined;
        setHover(undefined);
        return;
      }
      const at = readAtRef.current;
      // The picture is read once when the pick starts (or the frame size changes).
      if (
        pixelsRef.current === undefined ||
        at === undefined ||
        at.width !== frame.width ||
        at.height !== frame.height
      ) {
        read(pointerRef.current?.canvas);
        if (pointerRef.current !== undefined) showHover(pointerRef.current);
        return;
      }
      // A new frame: read again only while the pointer is over the picture, throttled.
      if (at.playheadUs !== playheadUs) scheduleReread();
    },
    /** The throttled read of a new frame. */
    reread() {
      const pointer = pointerRef.current;
      if (!active || pointer === undefined || !isStale()) return;
      read(pointer.canvas);
      showHover(pointer);
    },
  };
  syncRef.current = sync;

  useEffect(() => {
    syncRef.current.changed();
  }, [active, playheadUs, frame.width, frame.height]);

  useEffect(
    () => () => {
      if (timerRef.current !== undefined) clearTimeout(timerRef.current);
      timerRef.current = undefined;
    },
    [],
  );

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
  ): PointerAt => {
    const rect = event.currentTarget.getBoundingClientRect();
    const screen = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return { screen, canvas: screenToCanvasPoint(view, screen) };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pointer = canvasPoint(event);
    pointerRef.current = pointer;
    // Read now only when there is nothing to show for this point; a new frame
    // under a moving pointer is read again on the throttle.
    pixelsFor(pointer.canvas, false);
    if (isStale()) scheduleReread();
    showHover(pointer);
  };

  const onClick = (event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const { canvas } = canvasPoint(event);
    // A click always picks from the frame shown now.
    const pixels = pixelsFor(canvas, true);
    if (pixels === undefined) return;
    const colour = pixelAt(pixels, frame, canvas);
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
      onPointerLeave={() => {
        pointerRef.current = undefined;
        setHover(undefined);
      }}
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
