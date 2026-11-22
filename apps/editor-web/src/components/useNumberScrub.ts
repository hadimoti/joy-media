import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import type { TransientControlAdapter } from './PropertyControlAdapters.js';

export interface UseNumberScrubOptions {
  readonly value: number;
  readonly adapter: TransientControlAdapter<number>;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly step?: number | undefined;
  readonly disabled?: boolean | undefined;
  readonly normalize?: ((value: number) => number) | undefined;
}

interface ScrubGesture {
  readonly pointerId: number;
  readonly startX: number;
  readonly startValue: number;
  target: HTMLElement;
  accepted: boolean;
}

function precisionFor(step: number): number {
  const text = step.toString().toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const decimals = coefficient?.split('.')[1]?.length ?? 0;
  return Math.max(0, Math.min(12, decimals - Number(exponentText ?? 0)));
}

export function useNumberScrub({
  value,
  adapter,
  min = Number.NEGATIVE_INFINITY,
  max = Number.POSITIVE_INFINITY,
  step = 1,
  disabled = false,
  normalize,
}: UseNumberScrubOptions) {
  const gestureRef = useRef<ScrubGesture | null>(null);
  const adapterRef = useRef(adapter);
  const optionsRef = useRef({ min, max, step, normalize });
  const suppressClickRef = useRef(false);
  const cancelGestureRef = useRef<() => void>(() => {});
  const windowBlurHandlerRef = useRef<EventListener>(() => cancelGestureRef.current());
  adapterRef.current = adapter;
  optionsRef.current = { min, max, step, normalize };

  const clear = (cancel: boolean, commit: boolean) => {
    const gesture = gestureRef.current;
    if (gesture === null) return;
    gestureRef.current = null;
    window.removeEventListener('blur', windowBlurHandlerRef.current);
    if (
      gesture.accepted &&
      typeof gesture.target.hasPointerCapture === 'function' &&
      gesture.target.hasPointerCapture(gesture.pointerId)
    ) {
      gesture.target.releasePointerCapture(gesture.pointerId);
    }
    if (gesture.accepted) {
      if (cancel) adapterRef.current.cancel();
      else if (commit) adapterRef.current.commit();
    }
    if (commit && gesture.accepted) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
  };

  cancelGestureRef.current = () => clear(true, false);

  useEffect(() => () => clear(true, false), []);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (disabled || event.button !== 0 || event.isPrimary === false) return;
    gestureRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startValue: value,
      target: event.currentTarget,
      accepted: false,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const gesture = gestureRef.current;
    if (disabled || gesture === null || event.pointerId !== gesture.pointerId) return;
    const delta = event.clientX - gesture.startX;
    if (!gesture.accepted) {
      if (Math.abs(delta) < 4) return;
      gesture.accepted = true;
      adapterRef.current.begin();
      gesture.target.setPointerCapture(gesture.pointerId);
      window.addEventListener('blur', windowBlurHandlerRef.current);
    }
    event.preventDefault();
    const {
      min: lower,
      max: upper,
      step: increment,
      normalize: normalizeValue,
    } = optionsRef.current;
    const safeStep = Number.isFinite(increment) && increment > 0 ? increment : 1;
    const precision = precisionFor(safeStep);
    const raw = gesture.startValue + Math.trunc(delta / 4) * safeStep;
    const clamped = Math.min(upper, Math.max(lower, raw));
    const rounded = Number(clamped.toFixed(precision));
    const normalized = normalizeValue === undefined ? rounded : normalizeValue(rounded);
    if (!Number.isFinite(normalized)) return;
    adapterRef.current.preview(Math.min(upper, Math.max(lower, normalized)));
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId === event.pointerId) clear(false, true);
  };

  const onPointerCancel = (event: PointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId === event.pointerId) clear(true, false);
  };

  const onLostPointerCapture = (event: PointerEvent<HTMLElement>) => {
    if (gestureRef.current?.pointerId === event.pointerId) clear(true, false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || gestureRef.current === null) return false;
    event.preventDefault();
    clear(true, false);
    return true;
  };

  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    if (!suppressClickRef.current) return;
    suppressClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  };

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    onKeyDown,
    onClickCapture,
    cursorStyle: disabled ? undefined : 'ew-resize',
  };
}
