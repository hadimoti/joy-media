/** Pure lane-mode contract for the regenerated v2 workflow. */

export function parseLaneMode(raw = 'full', { smokeOnly = false } = {}) {
  const mode = raw === undefined || raw === '' ? 'full' : raw;
  if (mode !== 'full' && mode !== 'p3')
    throw new Error(`JOY_MEDIA_CI_LANE_MODE must be full or p3 (received ${mode})`);
  if (mode === 'p3' && smokeOnly)
    throw new Error('JOY_MEDIA_CI_LANE_MODE=p3 cannot run with smoke-only acceptance');
  return mode;
}
