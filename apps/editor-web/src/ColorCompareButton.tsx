import { useEffect } from 'react';
import {
  colorGradeBypass,
  useColorGradeBypass,
  type ColorGradeBypassStore,
} from './color-grade-bypass.js';

/**
 * "Hold to compare" (T-K04): while the button is held (pointer, Space or
 * Enter), the Monitor shows the picture without the colour grade. It sits in
 * the Color panel's header, so it works on every colour sub-tab.
 *
 * The grade always comes back: on release of the pointer or the key, on
 * Escape, when the button loses focus, when the pointer is let go or
 * cancelled anywhere (also outside the button), and when the panel goes away.
 */
export function ColorCompareButton({
  store = colorGradeBypass,
}: {
  readonly store?: ColorGradeBypassStore;
}) {
  const held = useColorGradeBypass(store);

  // The grade always comes back when the panel goes away.
  useEffect(() => () => store.set(false), [store]);

  // While held, a release anywhere ends the hold: the pointer let go or
  // cancelled outside the button (no pointer capture), or Escape pressed
  // with the focus somewhere else.
  useEffect(() => {
    if (!held) return;
    const end = () => store.set(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') end();
    };
    window.addEventListener('pointerup', end, true);
    window.addEventListener('pointercancel', end, true);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerup', end, true);
      window.removeEventListener('pointercancel', end, true);
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [held, store]);

  const release = () => store.set(false);

  return (
    <button
      type="button"
      className="color-header-button chsl-compare"
      aria-pressed={held}
      aria-label="Hold to compare without the colour grade"
      title="Hold to see the picture without the colour grade"
      data-color-compare=""
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        // Held even when the pointer slides off the button.
        try {
          event.currentTarget.setPointerCapture(event.pointerId);
        } catch {
          // No capture (an old pointer or a test): the release events still end the hold.
        }
        store.set(true);
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onBlur={release}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          if (held) event.preventDefault();
          release();
          return;
        }
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        // A key held down repeats: after Escape the repeats do not bring the hold back.
        if (!event.repeat) store.set(true);
      }}
      onKeyUp={(event) => {
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        release();
      }}
    >
      ◐ Hold to compare
    </button>
  );
}
