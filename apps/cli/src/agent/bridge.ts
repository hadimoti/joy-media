import { spawn } from 'node:child_process';
import type {
  JoyAgentToolBridge,
  JoyDocumentOperation,
  JoyPlanChecklistItem,
  JoyTimelineOperation,
} from '@joy-media/joy-agent-engine';
import type { CaptionDocumentV1, JoyProjectV1, TransitionV1 } from '@joy-media/project-schema';
import { sourceTimeAtVideoClipTime, validateJoyProjectV1 } from '@joy-media/project-schema';
import { recomputeRootDuration } from '../utils/timeline-math.js';
import { durationAtSpeedUs, speedProblem } from '../utils/clip-speed.js';
import { buildFfmpegFramePlan } from '../render/ffmpeg-plan.js';
import { resolveFfmpegExecutable } from '../render/ffmpeg-run.js';
import { DEFAULT_JOY_AGENT_LIMITS } from '@joy-media/joy-agent-engine';
import { createTextClip, TEXT_Y_RANGE } from '../render/text-clip.js';
import { layoutFfmpegCaption } from '../render/caption-layout.js';
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

  /** Caption clip ids that exist now or will after the staged create-text operations. */
  private captionClipIds(): Set<string> {
    const root = this.project.compositions[this.project.rootCompositionId];
    return new Set([
      ...(root?.tracks ?? [])
        .flatMap((track) => track.clips)
        .filter((clip) => clip.kind === 'caption')
        .map((clip) => clip.id),
      ...this.stagedDocument
        .filter((operation) => operation.kind === 'create-text')
        .map((operation) => `text-${operation.id}`),
    ]);
  }

  private asTextUpdate(operation: JoyDocumentOperation): JoyDocumentOperation {
    if (operation.kind !== 'set-text' && operation.kind !== 'set-property') return operation;
    if (!this.captionClipIds().has(operation.objectId)) return operation;
    const base = {
      kind: 'update-text' as const,
      id: operation.id,
      objectId: operation.objectId,
      dependsOn: operation.dependsOn,
    };
    if (operation.kind === 'set-text') return { ...base, text: operation.text };
    const property = TEXT_PROPERTY_ALIASES[operation.property.toLowerCase()];
    if (property === undefined) return operation; // reported by validation
    return { ...base, [property]: operation.value } as JoyDocumentOperation;
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
      text?: string | undefined;
      size?: number | undefined;
      x?: number | undefined;
      y?: number | undefined;
      color?: string | undefined;
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
            ...(clip.kind === 'caption' ? describeTextClip(this.project, clip) : {}),
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
      // Only what add-transition can create and the CLI renderer draws (F1).
      transitions: ['crossfade'],
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
    // set-text / set-property on a caption clip are what models try first for "make the title
    // smaller"; they mean update-text (F3).
    const operations = input.operations.map((operation) => this.asTextUpdate(operation));
    const errors = this.validateDocumentProposal(operations);
    if (errors.length > 0) {
      this.documentProposalIssues = [...errors];
      return { accepted: false, errors };
    }
    this.documentProposalIssues = [];
    this.stagedDocument.push(...operations);
    this.lastApplyResult = undefined;
    this.notify();
    return {
      accepted: true,
      staged: true,
      addedCount: operations.length,
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
      if (operation.kind === 'add-transition') {
        const staged = new Set(
          [...this.stagedTimeline, ...operations].flatMap((candidate) =>
            candidate.kind === 'insert' ? [candidate.id] : [],
          ),
        );
        for (const clipId of [operation.leftClipId, operation.rightClipId])
          if (!clips.some(({ clip }) => clip.id === clipId) && !staged.has(clipId))
            errors.push(`Clip ${clipId} not found.`);
        if (operation.leftClipId === operation.rightClipId)
          errors.push(`Transition ${operation.id} needs two different clips.`);
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
      if (operation.kind === 'set-speed') {
        const problem = speedProblem(operation.rate);
        if (problem) errors.push(`Operation ${operation.id}: ${problem}`);
        if (found && found.clip.kind !== 'video')
          errors.push(
            `Speed changes need a video clip; ${operation.clipId} is ${found.clip.kind}.`,
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
        if (
          operation.y !== undefined &&
          (operation.y < TEXT_Y_RANGE.min || operation.y > TEXT_Y_RANGE.max)
        )
          errors.push(
            `Text ${operation.id} y must be from -0.75 to 0.4 (0 = default line near the bottom, about -0.36 = vertical centre, about -0.7 = top).`,
          );
        else if (!textFitsFrame(operation, root?.width ?? 1080, root?.height ?? 1920))
          errors.push(
            `Text ${operation.id} at y ${operation.y ?? 0} with size ${operation.size ?? 1} would not be drawn (it is above the safe area); use a larger y or a smaller size.`,
          );
        if (operation.trackId) {
          const track = tracks.find((candidate) => candidate.id === operation.trackId);
          if (!track) errors.push(`Track ${operation.trackId} not found.`);
          else if (track.kind !== 'video' && track.kind !== 'caption')
            errors.push(`Track ${operation.trackId} cannot host caption text.`);
        }
      } else if (operation.kind === 'update-text') {
        const known = this.captionClipIds().has(operation.objectId);
        const fields = ['text', 'x', 'y', 'size', 'color', 'startUs', 'durationUs'] as const;
        if (!known)
          errors.push(
            `Text clip ${operation.objectId} not found; use the caption clipId from read_timeline_window.`,
          );
        else if (fields.every((field) => operation[field] === undefined))
          errors.push(
            `update-text ${operation.id} changes nothing; give text, size, x, y, color, startUs or durationUs.`,
          );
        if (operation.text !== undefined && !operation.text.trim())
          errors.push(`update-text ${operation.id} text is empty.`);
        if (operation.x !== undefined && Math.abs(operation.x) > 0.4)
          errors.push(`Text ${operation.objectId} x must be in editor units from -0.4 to 0.4.`);
        if (
          operation.y !== undefined &&
          (operation.y < TEXT_Y_RANGE.min || operation.y > TEXT_Y_RANGE.max)
        )
          errors.push(
            `Text ${operation.objectId} y must be from -0.75 to 0.4 (0 = default line near the bottom, about -0.36 = vertical centre, about -0.7 = top).`,
          );
        if (operation.durationUs !== undefined && operation.durationUs < minimumFrame)
          errors.push(`Text ${operation.objectId} duration is shorter than one project frame.`);
      } else if (
        operation.kind === 'set-text' &&
        !this.project.visualObjects?.[operation.objectId]
      ) {
        errors.push(`Object ${operation.objectId} not found.`);
      } else if (operation.kind === 'set-text') {
        errors.push(`set-text for ${operation.objectId} is not rendered by the CLI.`);
      } else if (operation.kind === 'set-property') {
        const object = this.project.visualObjects?.[operation.objectId];
        if (!object && this.captionClipIds().has(operation.objectId))
          errors.push(
            `Text property ${operation.property} cannot be set; use update-text with text, size, x, y, color, startUs or durationUs.`,
          );
        else if (!object) errors.push(`Object ${operation.objectId} not found.`);
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
    const preview = new CliJoyAgentToolBridge(structuredClone(this.project), this.revision);
    preview.stagedTimeline = [...this.stagedTimeline];
    preview.stagedDocument = [...this.stagedDocument];
    const result = preview.applyStaged();
    const checklistErrors = unknownChecklistClips(result.updatedProject, input.checklist).map(
      (clipId) => `Checklist references unknown clip ${clipId}.`,
    );
    if (this.stagedTimeline.length === 0 && this.stagedDocument.length === 0) {
      // Nothing to approve: never report a staged plan the host would refuse anyway.
      return {
        staged: false,
        awaitingApproval: false,
        willApplyOnFinish: false,
        applied: false,
        validationErrors: [
          'No operations are staged: every proposal was rejected or none was made. Fix the rejected proposals before calling submit_plan.',
          ...this.getReportedIssues(),
          ...checklistErrors,
        ],
        timelineOperations: 0,
        documentOperations: 0,
        revision: this.revision,
      };
    }
    this.submittedPlan = true;
    this.finalChecklist = [...input.checklist];
    if (this.autoApply) {
      return {
        awaitingApproval: false,
        willApplyOnFinish: true,
        staged: true,
        applied: false,
        validationErrors: [...result.errors, ...checklistErrors],
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
      staged: true,
      validationErrors: [...result.errors, ...checklistErrors],
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

    // Apply timeline operations; transitions are placed after every clip edit (F1).
    const transitionOps: Extract<JoyTimelineOperation, { kind: 'add-transition' }>[] = [];
    for (const op of this.stagedTimeline) {
      try {
        if (op.kind === 'add-transition') {
          transitionOps.push(op);
        } else if (op.kind === 'insert') {
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
              const mediaEndUs =
                clip.kind === 'video' && clip.timeRemap === undefined && clip.reversed !== true
                  ? current.assets?.[typeof clip.assetId === 'string' ? clip.assetId : '']
                      ?.descriptor?.durationUs
                  : undefined;
              if (
                typeof mediaEndUs === 'number' &&
                mediaEndUs > 0 &&
                (op.sourceInUs >= mediaEndUs || op.sourceOutUs > mediaEndUs)
              ) {
                errors.push(
                  `Trim of ${op.clipId} runs past the end of its media (${mediaEndUs / 1_000_000}s): source ${op.sourceInUs}–${op.sourceOutUs} µs, media ends at ${mediaEndUs} µs.`,
                );
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
        } else if (op.kind === 'set-speed') {
          const track = tracks.find((candidate) =>
            candidate.clips.some((clip) => clip.id === op.clipId),
          );
          const clip = track?.clips.find((candidate) => candidate.id === op.clipId);
          if (!track || !clip) {
            errors.push(`Clip ${op.clipId} not found for set-speed`);
            continue;
          }
          if (clip.kind !== 'video' || clip.timeRemap !== undefined) {
            errors.push(`Speed of ${op.clipId} cannot be changed (needs a plain video clip).`);
            continue;
          }
          const nextDurationUs = durationAtSpeedUs(clip, op.rate);
          if (nextDurationUs < oneFrameUs(root.frameRate.num, root.frameRate.den)) {
            errors.push(`Speed ${op.rate}x makes ${op.clipId} shorter than one frame.`);
            continue;
          }
          if (
            track.clips.some(
              (other) =>
                other.id !== clip.id &&
                clip.startUs < other.startUs + other.durationUs &&
                clip.startUs + nextDurationUs > other.startUs,
            )
          ) {
            errors.push(`Speed ${op.rate}x makes ${op.clipId} overlap another clip on ${track.id}`);
            continue;
          }
          clip.durationUs = nextDurationUs;
          clip.playbackRate = op.rate;
          recordApplied(op.id);
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

    const minimumTransitionUs = oneFrameUs(root.frameRate.num, root.frameRate.den);
    const transitionProblem = (input: {
      readonly leftClipId: string;
      readonly rightClipId: string;
      readonly durationUs: number;
    }): { trackId?: string; problem?: string } => {
      const track = tracks.find((candidate) =>
        candidate.clips.some((clip) => clip.id === input.leftClipId),
      );
      const left = track?.clips.find((clip) => clip.id === input.leftClipId);
      const right = track?.clips.find((clip) => clip.id === input.rightClipId);
      if (!track || !left) return { problem: `clip ${input.leftClipId} not found` };
      if (!right)
        return {
          problem: `clips ${input.leftClipId} and ${input.rightClipId} are not on the same track`,
        };
      if (track.kind !== 'video' || left.kind !== 'video' || right.kind !== 'video')
        return { problem: 'both clips must be video clips on a video track' };
      if (left.startUs + left.durationUs !== right.startUs)
        return {
          problem: `clips must be adjacent: ${input.leftClipId} ends at ${left.startUs + left.durationUs} µs but ${input.rightClipId} starts at ${right.startUs} µs (they must touch)`,
        };
      if (input.durationUs < minimumTransitionUs)
        return { problem: 'duration is shorter than one frame' };
      if (input.durationUs > Math.min(left.durationUs, right.durationUs) / 2)
        return { problem: 'duration must be at most half of each clip' };
      return { trackId: track.id };
    };
    const transitions = [
      ...((current as { transitions?: readonly TransitionV1[] }).transitions ?? []),
    ];
    for (const op of transitionOps) {
      const placed = transitionProblem(op);
      if (placed.problem !== undefined) {
        errors.push(`Transition ${op.id}: ${placed.problem}.`);
        continue;
      }
      const sameJunction = transitions.findIndex(
        (existing) =>
          existing.leftClipId === op.leftClipId && existing.rightClipId === op.rightClipId,
      );
      if (sameJunction >= 0) transitions.splice(sameJunction, 1);
      // Stored under the editor's registry id: transition-shaders `dissolve` is the crossfade.
      transitions.push({
        id: op.id,
        trackId: placed.trackId!,
        leftClipId: op.leftClipId,
        rightClipId: op.rightClipId,
        type: 'dissolve',
        durationUs: op.durationUs,
      });
      recordApplied(op.id);
    }
    // Edits such as trim, move or remove can break an existing junction.
    for (const existing of transitions) {
      if (transitionOps.some((op) => op.id === existing.id)) continue;
      const placed = transitionProblem(existing);
      if (placed.problem !== undefined)
        errors.push(`Existing transition ${existing.id} is no longer valid: ${placed.problem}.`);
    }
    if (transitions.length > 0 || transitionOps.length > 0)
      (current as { transitions?: readonly TransitionV1[] }).transitions = transitions;

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
        } else if (op.kind === 'update-text') {
          const clip = tracks
            .flatMap((track) => track.clips)
            .find((candidate) => candidate.id === op.objectId);
          const document =
            clip?.kind === 'caption'
              ? (current.captionDocuments as Record<string, CaptionDocumentV1>)[
                  String((clip as { captionDocumentId?: unknown }).captionDocumentId)
                ]
              : undefined;
          if (clip?.kind !== 'caption' || document === undefined) {
            errors.push(`Text clip ${op.objectId} not found.`);
            continue;
          }
          const editable = clip as unknown as {
            startUs: number;
            durationUs: number;
            style: Record<string, unknown>;
          };
          const style = { ...editable.style };
          if (op.x !== undefined) style.positionX = op.x;
          if (op.y !== undefined) style.positionY = op.y === 0 ? 0 : -op.y;
          if (op.size !== undefined) style.fontSize = op.size;
          if (op.color !== undefined) {
            style.textColor = op.color;
            style.highlightColor = op.color;
          }
          editable.style = style;
          if (op.startUs !== undefined) editable.startUs = op.startUs;
          if (op.text !== undefined || op.durationUs !== undefined) {
            const replaced = createTextClip({
              id: document.id,
              text: op.text ?? captionDocumentText(document),
              startUs: editable.startUs,
              durationUs: op.durationUs ?? editable.durationUs,
            }).document;
            (current.captionDocuments as Record<string, unknown>)[document.id] = {
              ...replaced,
              language: document.language,
              ...(op.text === undefined ? { direction: document.direction } : {}),
            };
            if (op.durationUs !== undefined) editable.durationUs = op.durationUs;
          }
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

function unknownChecklistClips(
  project: JoyProjectV1,
  checklist: readonly JoyPlanChecklistItem[],
): string[] {
  const root = project.compositions[project.rootCompositionId];
  const known = new Set(root?.tracks.flatMap((track) => track.clips.map((clip) => clip.id)) ?? []);
  const missing = new Set<string>();
  for (const item of checklist)
    if ('clipId' in item && !known.has(item.clipId)) missing.add(item.clipId);
  return [...missing];
}

/** False when captions-core would lay out none of the text (it drops lines above the safe area). */
function textFitsFrame(
  operation: {
    readonly text: string;
    readonly x?: number | undefined;
    readonly y?: number | undefined;
    readonly size?: number | undefined;
  },
  width: number,
  height: number,
): boolean {
  try {
    const { document, clip } = createTextClip({
      id: 'fit-check',
      text: operation.text,
      startUs: 0,
      durationUs: 1_000_000,
      ...(operation.x === undefined ? {} : { x: operation.x }),
      ...(operation.y === undefined ? {} : { y: operation.y }),
      ...(operation.size === undefined ? {} : { size: operation.size }),
    });
    return (
      layoutFfmpegCaption({
        clipId: clip.id,
        document,
        segment: document.segments[0]!,
        style: clip.style!,
        width,
        height,
      }).length > 0
    );
  } catch {
    return true; // other validation reports the problem
  }
}

/** set-property names models use for caption text fields, mapped to update-text fields. */
const TEXT_PROPERTY_ALIASES: Readonly<Record<string, 'text' | 'x' | 'y' | 'size' | 'color'>> = {
  text: 'text',
  content: 'text',
  x: 'x',
  y: 'y',
  size: 'size',
  fontsize: 'size',
  'font-size': 'size',
  scale: 'size',
  color: 'color',
  textcolor: 'color',
};

function captionDocumentText(document: CaptionDocumentV1): string {
  return document.segments
    .map(
      (segment) =>
        segment.textOverride ??
        segment.wordIds.map((id) => document.words[id]?.text ?? '').join(''),
    )
    .join(' ');
}

/** Caption text, size and placement in the units create-text/update-text take (F3). */
function describeTextClip(
  project: JoyProjectV1,
  clip: { readonly captionDocumentId: string; readonly style?: unknown },
): { text?: string; size: number; x: number; y: number; color?: string } {
  const document = project.captionDocuments?.[clip.captionDocumentId];
  const style = (clip.style ?? {}) as {
    positionX?: number;
    positionY?: number;
    fontSize?: number;
    textColor?: string;
  };
  const positionY = style.positionY ?? 0;
  return {
    ...(document ? { text: captionDocumentText(document) } : {}),
    size: style.fontSize ?? 1,
    x: style.positionX ?? 0,
    y: positionY === 0 ? 0 : -positionY,
    ...(style.textColor ? { color: style.textColor } : {}),
  };
}
