import type { Clip, SpikeProject } from '@joy-media/project-schema';
import type { AgentPlanStep } from '@joy-media/agent-tools';
import { analyseShortenIntro } from '@joy-media/agent-tools';

/**
 * WP-15.2: a structured, templated intent surface (per the WP-15 plan's scope
 * boundary — no natural-language parsing). Each intent turns real selection/
 * playhead state plus the real timeline into one real `AgentPlanStep` that
 * dispatches through the WP-15.1 command bus; nothing here is fabricated.
 */

export interface ClipLocation {
  readonly compositionId: string;
  readonly trackId: string;
  readonly clip: Clip;
}

export function findClipLocation(project: SpikeProject, clipId: string): ClipLocation | undefined {
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      const clip = track.clips.find((c) => c.id === clipId);
      if (clip !== undefined) return { compositionId: composition.id, trackId: track.id, clip };
    }
  }
  return undefined;
}

/** The clip immediately after `location.clip` on the same track, by start time. */
export function findNextClip(project: SpikeProject, location: ClipLocation): Clip | undefined {
  const composition = project.compositions[location.compositionId];
  const track = composition?.tracks.find((t) => t.id === location.trackId);
  if (track === undefined) return undefined;
  const sorted = [...track.clips].sort((a, b) => a.startUs - b.startUs);
  const index = sorted.findIndex((c) => c.id === location.clip.id);
  if (index === -1) return undefined;
  return sorted[index + 1];
}

export type IntentBuildResult =
  | { readonly ok: true; readonly step: AgentPlanStep }
  | { readonly ok: false; readonly reason: string };

export interface AgentIntent {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly destructive: boolean;
  buildStep(
    project: SpikeProject,
    selectedClipIds: readonly string[],
    playheadUs: number,
  ): IntentBuildResult;
}

export const AGENT_INTENTS: readonly AgentIntent[] = [
  {
    id: 'split-at-playhead',
    label: 'Split selected clip at playhead',
    description: 'Splits the selected clip into two at the current playhead time.',
    destructive: false,
    buildStep: (project, selectedClipIds, playheadUs) => {
      const clipId = selectedClipIds[0];
      if (clipId === undefined) return { ok: false, reason: 'Select a clip first.' };
      const location = findClipLocation(project, clipId);
      if (location === undefined) return { ok: false, reason: `Clip ${clipId} not found.` };
      const { compositionId, trackId, clip } = location;
      const endUs = clip.startUs + clip.durationUs;
      if (!(playheadUs > clip.startUs && playheadUs < endUs))
        return { ok: false, reason: 'Move the playhead strictly inside the selected clip.' };
      const newClipId = `${clip.id}-split-${playheadUs}`;
      return {
        ok: true,
        step: {
          id: 'step-1',
          description: `Split ${clip.id} at ${playheadUs}µs`,
          mode: 'command',
          tool: 'splitClip',
          arguments: { compositionId, trackId, clipId: clip.id, atUs: playheadUs, newClipId },
          dependsOn: [],
          expectedChange: `Split clip ${clip.id} into ${clip.id} and ${newClipId}`,
          preconditions: [],
          requiresConfirmation: false,
        },
      };
    },
  },
  {
    id: 'recipe-split-trim',
    label: 'Recipe: split → trim tail',
    description:
      'Splits at playhead, then trims the new right half start to the playhead (real commands). Enable caption burn-in + Export for the full delivery path.',
    destructive: false,
    buildStep: (project, selectedClipIds, playheadUs) => {
      const recipe = buildSplitTrimRecipe(project, selectedClipIds, playheadUs);
      if (!recipe.ok) return recipe;
      return { ok: true, step: recipe.steps[0]! };
    },
  },
  {
    id: 'shorten-intro',
    label: 'Shorten the intro by 2s',
    description:
      'Trims the first clip on the timeline and ripples every later clip on that track back by the same amount. Runs as one transaction, so one undo reverts all of it.',
    destructive: false,
    buildStep: (project) => {
      const recipe = buildShortenIntroRecipe(project);
      if (!recipe.ok) return recipe;
      const first = recipe.steps[0];
      if (first === undefined) return { ok: false, reason: 'Planner produced no steps.' };
      return { ok: true, step: first };
    },
  },
  {
    id: 'move-to-playhead',
    label: 'Move selected clip to playhead',
    description: "Moves the selected clip's start to the current playhead time.",
    destructive: false,
    buildStep: (project, selectedClipIds, playheadUs) => {
      const clipId = selectedClipIds[0];
      if (clipId === undefined) return { ok: false, reason: 'Select a clip first.' };
      const location = findClipLocation(project, clipId);
      if (location === undefined) return { ok: false, reason: `Clip ${clipId} not found.` };
      const { compositionId, trackId, clip } = location;
      return {
        ok: true,
        step: {
          id: 'step-1',
          description: `Move ${clip.id} to ${playheadUs}µs`,
          mode: 'command',
          tool: 'moveClip',
          arguments: { compositionId, trackId, clipId: clip.id, newStartUs: playheadUs },
          dependsOn: [],
          expectedChange: `Move clip ${clip.id} to ${playheadUs}`,
          preconditions: [],
          requiresConfirmation: false,
        },
      };
    },
  },
  {
    id: 'remove-selected',
    label: 'Remove selected clip',
    description: 'Deletes the selected clip from its track.',
    destructive: true,
    buildStep: (project, selectedClipIds) => {
      const clipId = selectedClipIds[0];
      if (clipId === undefined) return { ok: false, reason: 'Select a clip first.' };
      const location = findClipLocation(project, clipId);
      if (location === undefined) return { ok: false, reason: `Clip ${clipId} not found.` };
      const { compositionId, trackId, clip } = location;
      return {
        ok: true,
        step: {
          id: 'step-1',
          description: `Remove ${clip.id}`,
          mode: 'command',
          tool: 'removeClip',
          arguments: { compositionId, trackId, clipId: clip.id },
          dependsOn: [],
          expectedChange: `Remove clip ${clip.id}`,
          preconditions: [],
          requiresConfirmation: true,
        },
      };
    },
  },
  {
    id: 'join-with-next',
    label: 'Join selected clip with next',
    description: 'Joins the selected clip with the one immediately after it on the same track.',
    destructive: true,
    buildStep: (project, selectedClipIds) => {
      const clipId = selectedClipIds[0];
      if (clipId === undefined) return { ok: false, reason: 'Select a clip first.' };
      const location = findClipLocation(project, clipId);
      if (location === undefined) return { ok: false, reason: `Clip ${clipId} not found.` };
      const next = findNextClip(project, location);
      if (next === undefined)
        return {
          ok: false,
          reason: 'There is no adjacent clip after the selected clip on this track.',
        };
      return {
        ok: true,
        step: {
          id: 'step-1',
          description: `Join ${location.clip.id} with ${next.id}`,
          mode: 'command',
          tool: 'joinClips',
          arguments: {
            compositionId: location.compositionId,
            trackId: location.trackId,
            firstClipId: location.clip.id,
            secondClipId: next.id,
          },
          dependsOn: [],
          expectedChange: `Join clips ${location.clip.id} and ${next.id}`,
          preconditions: [],
          requiresConfirmation: true,
        },
      };
    },
  },
  {
    id: 'insert-test-clip',
    label: 'Insert 1s test clip at playhead',
    description: 'Inserts a new one-second clip (using the intro asset) at the playhead.',
    destructive: false,
    buildStep: (project, _selectedClipIds, playheadUs) => {
      const composition = project.compositions[project.rootCompositionId];
      const track = composition?.tracks[0];
      if (composition === undefined || track === undefined)
        return { ok: false, reason: 'No track is available in the root composition.' };
      const newClipId = `agent-clip-${playheadUs}`;
      return {
        ok: true,
        step: {
          id: 'step-1',
          description: `Insert a 1s test clip at ${playheadUs}µs`,
          mode: 'command',
          tool: 'insertClip',
          arguments: {
            compositionId: composition.id,
            trackId: track.id,
            clip: {
              id: newClipId,
              kind: 'video',
              startUs: playheadUs,
              durationUs: 1_000_000,
              assetId: 'asset-intro',
              sourceInUs: 0,
            },
          },
          dependsOn: [],
          expectedChange: `Insert clip ${newClipId}`,
          preconditions: [],
          requiresConfirmation: false,
        },
      };
    },
  },
];

/** Default nudge for the demo intent; the planner accepts any positive amount. */
export const SHORTEN_INTRO_DEFAULT_US = 2_000_000;

/**
 * P16 vertical slice. Unlike the other intents this one is a *ripple* edit —
 * trimming the opening clip alone would leave a hole, so every later clip on
 * the track moves back with it. Its steps are only correct together, which is
 * why it runs through `runPlanAtomically` (one transaction, one undo) rather
 * than the per-step executor.
 */
export function buildShortenIntroRecipe(
  project: SpikeProject,
  byUs: number = SHORTEN_INTRO_DEFAULT_US,
): RecipeBuildResult {
  const analysed = analyseShortenIntro(project, { byUs });
  if (!analysed.ok) return { ok: false, reason: analysed.reason };
  return { ok: true, steps: analysed.plan.steps, goal: analysed.plan.goal };
}

export type RecipeBuildResult =
  | { readonly ok: true; readonly steps: readonly AgentPlanStep[]; readonly goal: string }
  | { readonly ok: false; readonly reason: string };

/** P14.6: real split → trim recipe (caption burn-in + Export stay UI). */
export function buildSplitTrimRecipe(
  project: SpikeProject,
  selectedClipIds: readonly string[],
  playheadUs: number,
): RecipeBuildResult {
  const clipId = selectedClipIds[0];
  if (clipId === undefined) return { ok: false, reason: 'Select a clip first.' };
  const location = findClipLocation(project, clipId);
  if (location === undefined) return { ok: false, reason: `Clip ${clipId} not found.` };
  const { compositionId, trackId, clip } = location;
  const endUs = clip.startUs + clip.durationUs;
  if (!(playheadUs > clip.startUs && playheadUs < endUs))
    return { ok: false, reason: 'Move the playhead strictly inside the selected clip.' };
  const newClipId = `${clip.id}-split-${playheadUs}`;
  return {
    ok: true,
    goal: 'Split at playhead, then trim the new right half to start at the playhead',
    steps: [
      {
        id: 'step-1',
        description: `Split ${clip.id} at ${playheadUs}µs`,
        mode: 'command',
        tool: 'splitClip',
        arguments: { compositionId, trackId, clipId: clip.id, atUs: playheadUs, newClipId },
        dependsOn: [],
        expectedChange: `Split clip ${clip.id} into ${clip.id} and ${newClipId}`,
        preconditions: [],
        requiresConfirmation: false,
      },
      {
        id: 'step-2',
        description: `Trim ${newClipId} start to ${playheadUs}µs`,
        mode: 'command',
        tool: 'trimClip',
        arguments: {
          compositionId,
          trackId,
          clipId: newClipId,
          newStartUs: playheadUs,
        },
        dependsOn: ['step-1'],
        expectedChange: `Trim clip ${newClipId} start to ${playheadUs}`,
        preconditions: [],
        requiresConfirmation: false,
      },
    ],
  };
}
