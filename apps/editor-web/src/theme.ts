/**
 * Literal mirrors of the `--joy-*` tokens in app.css (DESIGN.md §1).
 *
 * Canvas 2D contexts cannot read CSS custom properties, and `var()` inside an
 * SVG presentation attribute is not reliable across engines. Those two cases —
 * and only those two — may use a literal colour, and it must come from here so
 * the ramp still has one source of truth.
 */

interface JoyColors {
  readonly accent: string;
  readonly accentHover: string;
  readonly bgDeep: string;
  readonly bgPanel: string;
  readonly bgControl: string;
  readonly border: string;
  readonly borderHover: string;
  readonly text: string;
  readonly textMuted: string;
  readonly ok: string;
  readonly danger: string;
}

/**
 * Typed as `string` rather than inferred literals on purpose: these values are
 * interchangeable, and literal types would make `let c = accent; c = danger;`
 * a compile error at every call site that picks a colour conditionally.
 */
export const JOY_COLORS: JoyColors = {
  accent: '#f4b72f',
  accentHover: '#ffc94f',
  bgDeep: '#000000',
  bgPanel: '#252525',
  bgControl: '#3a3a3a',
  border: '#3a3a3a',
  borderHover: '#5a5a62',
  text: '#ececef',
  textMuted: '#a8a8b0',
  ok: '#6fcf97',
  danger: '#ef6a6a',
};

/** Shorthand for the one accent — by far the most common literal. */
export const JOY_ACCENT = JOY_COLORS.accent;
