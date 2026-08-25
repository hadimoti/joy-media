import { useEffect, useRef } from 'react';
import type { SpikeProject } from '@joy-media/project-schema';
import type { AgentPendingChange } from './agent-plan-visualizer.js';
import { JOY_COLORS } from './theme.js';

// Was a navy/cyan palette of its own — the last blue surface in the editor
// (DESIGN.md §1: no blue anywhere). Now the neutral ramp, with add/remove
// keeping the semantic green/red they are entitled to.
const COLORS = {
  background: JOY_COLORS.bgDeep,
  trackLane: JOY_COLORS.bgControl,
  clipDefault: JOY_COLORS.borderHover,
  clipAdd: JOY_COLORS.ok,
  clipRemove: JOY_COLORS.danger,
  clipMove: JOY_COLORS.borderHover,
  playhead: JOY_COLORS.accent,
  border: JOY_COLORS.border,
};

const TRACK_HEIGHT = 40;
const TRACK_GAP = 8;
const CLIP_HEIGHT = 28;
const CLIP_Y_OFFSET = 6;
const PLAYHEAD_WIDTH = 2;

export function AgentTimelineCanvas({
  project,
  playheadUs,
  highlightedClipIds,
  pendingChanges,
  width,
  height,
}: {
  readonly project: SpikeProject;
  readonly playheadUs: number;
  readonly highlightedClipIds: readonly string[];
  readonly pendingChanges: readonly AgentPendingChange[];
  readonly width: number;
  readonly height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const composition = project.compositions[project.rootCompositionId];
    if (composition === undefined) return;

    const durationUs = composition.durationUs;
    const tracks = composition.tracks;
    if (tracks.length === 0 || durationUs === 0) return;

    const pixelsPerUs = width / durationUs;
    const highlightedSet = new Set(highlightedClipIds);

    const changeMap = new Map<string, AgentPendingChange>();
    for (const change of pendingChanges) {
      if (change.kind === 'add') {
        changeMap.set(change.clipId, change);
      } else if (change.kind === 'remove') {
        changeMap.set(change.clipId, change);
      } else if (change.kind === 'move') {
        changeMap.set(change.clipId, change);
      } else if (change.kind === 'split') {
        changeMap.set(change.originalClipId, change);
        changeMap.set(change.newClipId, change);
      } else if (change.kind === 'join') {
        changeMap.set(change.firstClipId, change);
        changeMap.set(change.secondClipId, change);
      }
    }

    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, width, height);

    for (let trackIndex = 0; trackIndex < tracks.length; trackIndex++) {
      const track = tracks[trackIndex];
      if (track === undefined) continue;
      const trackY = trackIndex * (TRACK_HEIGHT + TRACK_GAP);

      ctx.fillStyle = COLORS.trackLane;
      ctx.fillRect(0, trackY, width, TRACK_HEIGHT);

      for (const clip of track.clips) {
        const clipX = clip.startUs * pixelsPerUs;
        const clipWidth = clip.durationUs * pixelsPerUs;
        const clipY = trackY + CLIP_Y_OFFSET;

        const change = changeMap.get(clip.id);
        const isHighlighted = highlightedSet.has(clip.id);

        let fillColor = COLORS.clipDefault;
        let strokeColor: string | undefined;
        let strokeWidth = 0;

        if (change !== undefined) {
          if (change.kind === 'add') {
            fillColor = COLORS.clipAdd;
            strokeColor = COLORS.clipAdd;
            strokeWidth = 2;
          } else if (change.kind === 'remove') {
            fillColor = COLORS.clipRemove;
            strokeColor = COLORS.clipRemove;
            strokeWidth = 2;
          } else if (change.kind === 'move') {
            fillColor = COLORS.clipMove;
            strokeColor = COLORS.clipMove;
            strokeWidth = 2;
          } else if (change.kind === 'split' || change.kind === 'join') {
            fillColor = COLORS.clipMove;
            strokeColor = COLORS.clipMove;
            strokeWidth = 2;
          }
        } else if (isHighlighted) {
          strokeColor = COLORS.playhead;
          strokeWidth = 2;
        }

        ctx.fillStyle = fillColor;
        ctx.fillRect(clipX, clipY, clipWidth, CLIP_HEIGHT);

        if (strokeColor !== undefined && strokeWidth > 0) {
          ctx.strokeStyle = strokeColor;
          ctx.lineWidth = strokeWidth;
          ctx.strokeRect(clipX, clipY, clipWidth, CLIP_HEIGHT);
        }
      }
    }

    const playheadX = playheadUs * pixelsPerUs;
    ctx.fillStyle = COLORS.playhead;
    ctx.fillRect(playheadX - PLAYHEAD_WIDTH / 2, 0, PLAYHEAD_WIDTH, height);
  }, [project, playheadUs, highlightedClipIds, pendingChanges, width, height]);

  return <canvas ref={canvasRef} width={width} height={height} className="agent-timeline-canvas" />;
}
