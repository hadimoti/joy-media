/** Deterministic media assertions used by the P3 shipping path. */

export function expectedPresentationFrameCount({ durationUs, frameRateNum, frameRateDen }) {
  if (!Number.isSafeInteger(durationUs) || durationUs <= 0)
    throw new Error('durationUs must be a positive safe integer');
  if (!Number.isSafeInteger(frameRateNum) || frameRateNum <= 0)
    throw new Error('frameRateNum must be a positive safe integer');
  if (!Number.isSafeInteger(frameRateDen) || frameRateDen <= 0)
    throw new Error('frameRateDen must be a positive safe integer');
  // Half-open presentation interval [0, duration): a frame is expected for
  // every rational frame interval that intersects the authored duration.
  return Math.ceil((durationUs * frameRateNum) / (1_000_000 * frameRateDen));
}

export function compareExactFrameCount(actualFrames, expectedFrames) {
  if (!Number.isSafeInteger(actualFrames) || actualFrames <= 0)
    return { ok: false, reason: `actual frame count is invalid: ${String(actualFrames)}` };
  if (actualFrames !== expectedFrames) {
    return {
      ok: false,
      reason: `exact frame count mismatch: actual ${actualFrames}, expected ${expectedFrames}`,
    };
  }
  return { ok: true, reason: null };
}

/** Validate the encoded dimensions against the preset's intended resolution. */
export function validateIntendedResolution(actual, expected) {
  const problems = [];
  const actualWidth = actual?.width;
  const actualHeight = actual?.height;
  const expectedWidth = expected?.width;
  const expectedHeight = expected?.height;
  if (!Number.isSafeInteger(actualWidth) || actualWidth <= 0)
    problems.push(`width:invalid:${String(actualWidth)}`);
  if (!Number.isSafeInteger(actualHeight) || actualHeight <= 0)
    problems.push(`height:invalid:${String(actualHeight)}`);
  if (!Number.isSafeInteger(expectedWidth) || expectedWidth <= 0)
    problems.push(`expected-width:invalid:${String(expectedWidth)}`);
  if (!Number.isSafeInteger(expectedHeight) || expectedHeight <= 0)
    problems.push(`expected-height:invalid:${String(expectedHeight)}`);
  if (problems.length === 0 && actualWidth !== expectedWidth)
    problems.push(`width:mismatch:${actualWidth}:${expectedWidth}`);
  if (problems.length === 0 && actualHeight !== expectedHeight)
    problems.push(`height:mismatch:${actualHeight}:${expectedHeight}`);
  return { ok: problems.length === 0, problems };
}

/**
 * Check authored Look/text regions from decoded 4x4 tile luma samples.
 * `tiles` is a list of tile indexes that must contain visible content in at
 * least one sampled frame. This is intentionally pure: the browser path must
 * provide the region schema from the authored fixture before this proves a
 * production Look. A dark or cropped region therefore fails deterministically.
 */
export function validateLookRegions(samples, regions, { minLuma = 8 } = {}) {
  if (!Array.isArray(samples) || samples.length === 0)
    return { ok: false, problems: ['samples:empty'], observed: [] };
  if (!Array.isArray(regions) || regions.length === 0)
    return { ok: false, problems: ['regions:empty'], observed: [] };
  const problems = [];
  const observed = [];
  for (const region of regions) {
    const id = String(region?.id ?? 'unknown');
    const tiles = Array.isArray(region?.tiles) ? region.tiles : [];
    if (
      tiles.length === 0 ||
      tiles.some((tile) => !Number.isInteger(tile) || tile < 0 || tile > 15)
    ) {
      problems.push(`region-invalid:${id}`);
      continue;
    }
    let maxLuma = 0;
    for (const sample of samples) {
      const values = sample?.stats?.tileLuma;
      if (!Array.isArray(values)) continue;
      const mean = tiles.reduce((sum, tile) => sum + Number(values[tile] ?? 0), 0) / tiles.length;
      if (Number.isFinite(mean)) maxLuma = Math.max(maxLuma, mean);
    }
    observed.push({ id, maxLuma });
    if (maxLuma < minLuma) problems.push(`region-missing:${id}`);
  }
  return { ok: problems.length === 0, problems, observed };
}

/** Match authored A/V events by identity and time; never choose a nearest packet. */
export function matchAuthoredEvents(expectedEvents, observedEvents, toleranceSeconds = 0.05) {
  if (!Array.isArray(expectedEvents) || !Array.isArray(observedEvents))
    return { ok: false, problems: ['events:not-array'] };
  const problems = [];
  const observedById = new Map(observedEvents.map((event) => [event?.id, event]));
  for (const expected of expectedEvents) {
    const observed = observedById.get(expected?.id);
    if (observed === undefined) {
      problems.push(`missing:${String(expected?.id)}`);
      continue;
    }
    if (
      typeof expected.timeSeconds !== 'number' ||
      typeof observed.timeSeconds !== 'number' ||
      Math.abs(observed.timeSeconds - expected.timeSeconds) > toleranceSeconds
    ) {
      problems.push(`shifted:${String(expected?.id)}`);
    }
  }
  for (const observed of observedEvents) {
    if (!expectedEvents.some((expected) => expected?.id === observed?.id))
      problems.push(`unexpected:${String(observed?.id)}`);
  }
  return { ok: problems.length === 0, problems };
}

export function validateDecodedPixelSamples(samples, { minNonBlackFraction = 0.01 } = {}) {
  if (!Array.isArray(samples) || samples.length === 0)
    return { ok: false, problems: ['samples:empty'] };
  const problems = [];
  for (const sample of samples) {
    const stats = sample?.stats;
    if (stats === null || typeof stats !== 'object') {
      problems.push(`missing-stats:${String(sample?.fraction)}`);
      continue;
    }
    if (typeof stats.nonBlackFraction !== 'number' || stats.nonBlackFraction < minNonBlackFraction)
      problems.push(`blank:${String(sample?.fraction)}`);
    if (!Array.isArray(stats.tileLuma) || stats.tileLuma.length < 4)
      problems.push(`missing-spatial-tiles:${String(sample?.fraction)}`);
  }
  const signatures = samples.map((sample) => sample?.stats?.tileLuma ?? []);
  let maxDelta = 0;
  for (let index = 1; index < signatures.length; index += 1) {
    const previous = signatures[index - 1];
    const current = signatures[index];
    for (let tile = 0; tile < Math.min(previous.length, current.length); tile += 1)
      maxDelta = Math.max(maxDelta, Math.abs(previous[tile] - current[tile]));
  }
  if (maxDelta < 1) problems.push('no-spatial-motion');
  return { ok: problems.length === 0, problems, maxDelta };
}
