/**
 * Randomized invariant tests (§36-P0-2, §32.1 property-based):
 * seeded sequences of valid random edits must keep the document schema-valid,
 * every command's inverse must restore the exact prior state, undo-all must
 * return to the initial project, redo-all must return to the final state, and
 * replaying the serialized log must reproduce the final state.
 */
import { describe, expect, it } from 'vitest';
import type { SpikeProject } from '@joy-media/project-schema';
import { rangeEndUs, validateSpikeProject } from '@joy-media/project-schema';
import { emptySpikeProject, makeVideoClip } from '@joy-media/test-fixtures';
import type { SpikeCommand } from './commands.js';
import { applyCommand } from './commands.js';
import { ProjectHistory } from './history.js';

const MS = 1000;
const TRACKS = ['track-0', 'track-1'] as const;

/** mulberry32 — small deterministic PRNG, good enough for fixture generation. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Gap {
  startUs: number;
  endUs: number;
}

function trackClips(project: SpikeProject, trackId: string) {
  return project.compositions['root']!.tracks.find((t) => t.id === trackId)!.clips;
}

function freeGaps(project: SpikeProject, trackId: string, excludeClipId?: string): Gap[] {
  const durationUs = project.compositions['root']!.durationUs;
  const clips = trackClips(project, trackId)
    .filter((c) => c.id !== excludeClipId)
    .slice()
    .sort((a, b) => a.startUs - b.startUs);
  const gaps: Gap[] = [];
  let cursor = 0;
  for (const clip of clips) {
    if (clip.startUs > cursor) gaps.push({ startUs: cursor, endUs: clip.startUs });
    cursor = rangeEndUs({ startUs: clip.startUs, durationUs: clip.durationUs });
  }
  if (cursor < durationUs) gaps.push({ startUs: cursor, endUs: durationUs });
  return gaps.filter((g) => g.endUs - g.startUs >= 2 * MS);
}

/** Generates one applicable random command, or null if the chosen op has no legal target. */
function generateCommand(
  project: SpikeProject,
  random: () => number,
  nextId: () => string,
): SpikeCommand | null {
  const pick = <T>(items: readonly T[]): T | null =>
    items.length === 0 ? null : items[Math.floor(random() * items.length)]!;
  const intIn = (lo: number, hi: number): number =>
    lo + Math.floor(random() * ((hi - lo) / MS)) * MS; // ms-aligned integers
  const trackId = pick(TRACKS)!;
  const target = { compositionId: 'root', trackId } as const;
  const clips = trackClips(project, trackId);
  const op = Math.floor(random() * 7);

  switch (op) {
    case 0: {
      const gap = pick(freeGaps(project, trackId));
      if (gap === null) return null;
      const startUs = intIn(gap.startUs, gap.endUs - MS);
      const durationUs = Math.max(MS, intIn(MS, gap.endUs - startUs));
      return {
        type: 'timeline.insertClip',
        payload: { ...target, clip: makeVideoClip(nextId(), startUs, durationUs) },
      };
    }
    case 1: {
      const clip = pick(clips);
      if (clip === null) return null;
      return { type: 'timeline.removeClip', payload: { ...target, clipId: clip.id } };
    }
    case 2: {
      const clip = pick(clips);
      if (clip === null) return null;
      const gap = pick(
        freeGaps(project, trackId, clip.id).filter((g) => g.endUs - g.startUs >= clip.durationUs),
      );
      if (gap === null) return null;
      const newStartUs = intIn(gap.startUs, gap.endUs - clip.durationUs + MS);
      if (newStartUs + clip.durationUs > gap.endUs) return null;
      return { type: 'timeline.moveClip', payload: { ...target, clipId: clip.id, newStartUs } };
    }
    case 3: {
      const clip = pick(clips.filter((c) => c.durationUs >= 2 * MS));
      if (clip === null) return null;
      const endUs = rangeEndUs({ startUs: clip.startUs, durationUs: clip.durationUs });
      const newStartUs = intIn(clip.startUs + MS, endUs);
      if (!(newStartUs > clip.startUs && newStartUs < endUs)) return null;
      return {
        type: 'timeline.trimClipStart',
        payload: { ...target, clipId: clip.id, newStartUs },
      };
    }
    case 4: {
      const clip = pick(clips.filter((c) => c.durationUs >= 2 * MS));
      if (clip === null) return null;
      const endUs = rangeEndUs({ startUs: clip.startUs, durationUs: clip.durationUs });
      const newEndUs = intIn(clip.startUs + MS, endUs);
      if (!(newEndUs > clip.startUs && newEndUs <= endUs)) return null;
      return { type: 'timeline.trimClipEnd', payload: { ...target, clipId: clip.id, newEndUs } };
    }
    case 5: {
      const clip = pick(clips.filter((c) => c.durationUs >= 2 * MS));
      if (clip === null) return null;
      const endUs = rangeEndUs({ startUs: clip.startUs, durationUs: clip.durationUs });
      const atUs = intIn(clip.startUs + MS, endUs);
      if (!(atUs > clip.startUs && atUs < endUs)) return null;
      return {
        type: 'timeline.splitClip',
        payload: { ...target, clipId: clip.id, atUs, newClipId: nextId() },
      };
    }
    default: {
      const track = project.compositions['root']!.tracks.find((t) => t.id === trackId)!;
      return { type: 'property.setTrackEnabled', payload: { ...target, enabled: !track.enabled } };
    }
  }
}

describe('randomized command invariants', () => {
  const SEEDS = Array.from({ length: 25 }, (_, i) => i + 1);
  const OPS_PER_SEED = 40;

  it.each(SEEDS)('seed %i: validity, inverse, undo-all, redo-all, replay', (seed) => {
    const random = mulberry32(seed);
    let idCounter = 0;
    const nextId = (): string => `gen-${seed}-${idCounter++}`;

    const initial = emptySpikeProject();
    const history = new ProjectHistory(initial);
    const log: SpikeCommand[] = [];
    let applied = 0;

    for (let i = 0; i < OPS_PER_SEED; i++) {
      const before = history.present;
      const command = generateCommand(before, random, nextId);
      if (command === null) continue;

      // invariant: command + inverse restores the exact prior state
      const single = applyCommand(before, command);
      expect(applyCommand(single.project, single.inverse).project).toEqual(before);

      history.apply({ label: command.type, commands: [command] });
      log.push(command);
      applied++;

      // invariant: the document stays schema-valid after every applied command
      expect(validateSpikeProject(history.present)).toEqual([]);
    }
    expect(applied).toBeGreaterThan(10); // the generator must actually exercise the system

    const finalState = history.present;

    // invariant: undo-all returns to the initial project
    while (history.canUndo) history.undo();
    expect(history.present).toEqual(initial);

    // invariant: redo-all returns to the final state
    while (history.canRedo) history.redo();
    expect(history.present).toEqual(finalState);

    // invariant: replaying the serialized log reproduces the final state
    const revived = JSON.parse(JSON.stringify(log)) as SpikeCommand[];
    let replayed: SpikeProject = emptySpikeProject();
    for (const command of revived) {
      replayed = applyCommand(replayed, command).project;
    }
    expect(replayed).toEqual(finalState);
  });
});
