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
 */
export function ColorCompareButton({
  store = colorGradeBypass,
}: {
  readonly store?: ColorGradeBypassStore;
}) {
  const held = useColorGradeBypass(store);

  // The grade always comes back when the panel goes away.
  useEffect(() => () => store.set(false), [store]);

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
        if (event.key !== ' ' && event.key !== 'Enter') return;
        event.preventDefault();
        store.set(true);
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
