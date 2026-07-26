import { useMemo, useState } from 'react';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { HistoryEntry } from './editor-session.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import {
  buildDualLensProjection,
  formatTime,
  type DualLensLane,
  type DualLensNode,
} from './dual-lens-model.js';

type LensMode = 'time' | 'flow' | 'split';

export interface DualLensPanelProps {
  readonly timeline: SpikeProject;
  readonly creative: JoyProjectV1;
  readonly playheadUs: number;
  readonly historyEntries: readonly HistoryEntry[];
  readonly onSeek: (timeUs: number) => void;
}

export function DualLensPanel({
  timeline,
  creative,
  playheadUs,
  historyEntries,
  onSeek,
}: DualLensPanelProps) {
  const [mode, setMode] = useState<LensMode>('time');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const projection = useMemo(
    () => buildDualLensProjection(timeline, creative, playheadUs, historyEntries),
    [creative, historyEntries, playheadUs, timeline],
  );
  const advancedCount = projection.lanes.filter((lane) => lane.advanced).length;

  return (
    <PanelShell title="Dual Lens" iconUrl={panelTabIconUrl('flow')} className="dual-lens-panel">
      <div className="dual-lens-intro">
        <p>Edit in time. Understand in flow.</p>
        <div className="dual-lens-modes" role="tablist" aria-label="Dual Lens mode">
          {(['time', 'flow', 'split'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={mode === candidate}
              onClick={() => setMode(candidate)}
            >
              {candidate[0]?.toUpperCase()}
              {candidate.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="dual-lens-trace" aria-live="polite">
        <span>Frame-to-Flow Trace</span>
        <strong>{projection.traceSummary}</strong>
      </div>

      <div className={mode === 'split' ? 'dual-lens-content is-split' : 'dual-lens-content'}>
        {(mode === 'time' || mode === 'split') && (
          <TimeProjection
            lanes={projection.lanes}
            durationUs={projection.durationUs}
            playheadUs={playheadUs}
            advancedOpen={advancedOpen}
            advancedCount={advancedCount}
            onAdvancedToggle={() => setAdvancedOpen((open) => !open)}
            onSeek={onSeek}
          />
        )}
        {(mode === 'flow' || mode === 'split') && (
          <FlowProjection
            nodes={projection.nodes}
            edges={projection.edges}
            traceNodeIds={projection.traceNodeIds}
            traceEdgeIds={projection.traceEdgeIds}
            onSeek={onSeek}
          />
        )}
      </div>
    </PanelShell>
  );
}

function TimeProjection({
  lanes,
  durationUs,
  playheadUs,
  advancedOpen,
  advancedCount,
  onAdvancedToggle,
  onSeek,
}: {
  readonly lanes: readonly DualLensLane[];
  readonly durationUs: number;
  readonly playheadUs: number;
  readonly advancedOpen: boolean;
  readonly advancedCount: number;
  readonly onAdvancedToggle: () => void;
  readonly onSeek: (timeUs: number) => void;
}) {
  const shownLanes = lanes.filter((lane) => !lane.advanced || advancedOpen);
  const safeDurationUs = Math.max(1, durationUs);
  const playheadPercent = Math.min(100, Math.max(0, (playheadUs / safeDurationUs) * 100));

  return (
    <section className="dual-time" aria-label="Time View">
      <div className="dual-lens-section-heading">
        <div>
          <strong>Time View</strong>
          <span>{formatTime(playheadUs)}</span>
        </div>
        <button
          type="button"
          className="dual-lens-disclosure"
          aria-expanded={advancedOpen}
          onClick={onAdvancedToggle}
        >
          {advancedOpen ? 'Hide' : 'Show'} data lanes ({advancedCount})
        </button>
      </div>
      <input
        className="dual-time-scrubber"
        type="range"
        min={0}
        max={safeDurationUs}
        step={1_000}
        value={Math.min(safeDurationUs, Math.max(0, playheadUs))}
        aria-label="Dual Lens playhead"
        onChange={(event) => onSeek(Number(event.currentTarget.value))}
      />
      <div className="dual-time-ruler" aria-hidden="true">
        <span>0:00</span>
        <span>{formatTime(safeDurationUs / 2)}</span>
        <span>{formatTime(safeDurationUs)}</span>
      </div>
      <div className="dual-time-lanes">
        <div
          className="dual-time-playhead"
          style={{ left: `calc(${playheadPercent}% + ${110 - playheadPercent * 1.1}px)` }}
        />
        {shownLanes.map((lane) => (
          <div
            key={lane.id}
            className={lane.advanced ? 'dual-time-lane is-data' : 'dual-time-lane'}
          >
            <span className="dual-time-lane-label">{lane.label}</span>
            <div className="dual-time-lane-track">
              {lane.items.length === 0 ? (
                <span className="dual-time-empty">No data</span>
              ) : (
                lane.items.map((item) => {
                  const timed = item.startUs !== undefined && item.endUs !== undefined;
                  const left = timed ? (item.startUs! / safeDurationUs) * 100 : 0;
                  const width = timed
                    ? Math.max(1, ((item.endUs! - item.startUs!) / safeDurationUs) * 100)
                    : undefined;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={timed ? 'dual-time-item' : 'dual-time-item is-unplaced'}
                      style={
                        timed
                          ? {
                              left: `${Math.max(0, left)}%`,
                              width: `${Math.min(100 - Math.max(0, left), width ?? 1)}%`,
                            }
                          : undefined
                      }
                      title={item.label}
                      onClick={() => {
                        if (item.startUs !== undefined) onSeek(item.startUs);
                      }}
                    >
                      {item.label}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function FlowProjection({
  nodes,
  edges,
  traceNodeIds,
  traceEdgeIds,
  onSeek,
}: {
  readonly nodes: readonly DualLensNode[];
  readonly edges: readonly { readonly id: string; readonly from: string; readonly to: string }[];
  readonly traceNodeIds: ReadonlySet<string>;
  readonly traceEdgeIds: ReadonlySet<string>;
  readonly onSeek: (timeUs: number) => void;
}) {
  const graph = layoutGraph(nodes);
  const width = 900;
  const height = Math.max(250, graph.height);

  return (
    <section className="dual-flow" aria-label="Flow View">
      <div className="dual-lens-section-heading">
        <div>
          <strong>Flow View</strong>
          <span>Creative Document projection</span>
        </div>
        <span className="dual-flow-legend">Bright = current frame</span>
      </div>
      <div className="dual-flow-canvas">
        <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Media and data flow graph">
          <defs>
            <marker
              id="dual-flow-arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="5"
              markerHeight="5"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" />
            </marker>
          </defs>
          {edges.map((edge) => {
            const from = graph.positions.get(edge.from);
            const to = graph.positions.get(edge.to);
            if (from === undefined || to === undefined) return null;
            return (
              <path
                key={edge.id}
                className={
                  traceEdgeIds.has(edge.id) ? 'dual-flow-edge is-traced' : 'dual-flow-edge'
                }
                d={`M ${from.x + 150} ${from.y + 28} C ${from.x + 185} ${from.y + 28}, ${to.x - 35} ${to.y + 28}, ${to.x} ${to.y + 28}`}
                markerEnd="url(#dual-flow-arrow)"
              />
            );
          })}
          {nodes.map((node) => {
            const position = graph.positions.get(node.id);
            if (position === undefined) return null;
            const traced = traceNodeIds.has(node.id);
            return (
              <g
                key={node.id}
                className={traced ? 'dual-flow-node is-traced' : 'dual-flow-node'}
                role="button"
                tabIndex={0}
                aria-label={`${node.label}, ${node.detail}`}
                transform={`translate(${position.x} ${position.y})`}
                onClick={() => {
                  if (node.startUs !== undefined) onSeek(node.startUs);
                }}
                onKeyDown={(event) => {
                  if (node.startUs !== undefined && (event.key === 'Enter' || event.key === ' ')) {
                    event.preventDefault();
                    onSeek(node.startUs);
                  }
                }}
              >
                <rect width="150" height="56" rx="8" />
                <text className="dual-flow-kind" x="10" y="16">
                  {node.kind.toUpperCase()}
                </text>
                <text className="dual-flow-label" x="10" y="34">
                  {truncate(node.label, 20)}
                </text>
                <text className="dual-flow-detail" x="10" y="48">
                  {truncate(node.detail, 25)}
                </text>
                <title>{`${node.label} — ${node.detail}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}

function layoutGraph(nodes: readonly DualLensNode[]): {
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  readonly height: number;
} {
  const positions = new Map<string, { x: number; y: number }>();
  const columnCounts = new Map<number, number>();
  for (const node of nodes) {
    const row = columnCounts.get(node.column) ?? 0;
    positions.set(node.id, { x: 30 + node.column * 230, y: 35 + row * 78 });
    columnCounts.set(node.column, row + 1);
  }
  const rows = Math.max(1, ...columnCounts.values());
  return { positions, height: 70 + rows * 78 };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
