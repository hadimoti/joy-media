/** Edit distance (insert, delete, substitute, adjacent swap) between two short strings. */
function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  return rows[a.length]![b.length]!;
}

/** The closest candidate for a mistyped name, or undefined when nothing is close. */
export function closestMatch(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.toLowerCase();
  let best: { name: string; distance: number } | undefined;
  for (const name of candidates) {
    const distance = editDistance(needle, name.toLowerCase());
    if (best === undefined || distance < best.distance) best = { name, distance };
  }
  if (best === undefined) return undefined;
  const limit = Math.max(1, Math.min(3, Math.floor(Math.max(needle.length, best.name.length) / 3)));
  return best.distance <= limit ? best.name : undefined;
}
