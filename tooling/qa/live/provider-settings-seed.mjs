import { createBridge, readDocument } from './matrix-core.mjs';
import { addToTimelineThroughLeftPanel, importThroughLeftPanel } from './steps.mjs';

/**
 * The renderer resolves a proposal's asset, composition and track against the open project, so the
 * stub's STUB-PLAN edit must name real ids. This reads them from a stored document that already has
 * one clip: the composition, the track holding the clip, and that clip's asset. The new clip starts
 * one second after the last clip of that track, so it never overlaps.
 */
export function planOperationsFromDocument(document) {
  const composition = document?.compositions?.[document?.rootCompositionId];
  const track = (composition?.tracks ?? []).find((candidate) => (candidate.clips ?? []).length > 0);
  const clip = track?.clips?.[0];
  if (composition === undefined || track === undefined || !clip?.assetId) {
    throw new Error(
      'BLOCKED: the open project has no clip with an asset, so the stub cannot name real project ids',
    );
  }
  const endUs = track.clips.reduce(
    (latest, candidate) => Math.max(latest, candidate.startUs + candidate.durationUs),
    0,
  );
  return [
    {
      kind: 'timeline.insertExistingAsset',
      id: 'agent-intro',
      dependsOn: [],
      compositionId: composition.id,
      targetTrackId: track.id,
      assetId: clip.assetId,
      startUs: endUs + 1_000_000,
      durationUs: 2_000_000,
    },
  ];
}

/**
 * Imports one fixture into the open project, puts it on the timeline, and reads the real ids back
 * from the stored document (the save can lag the click, so it retries for a short while).
 */
export async function seedPlanOperations(
  page,
  mediaPath,
  { attempts = 20, delayMs = 1_000, bridge } = {},
) {
  await importThroughLeftPanel(page, mediaPath);
  await addToTimelineThroughLeftPanel(page, mediaPath);
  const activeBridge = bridge ?? createBridge(page, { record() {} });
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const { document } = await readDocument(page, activeBridge);
      return planOperationsFromDocument(document);
    } catch (error) {
      lastError = error;
      await page.waitForTimeout(delayMs);
    }
  }
  throw lastError ?? new Error('BLOCKED: the project document could not be read');
}
