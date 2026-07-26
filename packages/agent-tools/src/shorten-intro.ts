/**
 * First-party plan recipe: "shorten the intro".
 *
 * This is the vertical slice the agentic architecture is proved against — the
 * smallest request that still needs every stage of the loop. It is a *ripple*
 * edit: trimming the opening clip alone would leave a hole, so every later clip
 * on the same track has to move back by the same amount. That makes it three
 * commands that are only correct together, which is exactly why the run has to
 * be one atomic transaction and one undo.
 *
 * Planning is deterministic and reads the real project — no natural-language
 * parsing. A language model's job is to choose this recipe and its `byUs`, not
 * to invent timeline mutations.
 */

import type { SpikeProject, Track } from '@joy-media/project-schema';
import type { AgentEditPlan, AgentPlanStep } from './plan.js';
import { createPlan } from './plan.js';

export interface ShortenIntroRequest {
  /** How much to remove from the opening clip. */
  readonly byUs: number;
  /** Defaults to the project's root composition. */
  readonly compositionId?: string;
  /** Defaults to the first track that has clips. */
  readonly trackId?: string;
  readonly planId?: string;
}

export type ShortenIntroResult =
  | { readonly ok: true; readonly plan: AgentEditPlan; readonly analysis: ShortenIntroAnalysis }
  | { readonly ok: false; readonly reason: string };

/** What the query stage found — surfaced so the UI can explain the plan. */
export interface ShortenIntroAnalysis {
  readonly compositionId: string;
  readonly trackId: string;
  readonly introClipId: string;
  readonly introStartUs: number;
  readonly introDurationUs: number;
  readonly newIntroDurationUs: number;
  /** Clips after the intro, in start order, that will ripple back. */
  readonly rippledClipIds: readonly string[];
  readonly byUs: number;
}

/** Minimum a clip may be shortened to; below this the edit is not meaningful. */
const MIN_CLIP_DURATION_US = 100_000;

/**
 * Query stage: locate the opening clip and everything that must ripple with it.
 * Separated from planning so a caller can show the user what was found before
 * any plan exists.
 */
export function analyseShortenIntro(
  project: SpikeProject,
  request: ShortenIntroRequest,
): ShortenIntroResult {
  if (!Number.isFinite(request.byUs) || request.byUs <= 0) {
    return { ok: false, reason: 'Shorten amount must be a positive number of microseconds.' };
  }

  const compositionId = request.compositionId ?? project.rootCompositionId;
  const composition = project.compositions[compositionId];
  if (composition === undefined) {
    return { ok: false, reason: `Composition ${compositionId} not found.` };
  }

  const track: Track | undefined =
    request.trackId !== undefined
      ? composition.tracks.find((t) => t.id === request.trackId)
      : composition.tracks.find((t) => t.clips.length > 0);
  if (track === undefined) {
    return {
      ok: false,
      reason:
        request.trackId !== undefined
          ? `Track ${request.trackId} not found.`
          : 'No track in this composition has any clips.',
    };
  }

  const ordered = [...track.clips].sort((a, b) => a.startUs - b.startUs);
  const intro = ordered[0];
  if (intro === undefined) {
    return { ok: false, reason: `Track ${track.id} has no clips to shorten.` };
  }

  const newIntroDurationUs = intro.durationUs - request.byUs;
  if (newIntroDurationUs < MIN_CLIP_DURATION_US) {
    return {
      ok: false,
      reason: `Shortening by ${formatSeconds(request.byUs)} would leave the intro at ${formatSeconds(
        newIntroDurationUs,
      )}; it must stay at least ${formatSeconds(MIN_CLIP_DURATION_US)}.`,
    };
  }

  return {
    ok: true,
    plan: buildPlan(compositionId, track, intro.id, ordered.slice(1), request),
    analysis: {
      compositionId,
      trackId: track.id,
      introClipId: intro.id,
      introStartUs: intro.startUs,
      introDurationUs: intro.durationUs,
      newIntroDurationUs,
      rippledClipIds: ordered.slice(1).map((c) => c.id),
      byUs: request.byUs,
    },
  };
}

function buildPlan(
  compositionId: string,
  track: Track,
  introClipId: string,
  laterClips: readonly { id: string; startUs: number }[],
  request: ShortenIntroRequest,
): AgentEditPlan {
  const intro = track.clips.find((c) => c.id === introClipId)!;
  const newEndUs = intro.startUs + intro.durationUs - request.byUs;

  const trimStep: AgentPlanStep = {
    id: 'trim-intro',
    description: `Trim ${introClipId} to end at ${formatSeconds(newEndUs)}`,
    mode: 'command',
    tool: 'trimClip',
    arguments: { compositionId, trackId: track.id, clipId: introClipId, newEndUs },
    dependsOn: [],
    expectedChange: `${introClipId} becomes ${formatSeconds(intro.durationUs - request.byUs)} long`,
    preconditions: [
      { type: 'entity-exists', entityId: introClipId, message: `Clip ${introClipId} must exist` },
      { type: 'track-exists', entityId: track.id, message: `Track ${track.id} must exist` },
    ],
    requiresConfirmation: false,
  };

  // Ripple in start order. Each move depends on the trim so the gap exists
  // before anything slides into it; moving first would collide with the intro.
  const rippleSteps: AgentPlanStep[] = laterClips.map((clip, index) => ({
    id: `ripple-${clip.id}`,
    description: `Move ${clip.id} back by ${formatSeconds(request.byUs)}`,
    mode: 'command',
    tool: 'moveClip',
    arguments: {
      compositionId,
      trackId: track.id,
      clipId: clip.id,
      newStartUs: clip.startUs - request.byUs,
    },
    dependsOn: index === 0 ? [trimStep.id] : [`ripple-${laterClips[index - 1]!.id}`],
    expectedChange: `${clip.id} starts at ${formatSeconds(clip.startUs - request.byUs)}`,
    preconditions: [
      { type: 'entity-exists', entityId: clip.id, message: `Clip ${clip.id} must exist` },
      { type: 'no-overlap', message: `Moving ${clip.id} must not overlap its neighbour` },
    ],
    requiresConfirmation: false,
  }));

  return createPlan(
    `Shorten the intro by ${formatSeconds(request.byUs)}`,
    [trimStep, ...rippleSteps],
    {
      ...(request.planId !== undefined ? { planId: request.planId } : {}),
      assumptions: [
        `"The intro" is the first clip on track ${track.id} (${introClipId}).`,
        'Later clips on that track ripple back so no gap is left.',
        'Other tracks are left alone.',
      ],
      risks:
        rippleSteps.length === 0
          ? ['Nothing follows the intro, so the composition simply gets shorter.']
          : [`${rippleSteps.length} later clip(s) move; anything synced to them shifts too.`],
    },
  );
}

function formatSeconds(us: number): string {
  return `${(us / 1_000_000).toFixed(2)}s`;
}
