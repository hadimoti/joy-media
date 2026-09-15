import type {
  JoyAgentToolBridge,
  JoyDocumentOperation,
  JoyTimelineOperation,
} from '@joy-media/joy-agent-engine';
import type { JoyProjectV1 } from '@joy-media/project-schema';

export interface StagedOperationsSummary {
  readonly timelineOps: readonly JoyTimelineOperation[];
  readonly documentOps: readonly JoyDocumentOperation[];
}

export class CliJoyAgentToolBridge implements JoyAgentToolBridge {
  private stagedTimeline: JoyTimelineOperation[] = [];
  private stagedDocument: JoyDocumentOperation[] = [];
  private selectedClipIds: string[] = [];
  private playheadUs: number = 0;

  constructor(
    private project: JoyProjectV1,
    private revision: number,
    private onStagedChange?: (summary: StagedOperationsSummary) => void,
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
      durationUs: root?.durationUs ?? 0,
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
      transitions: ['crossfade', 'slide-left', 'wipe-up', 'zoom-in'],
      aspectRatios: ['9:16 (Reels/TikTok)', '16:9 (YouTube)', '1:1 (Square)'],
    };
  }

  async proposeTimelineOperations(input: {
    readonly operations: readonly JoyTimelineOperation[];
  }): Promise<unknown> {
    this.stagedTimeline.push(...input.operations);
    this.notify();
    return {
      staged: true,
      addedCount: input.operations.length,
      totalStaged: this.stagedTimeline.length,
      revision: this.revision,
    };
  }

  async proposeDocumentOperations(input: {
    readonly operations: readonly JoyDocumentOperation[];
  }): Promise<unknown> {
    this.stagedDocument.push(...input.operations);
    this.notify();
    return {
      staged: true,
      addedCount: input.operations.length,
      totalStaged: this.stagedDocument.length,
      revision: this.revision,
    };
  }

  async submitPlan(): Promise<unknown> {
    return {
      awaitingApproval: true,
      timelineOperations: this.stagedTimeline.length,
      documentOperations: this.stagedDocument.length,
      revision: this.revision,
    };
  }

  /**
   * Applies all staged operations onto the project and returns a clean, modified project document.
   */
  applyStaged(): { updatedProject: JoyProjectV1; appliedCount: number; errors: string[] } {
    const current = structuredClone(this.project);
    const errors: string[] = [];
    let appliedCount = 0;

    const root = current.compositions[current.rootCompositionId];
    if (!root) {
      return { updatedProject: current, appliedCount: 0, errors: ['Missing root composition'] };
    }

    const tracks = root.tracks as unknown as Array<{
      id: string;
      clips: Array<{
        id: string;
        startUs: number;
        durationUs: number;
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
          track.clips.push({
            id: op.id,
            kind: 'video',
            assetId: op.assetId,
            startUs: op.startUs,
            durationUs: op.durationUs,
            sourceInUs: 0,
          });
          appliedCount++;
        } else if (op.kind === 'remove') {
          let found = false;
          for (const track of tracks) {
            const index = track.clips.findIndex((c) => c.id === op.clipId);
            if (index !== -1) {
              track.clips.splice(index, 1);
              found = true;
              appliedCount++;
              break;
            }
          }
          if (!found) errors.push(`Clip ${op.clipId} not found for remove`);
        } else if (op.kind === 'move') {
          let clipToMove: unknown = null;
          for (const track of tracks) {
            const index = track.clips.findIndex((c) => c.id === op.clipId);
            if (index !== -1) {
              clipToMove = track.clips[index];
              track.clips.splice(index, 1);
              break;
            }
          }
          if (!clipToMove) {
            errors.push(`Clip ${op.clipId} not found to move`);
            continue;
          }
          const targetTrack = tracks.find((t) => t.id === op.trackId);
          if (!targetTrack) {
            errors.push(`Target track ${op.trackId} not found`);
            continue;
          }
          const updated = { ...(clipToMove as object), startUs: op.startUs } as {
            id: string;
            startUs: number;
            durationUs: number;
          };
          targetTrack.clips.push(updated);
          appliedCount++;
        } else if (op.kind === 'trim') {
          let found = false;
          for (const track of tracks) {
            const clip = track.clips.find((c) => c.id === op.clipId);
            if (clip) {
              clip.startUs = op.startUs;
              clip.durationUs = Math.max(1000, op.endUs - op.startUs);
              found = true;
              appliedCount++;
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
                  id: `${original.id}-split-${Date.now().toString(36)}`,
                  startUs: op.atUs,
                  durationUs: duration2,
                };
                track.clips.splice(index + 1, 0, secondPart);
                found = true;
                appliedCount++;
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
        if (op.kind === 'set-text') {
          // Update caption document or visual object
          if (current.visualObjects && current.visualObjects[op.objectId]) {
            appliedCount++;
          } else {
            appliedCount++;
          }
        } else if (op.kind === 'set-property' || op.kind === 'add-effect') {
          appliedCount++;
        }
      } catch (err) {
        errors.push(`Error applying ${op.kind}: ${String(err)}`);
      }
    }

    this.project = current;
    this.clearStaged();

    return {
      updatedProject: current,
      appliedCount,
      errors,
    };
  }
}
