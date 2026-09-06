import { timeToPixel, type TimelineViewport } from '@joy-media/timeline-engine';
import { diffSummary, type AgentTimelineDiff } from './agent-timeline-preview.js';

export interface AgentTimelineTrackLayout {
  readonly trackId: string;
  readonly topPx: number;
  readonly heightPx: number;
}

/**
 * Whether this mounted overlay can put at least one staged change on screen.
 * Each diff either has visible ghost geometry or a visible bounded summary
 * fallback (for example, a proposed new track that does not exist in the
 * canonical layout yet). The caller still guards the root composition.
 */
export function hasRenderableAgentTimelineOverlay(
  diffs: readonly AgentTimelineDiff[],
  _tracks: readonly AgentTimelineTrackLayout[],
): boolean {
  return diffs.length > 0;
}

export function AgentTimelineOverlay({
  diffs,
  viewport,
  tracks,
}: {
  readonly diffs: readonly AgentTimelineDiff[];
  readonly viewport: TimelineViewport;
  readonly tracks: readonly AgentTimelineTrackLayout[];
}) {
  if (diffs.length === 0) return null;
  const trackById = new Map(tracks.map((track) => [track.trackId, track]));
  const clipRect = (trackId: string, startUs: number, durationUs: number) => {
    const track = trackById.get(trackId);
    if (track === undefined) return undefined;
    const left = timeToPixel(startUs, viewport);
    const right = timeToPixel(startUs + durationUs, viewport);
    return { left, top: track.topPx, width: Math.max(8, right - left), height: track.heightPx };
  };
  return (
    <div className="agent-timeline-overlay" aria-label="Agent staged timeline changes">
      {diffs.flatMap((diff, index) => {
        const summary = () => (
          <span
            className={`agent-timeline-diff agent-timeline-diff--${diff.kind}`}
            key={`${diff.kind}-${diff.kind === 'add' || diff.kind === 'remove' ? diff.clip.id : diff.clipId}-${index}`}
            data-clip-id={
              diff.kind === 'add' || diff.kind === 'remove' ? diff.clip.id : diff.clipId
            }
            role="note"
          >
            {diffSummary(diff)}
          </span>
        );
        const rects =
          diff.kind === 'move'
            ? [
                {
                  rect: clipRect(diff.from.trackId, diff.from.startUs, diff.from.durationUs),
                  ghost: false,
                },
                {
                  rect: clipRect(diff.to.trackId, diff.to.startUs, diff.to.durationUs),
                  ghost: true,
                },
              ]
            : diff.kind === 'trim'
              ? [
                  {
                    rect: clipRect(diff.from.trackId, diff.from.startUs, diff.from.durationUs),
                    ghost: false,
                  },
                  {
                    rect: clipRect(diff.to.trackId, diff.to.startUs, diff.to.durationUs),
                    ghost: true,
                  },
                ]
              : diff.kind === 'add'
                ? [
                    {
                      rect: clipRect(diff.clip.trackId, diff.clip.startUs, diff.clip.durationUs),
                      ghost: true,
                    },
                  ]
                : diff.kind === 'remove'
                  ? [
                      {
                        rect: clipRect(diff.clip.trackId, diff.clip.startUs, diff.clip.durationUs),
                        ghost: false,
                      },
                    ]
                  : [];
        if (rects.length === 0) return [summary()];
        const ghosts = rects.flatMap(({ rect, ghost }, rectIndex) =>
          rect === undefined
            ? []
            : [
                <span
                  className={`agent-timeline-ghost agent-timeline-ghost--${diff.kind}${ghost ? ' is-destination' : ' is-origin'}`}
                  key={`${diff.kind}-${index}-${rectIndex}`}
                  data-clip-id={
                    diff.kind === 'add' || diff.kind === 'remove' ? diff.clip.id : diff.clipId
                  }
                  aria-label={diffSummary(diff)}
                  role="note"
                  style={{
                    left: `${rect.left}px`,
                    top: `${rect.top + 4}px`,
                    width: `${rect.width}px`,
                    height: `${Math.max(8, rect.height - 8)}px`,
                  }}
                >
                  <span className="agent-timeline-ghost-label">{diffSummary(diff)}</span>
                </span>,
              ],
        );
        return ghosts.length > 0 ? ghosts : [summary()];
      })}
    </div>
  );
}
