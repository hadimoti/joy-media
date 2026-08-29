/**
 * Return a deterministic marker id that is unique in the current project.
 *
 * Marker creation can be triggered twice before React renders the next state
 * (for example by a compact-menu click followed immediately by a keyboard
 * activation), so callers must inspect the session's current marker list at
 * dispatch time rather than relying on `markers.length` or wall-clock time.
 */
export function nextTimelineMarkerId(
  markers: readonly { readonly id: string }[],
  timeUs: number,
): string {
  const base = `marker-${timeUs}`;
  const used = new Set(markers.map((marker) => marker.id));
  if (!used.has(base)) return base;

  let suffix = 1;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
