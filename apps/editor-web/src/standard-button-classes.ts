/**
 * The app's standard button vocabulary (T-P06).
 *
 * Every button in the editor — in a panel or in a dialog — carries one of
 * these classes, so the same control looks the same wherever it appears. The
 * styles live in app.css: `.button-primary` is the gold action,
 * `.button-secondary` the quiet companion, `.button-danger` the destructive
 * one, `.button-link` the quiet text action and `.icon-button` the square
 * icon-only control. `.button-sm` is the small size, a modifier rather than a
 * role of its own.
 */
export const STANDARD_BUTTON_CLASSES = [
  'button-primary',
  'button-secondary',
  'button-danger',
  'button-link',
  'icon-button',
] as const;

export type StandardButtonClass = (typeof STANDARD_BUTTON_CLASSES)[number];

/** Does this class list carry one of the standard button classes? */
export function hasStandardButtonClass(className: string | undefined): boolean {
  if (className === undefined) return false;
  const classes = className.split(/\s+/).filter((entry) => entry.length > 0);
  return classes.some((entry) => (STANDARD_BUTTON_CLASSES as readonly string[]).includes(entry));
}
