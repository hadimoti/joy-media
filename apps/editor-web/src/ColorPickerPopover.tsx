import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from './color-convert.js';
import './ColorPickerPopover.css';

export interface ColorSwatchPickerProps {
  readonly value: string;
  readonly onChange: (hex: string) => void;
  readonly label: string;
  readonly disabled?: boolean;
}

const GAP_PX = 4;
const EDGE_PX = 8;

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Reads a hex into hsv; a grey keeps the hue the owner last chose. */
function hsvFromHex(hex: string, keepHue: number): Hsv {
  const parsed = hexToHsv(hex);
  return parsed.s === 0 || parsed.v === 0 ? { ...parsed, h: keepHue } : parsed;
}

interface Placement {
  readonly left: number;
  readonly top: number;
}

/**
 * A small swatch that opens a saturation/value square, a hue bar and a hex
 * field. The popover renders through a portal because the panel roots clip
 * their content.
 */
export function ColorSwatchPicker({
  value,
  onChange,
  label,
  disabled = false,
}: ColorSwatchPickerProps): ReactElement {
  const dialogId = useId();
  const normalized = normalizeHex(value) ?? '#000000';
  const [open, setOpen] = useState(false);
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(normalized));
  const [hexText, setHexText] = useState(normalized);
  const [placement, setPlacement] = useState<Placement | undefined>(undefined);

  const hsvRef = useRef(hsv);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const squareRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const editingHexRef = useRef(false);
  const draggingRef = useRef<'square' | 'bar' | undefined>(undefined);
  const pendingHexRef = useRef<string | undefined>(undefined);
  const frameRef = useRef<number | undefined>(undefined);
  const lastEmittedRef = useRef<string | undefined>(undefined);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  // Follow the value when it changes from outside; keep the hue through greys.
  useEffect(() => {
    const current = hsvRef.current;
    if (hsvToHex(current.h, current.s, current.v) !== normalized) {
      const next = hsvFromHex(normalized, current.h);
      hsvRef.current = next;
      setHsv(next);
    }
    if (!editingHexRef.current) setHexText(normalized);
  }, [normalized]);

  const emitNow = useCallback((hex: string): void => {
    if (frameRef.current !== undefined) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = undefined;
    }
    pendingHexRef.current = undefined;
    if (lastEmittedRef.current === hex) return;
    lastEmittedRef.current = hex;
    onChangeRef.current(hex);
  }, []);

  const emitSoon = useCallback(
    (hex: string): void => {
      pendingHexRef.current = hex;
      if (frameRef.current !== undefined) return;
      if (typeof requestAnimationFrame !== 'function') {
        emitNow(hex);
        return;
      }
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = undefined;
        const pending = pendingHexRef.current;
        if (pending !== undefined) emitNow(pending);
      });
    },
    [emitNow],
  );

  useEffect(
    () => () => {
      if (frameRef.current !== undefined) cancelAnimationFrame(frameRef.current);
    },
    [],
  );

  const apply = useCallback(
    (next: Hsv, immediate: boolean): void => {
      hsvRef.current = next;
      setHsv(next);
      const hex = hsvToHex(next.h, next.s, next.v);
      if (!editingHexRef.current) setHexText(hex);
      if (immediate) emitNow(hex);
      else emitSoon(hex);
    },
    [emitNow, emitSoon],
  );

  const close = useCallback((returnFocus: boolean): void => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  useEffect(() => {
    if (disabled && open) setOpen(false);
  }, [disabled, open]);

  // Place the popover under the swatch, or above it when there is no room.
  const reposition = useCallback((): void => {
    const trigger = triggerRef.current;
    if (trigger === null) return;
    const rect = trigger.getBoundingClientRect();
    const popover = popoverRef.current;
    const width = popover?.offsetWidth ?? 0;
    const height = popover?.offsetHeight ?? 0;
    const below = rect.bottom + GAP_PX;
    const flip = below + height > window.innerHeight - EDGE_PX && rect.top - GAP_PX - height >= 0;
    const top = flip ? rect.top - GAP_PX - height : below;
    const left = Math.max(EDGE_PX, Math.min(rect.left, window.innerWidth - width - EDGE_PX));
    setPlacement((previous) =>
      previous !== undefined && previous.left === left && previous.top === top
        ? previous
        : { left, top },
    );
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      setPlacement(undefined);
      return undefined;
    }
    reposition();
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [open, reposition]);

  // Escape closes; a press outside closes.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      close(true);
    };
    const onPointerDown = (event: Event): void => {
      const target = event.target as Node | null;
      const trigger = triggerRef.current;
      // The label around the swatch counts as the swatch: its click toggles.
      const zone = trigger?.closest('label') ?? trigger;
      if (target === null) return;
      if (popoverRef.current?.contains(target) === true) return;
      if (zone?.contains(target) === true) return;
      close(false);
    };
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, close]);

  useEffect(() => {
    if (open) squareRef.current?.focus({ preventScroll: true });
  }, [open]);

  const dragTo = (kind: 'square' | 'bar', clientX: number, clientY: number): void => {
    const element = kind === 'square' ? squareRef.current : barRef.current;
    if (element === null) return;
    const rect = element.getBoundingClientRect();
    const current = hsvRef.current;
    if (kind === 'square') {
      if (rect.width <= 0 || rect.height <= 0) return;
      apply(
        {
          h: current.h,
          s: clamp01((clientX - rect.left) / rect.width),
          v: 1 - clamp01((clientY - rect.top) / rect.height),
        },
        false,
      );
    } else {
      if (rect.width <= 0) return;
      apply({ ...current, h: clamp01((clientX - rect.left) / rect.width) * 360 }, false);
    }
  };

  const onDragStart =
    (kind: 'square' | 'bar') =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (event.button !== undefined && event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
      draggingRef.current = kind;
      try {
        event.currentTarget.setPointerCapture?.(event.pointerId);
      } catch {
        // A synthetic pointer has nothing to capture.
      }
      dragTo(kind, event.clientX, event.clientY);
      const pending = pendingHexRef.current;
      if (pending !== undefined) emitNow(pending);
    };

  const onDragMove =
    (kind: 'square' | 'bar') =>
    (event: ReactPointerEvent<HTMLDivElement>): void => {
      if (draggingRef.current !== kind) return;
      dragTo(kind, event.clientX, event.clientY);
    };

  const onDragEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (draggingRef.current === undefined) return;
    draggingRef.current = undefined;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Nothing was captured.
    }
    const pending = pendingHexRef.current;
    if (pending !== undefined) emitNow(pending);
  };

  const onSquareKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 0.1 : 0.01;
    const { h, s, v } = hsvRef.current;
    let next: Hsv | undefined;
    if (event.key === 'ArrowLeft') next = { h, s: clamp01(s - step), v };
    else if (event.key === 'ArrowRight') next = { h, s: clamp01(s + step), v };
    else if (event.key === 'ArrowUp') next = { h, s, v: clamp01(v + step) };
    else if (event.key === 'ArrowDown') next = { h, s, v: clamp01(v - step) };
    if (next === undefined) return;
    event.preventDefault();
    apply(next, true);
  };

  const onBarKey = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? 10 : 1;
    const { h, s, v } = hsvRef.current;
    let hue: number | undefined;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') hue = h - step;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') hue = h + step;
    if (hue === undefined) return;
    event.preventDefault();
    apply({ h: Math.min(360, Math.max(0, hue)), s, v }, true);
  };

  const commitHex = (): void => {
    editingHexRef.current = false;
    const parsed = normalizeHex(hexText);
    if (parsed === undefined) {
      setHexText(hsvToHex(hsvRef.current.h, hsvRef.current.s, hsvRef.current.v));
      return;
    }
    setHexText(parsed);
    apply(hsvFromHex(parsed, hsvRef.current.h), true);
  };

  const current = hsvToHex(hsv.h, hsv.s, hsv.v);
  const popover = open ? (
    <div
      ref={popoverRef}
      id={dialogId}
      role="dialog"
      aria-label={`${label} picker`}
      className="joy-color-popover"
      style={
        {
          left: placement?.left ?? 0,
          top: placement?.top ?? 0,
          visibility: placement === undefined ? 'hidden' : 'visible',
          '--joy-picker-hue': hsvToHex(hsv.h, 1, 1),
        } as CSSProperties
      }
    >
      <div
        ref={squareRef}
        className="joy-color-square"
        role="slider"
        tabIndex={0}
        aria-label="Saturation and brightness"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(hsv.s * 100)}
        aria-valuetext={current}
        onPointerDown={onDragStart('square')}
        onPointerMove={onDragMove('square')}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onKeyDown={onSquareKey}
      >
        <span
          className="joy-color-marker"
          style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }}
        />
      </div>
      <div
        ref={barRef}
        className="joy-color-hue"
        role="slider"
        tabIndex={0}
        aria-label="Hue"
        aria-valuemin={0}
        aria-valuemax={360}
        aria-valuenow={Math.round(hsv.h)}
        aria-valuetext={`${Math.round(hsv.h)}°`}
        onPointerDown={onDragStart('bar')}
        onPointerMove={onDragMove('bar')}
        onPointerUp={onDragEnd}
        onPointerCancel={onDragEnd}
        onKeyDown={onBarKey}
      >
        <span className="joy-color-marker" style={{ left: `${(hsv.h / 360) * 100}%` }} />
      </div>
      <input
        type="text"
        className="joy-color-hex"
        aria-label="Hex"
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        value={hexText}
        onFocus={(event) => {
          editingHexRef.current = true;
          event.currentTarget.select();
        }}
        onChange={(event) => setHexText(event.currentTarget.value)}
        onBlur={commitHex}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commitHex();
          }
        }}
      />
    </div>
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="joy-color-swatch"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        aria-label={label}
        disabled={disabled}
        style={{ backgroundColor: normalized }}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
      />
      {popover !== null ? createPortal(popover, document.body) : null}
    </>
  );
}
