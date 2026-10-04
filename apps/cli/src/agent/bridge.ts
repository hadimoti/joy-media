import { spawn } from 'node:child_process';
import type {
  JoyAgentToolBridge,
  JoyDocumentOperation,
  JoyPlanChecklistItem,
  JoyTimelineOperation,
} from '@joy-media/joy-agent-engine';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import { sourceTimeAtVideoClipTime, validateJoyProjectV1 } from '@joy-media/project-schema';
import { recomputeRootDuration } from '../utils/timeline-math.js';
import { buildFfmpegFramePlan } from '../render/ffmpeg-plan.js';
import { resolveFfmpegExecutable } from '../render/ffmpeg-run.js';
import { DEFAULT_JOY_AGENT_LIMITS } from '@joy-media/joy-agent-engine';
import { createTextClip } from '../render/text-clip.js';
import { resolveTextFont } from '../render/text-font.js';
import {
  createFfmpegTextWorkspace,
  removeFfmpegTextWorkspace,
  writeFfmpegTextFiles,
} from '../render/text-files.js';

export interface StagedOperationsSummary {
  readonly timelineOps: readonly JoyTimelineOperation[];
  readonly documentOps: readonly JoyDocumentOperation[];
}

export interface AppliedTimelineSummary {
  readonly clips: readonly {
    readonly clipId: string;
    readonly trackId: string;
    readonly track: string;
    readonly startUs: number;
    readonly endUs: number;
    readonly sourceInUs?: number;
    readonly sourceOutUs?: number;
  }[];
  readonly gaps: readonly {
    readonly trackId: string;
    readonly startUs: number;
    readonly endUs: number;
  }[];
  readonly blackRegions: readonly { readonly startUs: number; readonly endUs: number }[];
}

export interface ApplyStagedResult {
  readonly updatedProject: JoyProjectV1;
  readonly appliedCount: number;
  readonly appliedOperationIds: readonly string[];
  readonly errors: string[];
  readonly notes: string[];
  readonly placementSummary: AppliedTimelineSummary;
}

export class CliJoyAgentToolBridge implements JoyAgentToolBridge {
  private stagedTimeline: JoyTimelineOperation[] = [];
  private stagedDocument: JoyDocumentOperation[] = [];
  private selectedClipIds: string[] = [];
  private playheadUs: number = 0;
  private lastApplyResult: ApplyStagedResult | undefined;
  private submittedPlan = false;
  private timelineProposalIssues: string[] = [];
  private documentProposalIssues: string[] = [];
  private finalChecklist: JoyPlanChecklistItem[] = [];

  constructor(
    private project: JoyProjectV1,
    private revision: number,
    private onStagedChange?: (summary: StagedOperationsSummary) => void,
    private readonly autoApply = false,
  ) {}

  setSelection(clipIds: string[], playheadUs: number = 0): void {
    this.selectedClipIds = [...clipIds];
    this.playheadUs = playheadUs;
  }

  getStagedOperations(): StagedOperationsSummary {
    return {
      timelineOps: [...this.stagedTimeline],
      documentOps: [...this.stagedDocument],
    };
  }

  hasSubmittedPlan(): boolean {
    return this.submittedPlan;
  }

  getReportedIssues(): string[] {
    return [...this.timelineProposalIssues, ...this.documentProposalIssues];
  }

  getPlanChecklist(): readonly JoyPlanChecklistItem[] {
    return [...this.finalChecklist];
  }

  clearStaged(): void {
    this.stagedTimeline = [];
    this.stagedDocument = [];
    this.notify();
  }

  private notify(): void {
    this.onStagedChange?.(this.getStagedOperations());
  }

  async readProjectSummary(): Promise<unknown> {
    const root = this.project.compositions[this.project.rootCompositionId];
    let clipCount = 0;
    const tracksSummary = (root?.tracks ?? []).map((t) => {
      const count = t.clips?.length ?? 0;
      clipCount += count;
      return {
        id: t.id,
        name: t.name ?? t.id,
        family: t.family ?? 'visual',
        clipCount: count,
        locked: t.locked ?? false,
      };
    });

    return {
      projectId: this.project.id,
      title: this.project.title,
      revision: this.revision,
      dimensions: {
        width: root?.width ?? 1080,
        height: root?.height ?? 1920,
      },
      durationUs: root
        ? root.tracks.reduce(
            (maximum, track) =>
              Math.max(maximum, ...track.clips.map((clip) => clip.startUs + clip.durationUs)),
            0,
          )
        : 0,
      clipCount,
      tracks: tracksSummary,
      assetCount: Object.keys(this.project.assets ?? {}).length,
    };
  }

  async readSelection(): Promise<unknown> {
    return {
      selectedClipIds: this.selectedClipIds,
      playheadUs: this.playheadUs,
    };
  }

  async readFrame(input: { readonly atUs: number; readonly maxEdge?: number }): Promise<
    | {
        readonly mediaType: 'image/jpeg';
        readonly base64: string;
        readonly width: number;
        readonly height: number;
      }
    | { readonly unavailable: string }
  > {
    const maxEdge = Math.min(input.maxEdge ?? 1024, 1024);
    const textWorkspace = createFfmpegTextWorkspace();
    try {
      let plan;
      try {
        plan = buildFfmpegFramePlan(this.project, input.atUs, maxEdge, textWorkspace);
      } catch {
        return { unavailable: 'Frame is outside the available local timeline.' };
      }
      writeFfmpegTextFiles(plan.textFiles);
      const hasLocalVisualMedia = plan.inputs.some((input) => {
        const kind = this.project.assets[input.assetId]?.kind;
        return kind === 'video' || kind === 'image';
      });
      if (!hasLocalVisualMedia) return { unavailable: 'No local video media is available.' };
      const maxOutputBytes = Math.floor((DEFAULT_JOY_AGENT_LIMITS.toolPayloadBytes * 3) / 4);
      return await new Promise((resolve) => {
        let settled = false;
        let pendingUnavailable: string | undefined;
        let outputBytes = 0;
        const chunks: Buffer[] = [];
        const child = spawn(resolveFfmpegExecutable(), plan.args, {
          shell: false,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        const onInterrupt = () => child.kill('SIGINT');
        process.once('SIGINT', onInterrupt);
        const finish = (result: Awaited<ReturnType<CliJoyAgentToolBridge['readFrame']>>): void => {
          if (settled) return;
          settled = true;
          resolve(result);
        };
        child.on('error', () => {
          process.removeListener('SIGINT', onInterrupt);
          finish({ unavailable: 'ffmpeg is not available.' });
        });
        child.stdout.on('data', (chunk: Buffer) => {
          outputBytes += chunk.byteLength;
          if (outputBytes > maxOutputBytes) {
            pendingUnavailable = 'Frame exceeds the tool payload limit.';
            void child.kill();
            return;
          }
          chunks.push(chunk);
        });
        child.on('close', (code) => {
          process.removeListener('SIGINT', onInterrupt);
          if (pendingUnavailable) {
            finish({ unavailable: pendingUnavailable });
            return;
          }
          if (code !== 0 || chunks.length === 0) {
            finish({ unavailable: 'ffmpeg could not read this local frame.' });
            return;
          }
          const bytes = Buffer.concat(chunks);
          const scale = Math.min(1, maxEdge / plan.width, maxEdge / plan.height);
          finish({
            mediaType: 'image/jpeg',
            base64: bytes.toString('base64'),
            width: Math.round(plan.width * scale),
            height: Math.round(plan.height * scale),
          });
        });
      });
    } finally {
      removeFfmpegTextWorkspace(textWorkspace);
    }
  }

  async readTimelineWindow(input: {
    readonly startUs: number;
    readonly endUs: number;
  }): Promise<unknown> {
    const root = this.project.compositions[this.project.rootCompositionId];
    const matchingClips: Array<{
      trackId: string;
      trackName: string;
      clipId: string;
      startUs: number;
      durationUs: number;
      assetId?: string | undefined;
    }> = [];

    for (const track of root?.tracks ?? []) {
      for (const clip of track.clips ?? []) {
        const clipEnd = clip.startUs + clip.durationUs;
        if (clip.startUs < input.endUs && clipEnd > input.startUs) {
          matchingClips.push({
            trackId: track.id,
            trackName: track.name ?? track.id,
            clipId: clip.id,
            startUs: clip.startUs,
            durationUs: clip.durationUs,
            assetId: 'assetId' in clip ? (clip.assetId as string) : undefined,
          });
        }
      }
    }

    return {
      window: { startUs: input.startUs, endUs: input.endUs },
      clips: matchingClips,
    };
  }

  async readAssetMetadata(input: { readonly assetIds: readonly string[] }): Promise<unknown> {
    const results: Record<string, unknown> = {};
    for (const id of input.assetIds) {
      if (this.project.assets && this.project.assets[id]) {
        results[id] = this.project.assets[id];
      }
    }
    return { assets: results };
  }

  async readStyleCatalog(): Promise<unknown> {
    return {
      textStyles: ['headline', 'subheadline', 'caption-glow', 'callout'],
      looks: ['crt', 'bw', 'warm', 'cool'],
      transitions: ['crossfade', 'slide-left', 'wipe-up', 'zoom-in'],
      aspectRatios: ['9:16 (Reels/TikTok)', '16:9 (YouTube)', '1:1 (Square)'],
    };
  }

  async proposeTimelineOperations(input: {
    readonly operations: readonly JoyTimelineOperation[];
  }): Promise<unknown> {
    const errors = this.validateTimelineProposal(input.operations);
    if (errors.length > 0) {
      this.timelineProposalIssues = [...errors];
      return { accepted: false, errors };
    }
    this.timelineProposalIssues = [];
    this.stagedTimeline.push(...input.operations);
    this.lastApplyResult = undefined;
    this.notify();
    return {
      accepted: true,
      staged: true,
      addedCount: input.operations.length,
      totalStaged: this.stagedTimeline.length,
      revision: this.revision,
    };
  }

  async proposeDocumentOperations(input: {
    readonly operations: readonly JoyDocumentOperation[];
  }): Promise<unknown> {
    const errors = this.validateDocumentProposal(input.operations);
    if (errors.length > 0) {
      this.documentProposalIssues = [...errors];
      return { accepted: false, errors };
    }
    this.documentProposalIssues = [];
    this.stagedDocument.push(...input.operations);
    this.lastApplyResult = undefined;
    this.notify();
    return {
      accepted: true,
      staged: true,
      addedCount: input.operations.length,
      totalStaged: this.stagedDocument.length,
      revision: this.revision,
      notes: input.operations.flatMap((operation) => {
        if (operation.kind !== 'create-text' || !operation.trackId) return [];
        const requested = this.project.compositions[this.project.rootCompositionId]?.tracks.find(
          (track) => track.id === operation.trackId,
        );
        if (requested?.kind !== 'video') return [];
        const destination = this.project.compositions[this.project.rootCompositionId]?.tracks.find(
          (track) => track.kind === 'caption',
        );
        return [
          `Text operation ${operation.id} will be routed from video track ${requested.id} to ${destination?.id ?? 'a new caption track'}.`,
        ];
      }),
    };
  }

  private validateTimelineProposal(operations: readonly JoyTimelineOperation[]): string[] {
    const root = this.project.compositions[this.project.rootCompositionId];
    if (!root) return ['Project has no root composition.'];
    const tracks = root.tracks;
    const clips = tracks.flatMap((track) => track.clips.map((clip) => ({ track, clip })));
    const knownIds = new Set([
      ...this.stagedTimeline.map((operation) => operation.id),
      ...this.stagedDocument.map((operation) => operation.id),
      ...clips.map(({ clip }) => clip.id),
    ]);
    const minimumFrame = oneFrameUs(root.frameRate.num, root.frameRate.den);
    const errors: string[] = [];
    for (const operation of operations) {
      if (knownIds.has(operation.id)) errors.push(`Operation id ${operation.id} already exists.`);
      knownIds.add(operation.id);
      if (operation.kind === 'insert') {
        const track = tracks.find((candidate) => candidate.id === operation.trackId);
        if (!track) errors.push(`Track ${operation.trackId} not found.`);
        else if (track.kind !== 'video')
          errors.push(`Track ${operation.trackId} cannot host video clips.`);
        if (!this.project.assets?.[operation.assetId])
          errors.push(`Asset ${operation.assetId} not found.`);
        if (operation.durationUs < minimumFrame)
          errors.push(`Operation ${operation.id} duration is shorter than one project frame.`);
        continue;
      }
      const found = clips.find(({ clip }) => clip.id === operation.clipId);
      if (!found) errors.push(`Clip ${operation.clipId} not found.`);
      if (operation.kind === 'move') {
        const target = tracks.find((candidate) => candidate.id === operation.trackId);
        if (!target) errors.push(`Track ${operation.trackId} not found.`);
        else if (target.kind !== found?.track.kind)
          errors.push(
            `Track ${operation.trackId} cannot host ${found?.clip.kind ?? 'this'} clips.`,
          );
      }
      if (operation.kind === 'trim' && operation.sourceOutUs <= operation.sourceInUs)
        errors.push(`Operation ${operation.id} sourceOutUs must be after sourceInUs.`);
      if (operation.kind === 'trim' && operation.sourceOutUs - operation.sourceInUs < minimumFrame)
        errors.push(`Operation ${operation.id} source range is shorter than one project frame.`);
    }
    if (errors.length > 0) return errors;
    const preview = new CliJoyAgentToolBridge(structuredClone(this.project), this.revision);
    preview.stagedTimeline = [...this.stagedTimeline, ...operations];
    preview.stagedDocument = [...this.stagedDocument];
    return preview.applyStaged().errors;
  }

  private validateDocumentProposal(operations: readonly JoyDocumentOperation[]): string[] {
    const root = this.project.compositions[this.project.rootCompositionId];
    if (!root) return ['Project has no root composition.'];
    const tracks = root.tracks;
    const knownIds = new Set([
      ...this.stagedTimeline.map((operation) => operation.id),
      ...this.stagedDocument.map((operation) => operation.id),
      ...Object.keys(this.project.captionDocuments ?? {}),
    ]);
    const errors: string[] = [];
    const minimumFrame = oneFrameUs(root.frameRate.num, root.frameRate.den);
    for (const operation of operations) {
      if (knownIds.has(operation.id))
        errors.push(`Operation or document id ${operation.id} already exists.`);
      knownIds.add(operation.id);
      if (operation.kind === 'create-text') {
        if (operation.durationUs < minimumFrame)
          errors.push(`Text ${operation.id} duration is shorter than one project frame.`);
        if (operation.x !== undefined && Math.abs(operation.x) > 0.4)
          errors.push(`Text ${operation.id} x must be in editor units from -0.4 to 0.4.`);
        if (operation.y !== undefined && Math.abs(operation.y) > 0.4)
          errors.push(`Text ${operation.id} y must be in editor units from -0.4 to 0.4.`);
        if (operation.trackId) {
          const track = tracks.find((candidate) => candidate.id === operation.trackId);
          if (!track) errors.push(`Track ${operation.trackId} not found.`);
          else if (track.kind !== 'video' && track.kind !== 'caption')
            errors.push(`Track ${operation.trackId} cannot host caption text.`);
        }
      } else if (
        operation.kind === 'set-text' &&
        !this.project.visualObjects?.[operation.objectId]
      ) {
        errors.push(`Object ${operation.objectId} not found.`);
      } else if (operation.kind === 'set-text') {
        errors.push(`set-text for ${operation.objectId} is not rendered by the CLI.`);
      } else if (operation.kind === 'set-property') {
        const object = this.project.visualObjects?.[operation.objectId];
        if (!object) errors.push(`Object ${operation.objectId} not found.`);
        else if (object.kind === 'text')
          errors.push(`Text property ${operation.property} is not rendered by the CLI.`);
        else if (!['opacity', 'x', 'y', 'scale', 'rotation'].includes(operation.property))
          errors.push(`Property ${operation.property} is not writable for ${object.kind}.`);
        else if (typeof operation.value !== 'number' || !Number.isFinite(operation.value))
          errors.push(`Property ${operation.property} requires a finite numeric value.`);
      } else if (operation.kind === 'add-effect') {
        const clip = this.project.compositions[this.project.rootCompositionId]?.tracks
          .flatMap((track) => track.clips)
          .find((candidate) => candidate.id === operation.objectId);
        if (!clip) errors.push(`Clip ${operation.objectId} not found.`);
        else if (clip.kind !== 'video')
          errors.push(`Look ${operation.effectId} requires a video clip.`);
      }
    }
    if (errors.length > 0) return errors;
    const preview = new CliJoyAgentToolBridge(structuredClone(this.project), this.revision);
    preview.stagedTimeline = [...this.stagedTimeline];
    preview.stagedDocument = [...this.stagedDocument, ...operations];
    return preview.applyStaged().errors;
  }

  async submitPlan(
    input: { readonly checklist: readonly JoyPlanChecklistItem[] } = { checklist: [] },
  ): Promise<unknown> {
    this.submittedPlan = true;
    this.finalChecklist = [...input.checklist];
    if (this.autoApply) {
      const preview = new CliJoyAgentToolBridge(structuredClone(this.project), this.revision);
      preview.stagedTimeline = [...this.stagedTimeline];
      preview.stagedDocument = [...this.stagedDocument];
      const result = preview.applyStaged();
      return {
        awaitingApproval: false,
        willApplyOnFinish: true,
        staged: true,
        applied: false,
        validationErrors: result.errors,
        placementSummary: result.placementSummary,
        checklist: this.finalChecklist,
        timelineOperations: this.stagedTimeline.length,
        documentOperations: this.stagedDocument.length,
        revision: this.revision,
      };
    }
    return {
      awaitingApproval: !this.autoApply,
      willApplyOnFinish: this.autoApply,
      timelineOperations: this.stagedTimeline.length,
      documentOperations: this.stagedDocument.length,
      revision: this.revision,
      checklist: this.finalChecklist,
    };
  }

  /**
   * Applies all staged operations onto the project and returns a clean, modified project document.
   */
  applyStaged(): ApplyStagedResult {
    if (
      this.lastApplyResult !== undefined &&
      this.stagedTimeline.length === 0 &&
      this.stagedDocument.length === 0
    )
      return this.lastApplyResult;
    const current = structuredClone(this.project);
    const errors: string[] = [];
    const notes: string[] = [];
    let appliedCount = 0;
    const appliedOperationIds: string[] = [];
    const recordApplied = (operationId: string) => {
      appliedCount++;
      appliedOperationIds.push(operationId);
    };

    const root = current.compositions[current.rootCompositionId];
    if (!root) {
      return {
        updatedProject: current,
        appliedCount: 0,
        appliedOperationIds: [],
        errors: ['Missing root composition'],
        notes,
        placementSummary: summarizePlacements(current),
      };
    }

    const tracks = root.tracks as unknown as Array<{
      id: string;
      kind: string;
      family?: string;
      clips: Array<{
        id: string;
        startUs: number;
        durationUs: number;
        kind?: string;
        sourceInUs?: number;
        childOffsetUs?: number;
        playbackRate?: number;
        reversed?: boolean;
        [key: string]: unknown;
      }>;
    }>;

    // Apply timeline operations
    for (const op of this.stagedTimeline) {
      try {
        if (op.kind === 'insert') {
          const track = tracks.find((t) => t.id === op.trackId);
          if (!track) {
            errors.push(`Track ${op.trackId} not found for insert`);
            continue;
          }
          if (track.kind !== 'video') {
            errors.push(`Track ${op.trackId} cannot host video clips`);
            continue;
          }
          if (
            track.clips.some(
              (clip) =>
                op.startUs < clip.startUs + clip.durationUs &&
                op.startUs + op.durationUs > clip.startUs,
            )
          ) {
            errors.push(`Insert ${op.id} overlaps another clip on track ${op.trackId}`);
            continue;
          }
          track.clips.push({
            id: op.id,
            kind: 'video',
            assetId: op.assetId,
            startUs: op.startUs,
            durationUs: op.durationUs,
            sourceInUs: 0,
          });
          recordApplied(op.id);
        } else if (op.kind === 'remove') {
          let found = false;
          for (const track of tracks) {
            const index = track.clips.findIndex((c) => c.id === op.clipId);
            if (index !== -1) {
              track.clips.splice(index, 1);
              found = true;
              recordApplied(op.id);
              break;
            }
          }
          if (!found) errors.push(`Clip ${op.clipId} not found for remove`);
        } else if (op.kind === 'move') {
          const sourceTrack = tracks.find((track) =>
            track.clips.some((clip) => clip.id === op.clipId),
          );
          const sourceIndex = sourceTrack?.clips.findIndex((clip) => clip.id === op.clipId) ?? -1;
          if (!sourceTrack || sourceIndex < 0) {
            errors.push(`Clip ${op.clipId} not found to move`);
            continue;
          }
          const targetTrack = tracks.find((t) => t.id === op.trackId);
          if (!targetTrack) {
            errors.push(`Target track ${op.trackId} not found`);
            continue;
          }
          const sourceClip = sourceTrack.clips[sourceIndex]!;
          const compatibleKind =
            sourceClip.kind === 'composition' || sourceClip.kind === 'video'
              ? targetTrack.kind === 'video'
              : sourceClip.kind === targetTrack.kind;
          const compatibleFamily = !(targetTrack.family === 'audio' && sourceClip.kind === 'video');
          if (!compatibleKind || !compatibleFamily) {
            errors.push(`Track ${op.trackId} cannot host ${sourceClip.kind} clips`);
            continue;
          }
          if (
            targetTrack.clips.some(
              (clip) =>
                clip.id !== op.clipId &&
                op.startUs < clip.startUs + clip.durationUs &&
                op.startUs + sourceClip.durationUs > clip.startUs,
            )
          ) {
            errors.push(`Move of ${op.clipId} overlaps another clip on track ${op.trackId}`);
            continue;
          }
          const updated = { ...sourceClip, startUs: op.startUs };
          sourceTrack.clips.splice(sourceIndex, 1);
          targetTrack.clips.push(updated);
          targetTrack.clips.sort((a, b) => a.startUs - b.startUs);
          recordApplied(op.id);
        } else if (op.kind === 'trim') {
          if (op.sourceOutUs <= op.sourceInUs) {
            errors.push(
              `Invalid trim range for ${op.clipId}: sourceOutUs must be after sourceInUs`,
            );
            continue;
          }
          let found = false;
          for (const track of tracks) {
            const clip = track.clips.find((c) => c.id === op.clipId);
            if (clip) {
              const rate =
                typeof clip.playbackRate === 'number' && clip.playbackRate > 0
                  ? clip.playbackRate
                  : 1;
              const nextStartUs = op.timelineStartUs ?? clip.startUs;
              const nextDurationUs = Math.round((op.sourceOutUs - op.sourceInUs) / rate);
              const overlapping = track.clips.some(
                (other) =>
                  other.id !== clip.id &&
                  nextStartUs < other.startUs + other.durationUs &&
                  nextStartUs + nextDurationUs > other.startUs,
              );
              if (overlapping) {
                errors.push(`Trim of ${op.clipId} overlaps another clip on track ${track.id}`);
                found = true;
                break;
              }
              if (clip.kind === 'video') {
                clip.sourceInUs = op.sourceInUs;
              } else if (clip.kind === 'composition') {
                errors.push(
                  `Trim of ${op.clipId} requires source media and cannot trim a composition clip.`,
                );
                found = true;
                break;
              }
              clip.startUs = nextStartUs;
              clip.durationUs = nextDurationUs;
              found = true;
              if (!errors.some((error) => error.includes(`Trim of ${op.clipId}`)))
                recordApplied(op.id);
              track.clips.sort((a, b) => a.startUs - b.startUs);
              break;
            }
          }
          if (!found) errors.push(`Clip ${op.clipId} not found for trim`);
        } else if (op.kind === 'split') {
          let found = false;
          for (const track of tracks) {
            const index = track.clips.findIndex((c) => c.id === op.clipId);
            if (index !== -1) {
              const original = track.clips[index]!;
              const origStart = original.startUs;
              const origEnd = original.startUs + original.durationUs;
              if (op.atUs > origStart && op.atUs < origEnd) {
                const duration1 = op.atUs - origStart;
                const duration2 = origEnd - op.atUs;
                original.durationUs = duration1;
                const secondPart = {
                  ...original,
                  id: `${original.id}-split-${op.id}`,
                  startUs: op.atUs,
                  durationUs: duration2,
                } as typeof original;
                if (original.kind === 'video') {
                  secondPart.sourceInUs = sourceTimeAtVideoClipTime(original as never, op.atUs);
                } else if (original.kind === 'composition') {
                  secondPart.childOffsetUs = (secondPart.childOffsetUs ?? 0) + duration1;
                }
                track.clips.splice(index + 1, 0, secondPart);
                found = true;
                recordApplied(op.id);
              }
              break;
            }
          }
          if (!found) errors.push(`Clip ${op.clipId} cannot split at ${op.atUs}us`);
        }
      } catch (err) {
        errors.push(`Error applying ${op.kind}: ${String(err)}`);
      }
    }

    // Apply document operations
    for (const op of this.stagedDocument) {
      try {
        if (op.kind === 'create-text') {
          const requestedTrack = op.trackId
            ? tracks.find((candidate) => candidate.id === op.trackId)
            : undefined;
          let track =
            requestedTrack?.kind === 'video'
              ? tracks.find((candidate) => candidate.kind === 'caption')
              : (requestedTrack ?? tracks.find((candidate) => candidate.kind === 'caption'));
          if (requestedTrack?.kind === 'video')
            notes.push(
              `Text operation ${op.id} rerouted from video track ${requestedTrack.id} to a caption track.`,
            );
          if (!track) {
            if (op.trackId && requestedTrack === undefined) {
              errors.push(`unsupported: caption track ${op.trackId} was not found.`);
              continue;
            }
            const captionTrack = {
              id: `track-captions-${tracks.length + 1}`,
              kind: 'caption',
              family: 'visual',
              name: 'Captions',
              order:
                Math.max(
                  -1,
                  ...tracks.map((candidate) =>
                    Number((candidate as { order?: number }).order ?? -1),
                  ),
                ) + 1,
              enabled: true,
              locked: false,
              clips: [],
            };
            tracks.push(captionTrack);
            track = captionTrack;
            if (requestedTrack?.kind === 'video')
              notes[notes.length - 1] =
                `Text operation ${op.id} rerouted from video track ${requestedTrack.id} to new caption track ${captionTrack.id}.`;
          }
          if (!resolveTextFont()) {
            errors.push('unsupported: no usable font found; set JOY_FONT or install DejaVu Sans.');
            continue;
          }
          const created = createTextClip({
            id: op.id,
            text: op.text,
            startUs: op.startUs,
            durationUs: op.durationUs,
            ...(op.x === undefined ? {} : { x: op.x }),
            ...(op.y === undefined ? {} : { y: op.y }),
            ...(op.size === undefined ? {} : { size: op.size }),
            ...(op.color === undefined ? {} : { color: op.color }),
          });
          (current.captionDocuments as Record<string, unknown>)[created.document.id] =
            created.document;
          track.clips.push(created.clip as unknown as (typeof track.clips)[number]);
          recordApplied(op.id);
        } else if (op.kind === 'set-text') {
          errors.push(`unsupported: set-text for ${op.objectId} is not rendered by ffmpeg.`);
        } else if (op.kind === 'set-property') {
          const object = current.visualObjects?.[op.objectId] as
            (typeof current.visualObjects)[string] | undefined;
          if (!object) {
            errors.push(`Object ${op.objectId} not found`);
          } else {
            if (object.kind === 'text') {
              errors.push(`unsupported: text property ${op.property} is not rendered by ffmpeg.`);
              continue;
            }
            const allowed = new Set([
              'opacity',
              'x',
              'y',
              'scale',
              'rotation',
              'fontSize',
              'color',
            ]);
            if (!allowed.has(op.property)) {
              errors.push(`Property ${op.property} is not writable`);
            } else if (op.property === 'color' && typeof op.value !== 'string') {
              errors.push('Property color requires a string value');
            } else if (op.property !== 'color' && typeof op.value !== 'number') {
              errors.push(`Property ${op.property} requires a numeric value`);
            } else {
              const editable = object as unknown as {
                transform: Record<string, unknown>;
                textStyle?: Record<string, unknown>;
              };
              if (['opacity', 'x', 'y'].includes(op.property)) {
                editable.transform[op.property] = op.value;
              } else if (op.property === 'scale') {
                editable.transform.scaleX = op.value;
                editable.transform.scaleY = op.value;
              } else if (op.property === 'rotation') {
                editable.transform.rotationDeg = op.value;
              } else {
                errors.push(`Property ${op.property} is not supported for ${object.kind} objects`);
                continue;
              }
              recordApplied(op.id);
            }
          }
        } else if (op.kind === 'add-effect') {
          const clip = tracks
            .flatMap((track) => track.clips)
            .find((candidate) => candidate.id === op.objectId);
          if (!clip || clip.kind !== 'video') {
            errors.push(`Look target ${op.objectId} is not a video clip.`);
          } else {
            (clip as unknown as { look?: Record<string, unknown> }).look = {
              preset: op.effectId,
              ...(op.intensity === undefined ? {} : { intensity: op.intensity }),
              ...(op.scanlineStrength === undefined
                ? {}
                : { scanlineStrength: op.scanlineStrength }),
              ...(op.noiseAmount === undefined ? {} : { noiseAmount: op.noiseAmount }),
            };
            recordApplied(op.id);
          }
        }
      } catch (err) {
        errors.push(`Error applying ${op.kind}: ${String(err)}`);
      }
    }

    for (const track of tracks) track.clips.sort((a, b) => a.startUs - b.startUs);
    recomputeRootDuration(current);
    const diagnostics = validateJoyProjectV1(current);
    for (const diagnostic of diagnostics) {
      errors.push(`${diagnostic.path}: ${diagnostic.message}`);
    }
    if (diagnostics.length > 0) {
      return {
        updatedProject: this.project,
        appliedCount: 0,
        appliedOperationIds: [],
        errors,
        notes,
        placementSummary: summarizePlacements(this.project),
      };
    }
    this.project = current;
    this.clearStaged();

    this.lastApplyResult = {
      updatedProject: current,
      appliedCount,
      appliedOperationIds,
      errors,
      notes,
      placementSummary: summarizePlacements(current),
    };
    return this.lastApplyResult;
  }
}

function summarizePlacements(project: JoyProjectV1): AppliedTimelineSummary {
  const root = project.compositions[project.rootCompositionId];
  if (!root) return { clips: [], gaps: [], blackRegions: [] };
  const visualTracks = root.tracks.filter(
    (track) =>
      track.enabled !== false &&
      track.family !== 'audio' &&
      (track.kind === 'video' || track.kind === 'caption') &&
      track.clips.length > 0,
  );
  const clips: AppliedTimelineSummary['clips'][number][] = [];
  const gaps: AppliedTimelineSummary['gaps'][number][] = [];
  const allSpans: Array<{ startUs: number; endUs: number }> = [];
  for (const track of visualTracks) {
    const spans = track.clips
      .map((clip) => ({ startUs: clip.startUs, endUs: clip.startUs + clip.durationUs }))
      .sort((a, b) => a.startUs - b.startUs);
    for (const clip of track.clips) {
      const range = {
        clipId: clip.id,
        trackId: track.id,
        track: track.name ?? track.id,
        startUs: clip.startUs,
        endUs: clip.startUs + clip.durationUs,
      };
      if (clip.kind === 'video') {
        clips.push({
          ...range,
          sourceInUs: clip.sourceInUs,
          sourceOutUs: sourceTimeAtVideoClipTime(clip, clip.startUs + clip.durationUs),
        });
      } else clips.push(range);
    }
    allSpans.push(
      ...track.clips
        .filter((clip) => clip.kind === 'video')
        .map((clip) => ({ startUs: clip.startUs, endUs: clip.startUs + clip.durationUs })),
    );
    let coveredUntil = 0;
    for (const span of spans) {
      if (span.startUs > coveredUntil)
        gaps.push({ trackId: track.id, startUs: coveredUntil, endUs: span.startUs });
      coveredUntil = Math.max(coveredUntil, span.endUs);
    }
    if (coveredUntil < root.durationUs)
      gaps.push({ trackId: track.id, startUs: coveredUntil, endUs: root.durationUs });
  }
  const merged = allSpans
    .map((span) => ({
      startUs: Math.max(0, span.startUs),
      endUs: Math.min(root.durationUs, span.endUs),
    }))
    .filter((span) => span.endUs > span.startUs)
    .sort((a, b) => a.startUs - b.startUs);
  const blackRegions: Array<{ startUs: number; endUs: number }> = [];
  let coveredUntil = 0;
  for (const span of merged) {
    if (span.startUs > coveredUntil)
      blackRegions.push({ startUs: coveredUntil, endUs: span.startUs });
    coveredUntil = Math.max(coveredUntil, span.endUs);
  }
  if (coveredUntil < root.durationUs)
    blackRegions.push({ startUs: coveredUntil, endUs: root.durationUs });
  return { clips, gaps, blackRegions };
}

function oneFrameUs(frameRateNumerator: number, frameRateDenominator: number): number {
  if (frameRateNumerator <= 0 || frameRateDenominator <= 0)
    throw new RangeError('Project frame rate must be positive.');
  return Math.ceil((1_000_000 * frameRateDenominator) / frameRateNumerator);
}
