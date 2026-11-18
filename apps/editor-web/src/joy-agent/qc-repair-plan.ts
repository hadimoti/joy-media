/**
 * QC findings to one repair plan (card T-B06, ADR-0045 section 7).
 *
 * Pure and deterministic: the same findings and the same project always give
 * the same plan. It reads the real project and maps each measured finding to
 * existing commands only. A language model never invents these edits; the host
 * builds them from the report, the same way the "shorten the intro" recipe does.
 *
 * What is repaired, and with which existing command:
 *  - `black` at the head or tail of a clip, and `frozen` anywhere inside one
 *    clip: the range is cut out of that clip's track (`timeline.trimClipStart`,
 *    `timeline.trimClipEnd`, `timeline.splitClip`, `timeline.removeClip`) and
 *    the later clips of that track ripple back (`timeline.moveClip`).
 *  - `loudness` and `clipping`: one master-bus gain change (`audioBus.setGain`),
 *    held under the true-peak limit.
 *  - `safe-area`: the title is moved inside the 90 percent area
 *    (`object.setTransformProperty` on `x` and `y`).
 *
 * Everything else is listed as not repairable with a plain reason, and so is a
 * repairable type whose situation the commands cannot honestly handle (black in
 * the middle of a shot, a range that spans two clips, an animated title).
 * `text-legibility` is not repairable: JOY has no text backing (a box behind
 * text) in its document model, and changing the text colour is a taste choice.
 */

import { applyTransaction, CommandError } from '@joy-media/commands';
import type { AudioCommand, AudioState, SpikeCommand } from '@joy-media/commands';
import { createPlan } from '@joy-media/agent-tools';
import type { AgentEditPlan, AgentPlanStep } from '@joy-media/agent-tools';
import type { Clip, JoyProjectV1, SpikeProject, Track } from '@joy-media/project-schema';
import type { VisualObjectCommand } from '@joy-media/property-system';
import type { TimelineQcTextBox } from '../media-observation/qc-sampler.js';

/** The part of a report finding the planner reads. Extra fields are ignored. */
export interface QcRepairFinding {
  readonly id: string;
  readonly type: string;
  readonly startUs: number;
  readonly endUs: number;
  readonly measured?: Readonly<Record<string, unknown>>;
}

export interface QcRepairRange {
  readonly startUs: number;
  readonly endUs: number;
}

/** Audio targets. The defaults match the Worker's default thresholds (`media-qc.ts`). */
export interface QcRepairAudioTargets {
  readonly targetLufs: number;
  readonly loudnessMinLufs: number;
  readonly loudnessMaxLufs: number;
  readonly truePeakMaxDb: number;
}

export const DEFAULT_QC_REPAIR_AUDIO_TARGETS: QcRepairAudioTargets = Object.freeze({
  targetLufs: -14,
  loudnessMinLufs: -26,
  loudnessMaxLufs: -9,
  truePeakMaxDb: -1,
});

/** Finding types the planner can repair in some situations. */
export const QC_REPAIRABLE_TYPES: readonly string[] = Object.freeze([
  'black',
  'frozen',
  'loudness',
  'clipping',
  'safe-area',
]);

export interface QcRepairInput {
  readonly findings: readonly QcRepairFinding[];
  readonly timeline: SpikeProject;
  /** The creative document: titles and their transforms. */
  readonly document: JoyProjectV1;
  /** The current mixer graph (the editor keeps it in `document.audio`). */
  readonly audio: AudioState;
  /** Title and caption boxes as fractions of the frame; `id` is the visual object id. */
  readonly textBoxes?: readonly TimelineQcTextBox[];
  /** Whether a timeline clip is picture (a video shot). Titles and audio rows are never cut. */
  readonly isPictureClip?: (clip: Clip, track: Track) => boolean;
  readonly audioTargets?: QcRepairAudioTargets;
  readonly planId?: string;
  readonly createdAt?: string;
}

export type QcRepairEdit =
  | {
      readonly kind: 'cut';
      readonly findingIds: readonly string[];
      readonly trackId: string;
      readonly clipId: string;
      readonly startUs: number;
      readonly endUs: number;
      readonly commands: readonly SpikeCommand[];
    }
  | {
      readonly kind: 'gain';
      readonly findingIds: readonly string[];
      readonly busId: string;
      readonly fromGain: number;
      readonly toGain: number;
      readonly changeDb: number;
      readonly command: AudioCommand;
    }
  | {
      readonly kind: 'move';
      readonly findingIds: readonly string[];
      readonly objectId: string;
      readonly dxPx: number;
      readonly dyPx: number;
      readonly startUs: number;
      readonly endUs: number;
      readonly commands: readonly VisualObjectCommand[];
    };

export interface QcNotRepairable {
  readonly findingId: string;
  readonly type: string;
  readonly reason: string;
}

export interface QcRepairPlan {
  readonly edits: readonly QcRepairEdit[];
  readonly notRepairable: readonly QcNotRepairable[];
  /** Every timeline command, in the order they must run. */
  readonly timelineCommands: readonly SpikeCommand[];
  readonly audioCommands: readonly AudioCommand[];
  readonly visualCommands: readonly VisualObjectCommand[];
  /** Ranges of the edited cut (times after the plan) that must be checked again. */
  readonly changedRanges: readonly QcRepairRange[];
  /** The finding types this plan repairs. */
  readonly repairedTypes: readonly string[];
  /** Maps a time before the plan to the same moment after it (cuts move later picture back). */
  readonly mapTimeUs: (timeUs: number) => number;
  /** The same plan in the shape the existing plan-and-approve card shows. */
  readonly agentPlan: AgentEditPlan;
}

/** A finding edge this close to a clip edge counts as the edge (ffmpeg times are frame-rounded). */
const EDGE_TOLERANCE_US = 100_000;
/** The join of a cut is checked again this far on each side. */
const JOIN_RECHECK_US = 500_000;
/** The shortest piece a cut may leave behind. */
const MIN_REMAINING_US = 100_000;
const MAX_BUS_GAIN = 8;
const SAFE_MIN = 0.05;
const SAFE_MAX = 0.95;
const SAFE_SPAN = SAFE_MAX - SAFE_MIN;

interface CutCandidate {
  readonly findingIds: string[];
  readonly types: Set<string>;
  startUs: number;
  endUs: number;
}

/** Builds the one repair plan for a set of findings. */
export function planQcRepairs(input: QcRepairInput): QcRepairPlan {
  const notRepairable: QcNotRepairable[] = [];
  const refuse = (finding: QcRepairFinding, reason: string): void => {
    notRepairable.push({ findingId: finding.id, type: finding.type, reason });
  };
  const root = input.timeline.compositions[input.timeline.rootCompositionId];
  const isPicture = input.isPictureClip ?? ((clip: Clip) => clip.kind === 'video');

  const cutFindings: QcRepairFinding[] = [];
  const audioFindings: QcRepairFinding[] = [];
  const moveFindings: QcRepairFinding[] = [];
  for (const finding of input.findings) {
    if (!validRange(finding)) {
      refuse(finding, 'The finding has no usable time range.');
      continue;
    }
    switch (finding.type) {
      case 'black':
      case 'frozen':
        cutFindings.push(finding);
        break;
      case 'loudness':
      case 'clipping':
        audioFindings.push(finding);
        break;
      case 'safe-area':
        moveFindings.push(finding);
        break;
      default:
        refuse(finding, notRepairableReason(finding.type));
    }
  }

  // Cuts: merge overlapping ranges, then cut from the latest to the earliest so
  // every earlier time stays where the report measured it.
  const edits: QcRepairEdit[] = [];
  const cuts: {
    readonly startUs: number;
    readonly durationUs: number;
    readonly joinUs: number;
  }[] = [];
  const timelineCommands: SpikeCommand[] = [];
  if (cutFindings.length > 0 && root === undefined) {
    for (const finding of cutFindings) refuse(finding, 'The project has no root composition.');
  } else if (root !== undefined) {
    let staged = input.timeline;
    const usedIds = collectClipIds(input.timeline);
    const candidates = mergeCutCandidates(cutFindings).sort(
      (left, right) => right.startUs - left.startUs,
    );
    for (const candidate of candidates) {
      const planned = planCut(
        staged,
        input.timeline.rootCompositionId,
        candidate,
        isPicture,
        usedIds,
      );
      if (!planned.ok) {
        for (const findingId of candidate.findingIds) {
          const finding = cutFindings.find((item) => item.id === findingId)!;
          refuse(finding, planned.reason);
        }
        continue;
      }
      try {
        staged = applyTransaction(staged, {
          label: 'QC repair check',
          commands: [...planned.commands],
        }).project;
      } catch (error) {
        const reason =
          error instanceof CommandError
            ? 'The cut does not fit the timeline as it is now.'
            : 'The cut could not be checked.';
        for (const findingId of candidate.findingIds)
          refuse(
            cutFindings.find((item) => item.id === findingId)!,
            reason,
          );
        continue;
      }
      timelineCommands.push(...planned.commands);
      cuts.push({
        startUs: planned.startUs,
        durationUs: planned.endUs - planned.startUs,
        joinUs: planned.startUs,
      });
      edits.push({
        kind: 'cut',
        findingIds: [...candidate.findingIds],
        trackId: planned.trackId,
        clipId: planned.clipId,
        startUs: planned.startUs,
        endUs: planned.endUs,
        commands: planned.commands,
      });
    }
  }

  const mapTimeUs = (timeUs: number): number => {
    let shifted = timeUs;
    for (const cut of cuts) {
      if (timeUs >= cut.startUs + cut.durationUs) shifted -= cut.durationUs;
      else if (timeUs > cut.startUs) shifted -= timeUs - cut.startUs;
    }
    return shifted;
  };

  // Audio: one master-bus gain change that meets every audio finding it can.
  const audioCommands: AudioCommand[] = [];
  if (audioFindings.length > 0) {
    const gain = planGain(audioFindings, input.audio, input.audioTargets);
    if (gain.ok) {
      audioCommands.push(gain.edit.command);
      edits.push(gain.edit);
    } else for (const finding of audioFindings) refuse(finding, gain.reason);
  }

  // Titles: move each one inside the safe area.
  const visualCommands: VisualObjectCommand[] = [];
  if (moveFindings.length > 0) {
    const claimed = new Set<string>();
    for (const finding of moveFindings) {
      const planned = planMove(finding, input, root, claimed);
      if (!planned.ok) {
        refuse(finding, planned.reason);
        continue;
      }
      claimed.add(planned.edit.objectId);
      visualCommands.push(...planned.edit.commands);
      edits.push(planned.edit);
    }
  }

  const durationAfterUs = mapTimeUs(timelineDurationUs(input.timeline));
  const changedRanges = mergeRanges(
    edits.flatMap((edit): QcRepairRange[] => {
      if (edit.kind === 'gain') return [{ startUs: 0, endUs: durationAfterUs }];
      if (edit.kind === 'move')
        return [{ startUs: mapTimeUs(edit.startUs), endUs: mapTimeUs(edit.endUs) }];
      const joinUs = mapTimeUs(edit.startUs);
      return [
        {
          startUs: Math.max(0, joinUs - JOIN_RECHECK_US),
          endUs: Math.min(durationAfterUs, joinUs + JOIN_RECHECK_US),
        },
      ];
    }),
  ).filter((range) => range.endUs > range.startUs);

  const repairedTypes = [
    ...new Set(
      edits.flatMap((edit) =>
        edit.findingIds.map((id) => input.findings.find((finding) => finding.id === id)!.type),
      ),
    ),
  ];

  return Object.freeze({
    edits,
    notRepairable,
    timelineCommands,
    audioCommands,
    visualCommands,
    changedRanges,
    repairedTypes,
    mapTimeUs,
    agentPlan: buildAgentPlan(edits, notRepairable, input),
  });
}

/** True when the plan holds at least one edit. */
export function hasQcRepairs(plan: QcRepairPlan): boolean {
  return plan.edits.length > 0;
}

function notRepairableReason(type: string): string {
  switch (type) {
    case 'text-legibility':
      return 'JOY has no text backing to add; change the text colour or its place by hand.';
    case 'scene-cut':
      return 'A hard cut is a choice of the editor, not a fault to remove.';
    case 'av-length-mismatch':
      return 'The video and sound are different lengths; adjust them by hand.';
    case 'exposure':
    case 'colour-cast':
      return 'The grade is a taste decision; JOY does not change it on its own.';
    case 'silence':
      return 'Cutting a silent stretch also cuts the picture; decide what to cut by hand.';
    case 'audio-dropout':
      return 'A click or a gap comes from the source file; fix the source.';
    case 'missing-media':
      return 'The file is missing; find or relink it.';
    case 'unfitted':
    case 'caption-collision':
      return 'No existing command in the plan path repairs this yet.';
    default:
      return 'JOY has no existing command for this kind of finding.';
  }
}

function validRange(finding: QcRepairFinding): boolean {
  return (
    Number.isSafeInteger(finding.startUs) &&
    Number.isSafeInteger(finding.endUs) &&
    finding.startUs >= 0 &&
    finding.endUs >= finding.startUs
  );
}

function mergeCutCandidates(findings: readonly QcRepairFinding[]): CutCandidate[] {
  const sorted = [...findings].sort((left, right) => left.startUs - right.startUs);
  const merged: CutCandidate[] = [];
  for (const finding of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && finding.startUs <= last.endUs) {
      last.endUs = Math.max(last.endUs, finding.endUs);
      last.findingIds.push(finding.id);
      last.types.add(finding.type);
      continue;
    }
    merged.push({
      findingIds: [finding.id],
      types: new Set([finding.type]),
      startUs: finding.startUs,
      endUs: finding.endUs,
    });
  }
  return merged;
}

type PlannedCut =
  | {
      readonly ok: true;
      readonly trackId: string;
      readonly clipId: string;
      readonly startUs: number;
      readonly endUs: number;
      readonly commands: readonly SpikeCommand[];
    }
  | { readonly ok: false; readonly reason: string };

function planCut(
  project: SpikeProject,
  compositionId: string,
  candidate: CutCandidate,
  isPicture: (clip: Clip, track: Track) => boolean,
  usedIds: Set<string>,
): PlannedCut {
  const composition = project.compositions[compositionId]!;
  const covering: { track: Track; clip: Clip }[] = [];
  for (const track of composition.tracks) {
    if (track.family === 'audio') continue;
    for (const clip of track.clips) {
      if (!isPicture(clip, track)) continue;
      const clipEnd = clip.startUs + clip.durationUs;
      if (candidate.startUs < clipEnd && candidate.endUs > clip.startUs)
        covering.push({ track, clip });
    }
  }
  if (covering.length === 0) return { ok: false, reason: 'No shot sits under this range.' };
  if (covering.length > 1)
    return {
      ok: false,
      reason: covering.every((entry) => entry.track.id === covering[0]!.track.id)
        ? 'The range runs over two shots; cut it by hand.'
        : 'Several picture layers overlap this range; choose which one to cut by hand.',
    };
  const { track, clip } = covering[0]!;
  if (track.locked === true) return { ok: false, reason: 'The track is locked.' };
  const clipEnd = clip.startUs + clip.durationUs;
  // Snap edges that are within a frame or two of the clip's own edges.
  const startUs =
    Math.abs(candidate.startUs - clip.startUs) <= EDGE_TOLERANCE_US
      ? clip.startUs
      : candidate.startUs;
  const endUs =
    Math.abs(candidate.endUs - clipEnd) <= EDGE_TOLERANCE_US ? clipEnd : candidate.endUs;
  if (startUs < clip.startUs || endUs > clipEnd)
    return {
      ok: false,
      reason: 'The range runs over two shots; cut it by hand.',
    };
  const atHead = startUs === clip.startUs;
  const atTail = endUs === clipEnd;
  const onlyBlack = candidate.types.size === 1 && candidate.types.has('black');
  if (onlyBlack && !atHead && !atTail)
    return {
      ok: false,
      reason: 'Black in the middle of a shot may be intended; JOY cuts only a black head or tail.',
    };
  if (endUs - startUs < 1) return { ok: false, reason: 'The range is too short to cut.' };
  if (!(atHead && atTail)) {
    const leftUs = (atHead ? 0 : startUs - clip.startUs) + (atTail ? 0 : clipEnd - endUs);
    if (leftUs < MIN_REMAINING_US)
      return { ok: false, reason: 'The cut would leave a piece too short to keep.' };
    if (!atHead && startUs - clip.startUs < MIN_REMAINING_US)
      return { ok: false, reason: 'The cut would leave a piece too short to keep.' };
    if (!atTail && clipEnd - endUs < MIN_REMAINING_US)
      return { ok: false, reason: 'The cut would leave a piece too short to keep.' };
  }

  const target = { compositionId, trackId: track.id };
  const durationUs = endUs - startUs;
  const commands: SpikeCommand[] = [];
  if (atHead && atTail) {
    commands.push({ type: 'timeline.removeClip', payload: { ...target, clipId: clip.id } });
  } else if (atHead) {
    commands.push(
      {
        type: 'timeline.trimClipStart',
        payload: { ...target, clipId: clip.id, newStartUs: endUs },
      },
      { type: 'timeline.moveClip', payload: { ...target, clipId: clip.id, newStartUs: startUs } },
    );
  } else if (atTail) {
    commands.push({
      type: 'timeline.trimClipEnd',
      payload: { ...target, clipId: clip.id, newEndUs: startUs },
    });
  } else {
    const middleId = uniqueClipId(`${clip.id}-qc-cut`, usedIds);
    const restId = uniqueClipId(`${clip.id}-qc-rest`, usedIds);
    commands.push(
      {
        type: 'timeline.splitClip',
        payload: { ...target, clipId: clip.id, atUs: startUs, newClipId: middleId },
      },
      {
        type: 'timeline.splitClip',
        payload: { ...target, clipId: middleId, atUs: endUs, newClipId: restId },
      },
      { type: 'timeline.removeClip', payload: { ...target, clipId: middleId } },
      { type: 'timeline.moveClip', payload: { ...target, clipId: restId, newStartUs: startUs } },
    );
  }
  // Later clips on the same track ripple back, earliest first, so each moves into free space.
  const later = track.clips
    .filter((other) => other.id !== clip.id && other.startUs >= clipEnd)
    .sort((left, right) => left.startUs - right.startUs);
  for (const other of later)
    commands.push({
      type: 'timeline.moveClip',
      payload: { ...target, clipId: other.id, newStartUs: other.startUs - durationUs },
    });
  return { ok: true, trackId: track.id, clipId: clip.id, startUs, endUs, commands };
}

type PlannedGain =
  | { readonly ok: true; readonly edit: Extract<QcRepairEdit, { kind: 'gain' }> }
  | { readonly ok: false; readonly reason: string };

function planGain(
  findings: readonly QcRepairFinding[],
  audio: AudioState,
  targets: QcRepairAudioTargets = DEFAULT_QC_REPAIR_AUDIO_TARGETS,
): PlannedGain {
  const bus = audio.buses.find((item) => item.id === 'master') ?? audio.buses[0];
  if (bus === undefined) return { ok: false, reason: 'The project has no master bus.' };
  if (!Number.isFinite(bus.gain) || bus.gain <= 0)
    return { ok: false, reason: 'The master bus is silenced; raise it by hand first.' };

  let lufs: number | undefined;
  let peakDb: number | undefined;
  for (const finding of findings) {
    const measured = finding.measured ?? {};
    const integrated = numberOf(measured['integratedLufs']);
    if (integrated !== undefined) lufs = integrated;
    const truePeak = numberOf(measured['truePeakDbfs']);
    const samplePeak = numberOf(measured['peakDb']);
    for (const peak of [truePeak, samplePeak])
      if (peak !== undefined) peakDb = peakDb === undefined ? peak : Math.max(peakDb, peak);
  }
  if (lufs === undefined && peakDb === undefined)
    return { ok: false, reason: 'The finding carries no level to correct.' };

  // The highest change the peaks allow, and the change the loudness wants.
  const peakRoomDb = peakDb === undefined ? Infinity : targets.truePeakMaxDb - peakDb;
  let wantedDb: number;
  if (lufs !== undefined && (lufs < targets.loudnessMinLufs || lufs > targets.loudnessMaxLufs))
    wantedDb = targets.targetLufs - lufs;
  else wantedDb = Math.min(0, peakRoomDb);
  let changeDb = Math.min(wantedDb, peakRoomDb);
  // A cut that was loud enough must not drop below the quiet limit to save a peak.
  if (lufs !== undefined && lufs + changeDb < targets.loudnessMinLufs && changeDb < wantedDb)
    return {
      ok: false,
      reason: 'The peaks are too high to reach a good level with one gain change.',
    };
  // Rounded down to a tenth of a dB, so a rounded change never pushes a peak over its limit.
  changeDb = Math.floor(changeDb * 10) / 10;
  if (Math.abs(changeDb) < 0.1)
    return {
      ok: false,
      reason: 'The peaks leave no room for a gain change; lower the loudest clip by hand.',
    };
  const toGain = Math.min(MAX_BUS_GAIN, bus.gain * 10 ** (changeDb / 20));
  const roundedGain = Math.round(toGain * 10_000) / 10_000;
  return {
    ok: true,
    edit: {
      kind: 'gain',
      findingIds: findings.map((finding) => finding.id),
      busId: bus.id,
      fromGain: bus.gain,
      toGain: roundedGain,
      changeDb,
      command: { type: 'audioBus.setGain', payload: { busId: bus.id, gain: roundedGain } },
    },
  };
}

type PlannedMove =
  | { readonly ok: true; readonly edit: Extract<QcRepairEdit, { kind: 'move' }> }
  | { readonly ok: false; readonly reason: string };

function planMove(
  finding: QcRepairFinding,
  input: QcRepairInput,
  root: SpikeProject['compositions'][string] | undefined,
  claimed: ReadonlySet<string>,
): PlannedMove {
  const box = (input.textBoxes ?? []).find(
    (candidate) =>
      !claimed.has(candidate.id) &&
      candidate.startUs === finding.startUs &&
      candidate.endUs === finding.endUs &&
      !insideSafeArea(candidate),
  );
  if (box === undefined) return { ok: false, reason: 'JOY could not tell which title this is.' };
  const object = input.document.visualObjects[box.id];
  if (object === undefined) return { ok: false, reason: 'The title is not in the project.' };
  if (
    object.animations?.x !== undefined ||
    object.animations?.y !== undefined ||
    object.expressions?.x !== undefined ||
    object.expressions?.y !== undefined ||
    object.spatialPath !== undefined
  )
    return { ok: false, reason: 'The title moves over time; place it by hand.' };
  if (object.parentId !== undefined)
    return { ok: false, reason: 'The title follows a parent; move the parent by hand.' };
  if (box.width > SAFE_SPAN || box.height > SAFE_SPAN)
    return { ok: false, reason: 'The title is wider or taller than the safe area; resize it.' };
  const width = input.document.compositions[input.timeline.rootCompositionId]?.width ?? root?.width;
  const height =
    input.document.compositions[input.timeline.rootCompositionId]?.height ?? root?.height;
  if (width === undefined || height === undefined)
    return { ok: false, reason: 'The frame size is unknown.' };
  const dx = shiftInto(box.x, box.width);
  const dy = shiftInto(box.y, box.height);
  // Round away from the edge so a rounded pixel never lands back outside.
  const dxPx = dx === 0 ? 0 : Math.sign(dx) * Math.ceil(Math.abs(dx) * width);
  const dyPx = dy === 0 ? 0 : Math.sign(dy) * Math.ceil(Math.abs(dy) * height);
  const commands: VisualObjectCommand[] = [];
  if (dxPx !== 0)
    commands.push({
      type: 'object.setTransformProperty',
      payload: { objectId: object.id, key: 'x', value: object.transform.x + dxPx },
    });
  if (dyPx !== 0)
    commands.push({
      type: 'object.setTransformProperty',
      payload: { objectId: object.id, key: 'y', value: object.transform.y + dyPx },
    });
  if (commands.length === 0) return { ok: false, reason: 'The title is already inside.' };
  return {
    ok: true,
    edit: {
      kind: 'move',
      findingIds: [finding.id],
      objectId: object.id,
      dxPx,
      dyPx,
      startUs: box.startUs,
      endUs: box.endUs,
      commands,
    },
  };
}

/** The same rule as the sampler's safe-area check (`qc-sampler.ts`). */
export function insideSafeArea(
  box: Pick<TimelineQcTextBox, 'x' | 'y' | 'width' | 'height'>,
): boolean {
  return (
    box.x >= SAFE_MIN &&
    box.y >= SAFE_MIN &&
    box.x + box.width <= SAFE_MAX &&
    box.y + box.height <= SAFE_MAX
  );
}

function shiftInto(start: number, size: number): number {
  if (start < SAFE_MIN) return SAFE_MIN - start;
  if (start + size > SAFE_MAX) return SAFE_MAX - (start + size);
  return 0;
}

function buildAgentPlan(
  edits: readonly QcRepairEdit[],
  notRepairable: readonly QcNotRepairable[],
  input: QcRepairInput,
): AgentEditPlan {
  const steps: AgentPlanStep[] = edits.map((edit, index) => ({
    id: `qc-repair-${index + 1}`,
    description: describeEdit(edit),
    mode: 'command',
    tool:
      edit.kind === 'cut'
        ? 'qc.cutRange'
        : edit.kind === 'gain'
          ? 'qc.setMasterGain'
          : 'qc.moveIntoSafeArea',
    arguments:
      edit.kind === 'cut'
        ? { trackId: edit.trackId, clipId: edit.clipId, startUs: edit.startUs, endUs: edit.endUs }
        : edit.kind === 'gain'
          ? { busId: edit.busId, gain: edit.toGain, changeDb: edit.changeDb }
          : { objectId: edit.objectId, dxPx: edit.dxPx, dyPx: edit.dyPx },
    dependsOn: [],
    expectedChange: describeEdit(edit),
    preconditions: [],
    // ADR-0045 section 7: a QC fix is always previewed and approved.
    requiresConfirmation: true,
  }));
  const rippled = edits.some((edit) => edit.kind === 'cut');
  return createPlan('Fix what the quality check found', steps, {
    ...(input.planId === undefined ? {} : { planId: input.planId }),
    ...(input.createdAt === undefined ? {} : { createdAt: input.createdAt }),
    status: 'pending-approval',
    assumptions: notRepairable.map(
      (entry) => `Not repairable (${entry.type}, ${entry.findingId}): ${entry.reason}`,
    ),
    risks: rippled
      ? ['Later shots on the cut track move back; other tracks stay where they are.']
      : [],
  });
}

function describeEdit(edit: QcRepairEdit): string {
  if (edit.kind === 'cut')
    return `Cut ${seconds(edit.endUs - edit.startUs)} at ${seconds(edit.startUs)} from ${edit.clipId}`;
  if (edit.kind === 'gain')
    return `Change the master level by ${edit.changeDb > 0 ? '+' : ''}${edit.changeDb.toFixed(1)} dB`;
  return `Move ${edit.objectId} inside the safe area`;
}

function seconds(us: number): string {
  return `${(us / 1_000_000).toFixed(2)}s`;
}

function numberOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function collectClipIds(project: SpikeProject): Set<string> {
  const ids = new Set<string>();
  for (const composition of Object.values(project.compositions))
    for (const track of composition.tracks) for (const clip of track.clips) ids.add(clip.id);
  return ids;
}

function uniqueClipId(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

function timelineDurationUs(project: SpikeProject): number {
  const root = project.compositions[project.rootCompositionId];
  let end = 0;
  for (const track of root?.tracks ?? [])
    for (const clip of track.clips) end = Math.max(end, clip.startUs + clip.durationUs);
  return end;
}

function mergeRanges(ranges: readonly QcRepairRange[]): QcRepairRange[] {
  const sorted = [...ranges].sort((left, right) => left.startUs - right.startUs);
  const merged: { startUs: number; endUs: number }[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.startUs <= last.endUs)
      last.endUs = Math.max(last.endUs, range.endUs);
    else merged.push({ ...range });
  }
  return merged;
}
