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

/**
 * Return the next generated marker label without reusing a live label after a
 * non-tail marker is removed. Non-generated labels supplied by a caller are
 * preserved verbatim; existing custom labels are never rewritten.
 */
export function nextTimelineMarkerLabel(
  markers: readonly { readonly label: string }[],
  requestedLabel?: string,
): string {
  const requested = requestedLabel?.trim();
  if (requested !== undefined && requested.length > 0 && !/^Marker \d+$/.test(requested)) {
    return requestedLabel!;
  }

  const used = new Set(markers.map((marker) => marker.label.trim()));
  let next = 1;
  for (const label of used) {
    const match = /^Marker (\d+)$/.exec(label);
    if (match !== null) next = Math.max(next, Number(match[1]) + 1);
  }
  while (used.has(`Marker ${next}`)) next += 1;
  return `Marker ${next}`;
}
