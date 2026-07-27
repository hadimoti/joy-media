import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkflowGraphV2 } from '@joy-media/project-schema';
import type { GraphTransaction } from '@joy-media/commands';
import { PanelShell } from './PanelShell.js';
import { WorkflowGraphEditor } from './WorkflowGraphEditor.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import {
  formatTime,
  type DualLensEdge,
  type DualLensLane,
  type DualLensNode,
  type DualLensProjection,
} from './dual-lens-model.js';
import {
  graphNodeIdsForClips,
  timelineClipIdsForNode,
  type LensMode,
  type LensRevealRequest,
} from './dual-lens-reveal.js';

export interface DualLensPanelProps {
  /**
   * Built once by the editor and shared with the timeline, so both lenses read
   * the same projection instead of each deriving its own.
   */
  readonly projection: DualLensProjection;
  readonly playheadUs: number;
  readonly selectedClipIds: readonly string[];
  /** A `Reveal in Flow` issued from another panel. */
  readonly reveal?: LensRevealRequest;
  /** The authored workflow graph. Editing appears only when it is present. */
  readonly workflowGraph?: WorkflowGraphV2;
  readonly onSeek: (timeUs: number) => void;
  readonly onSelectClips: (clipIds: readonly string[]) => void;
  readonly onRevealOnTimeline: (clipIds: readonly string[]) => void;
  readonly onDispatchGraph?: (transaction: GraphTransaction) => void;
}

export function DualLensPanel({
  projection,
  playheadUs,
  selectedClipIds,
  reveal,
  workflowGraph,
  onSeek,
  onSelectClips,
  onRevealOnTimeline,
  onDispatchGraph,
}: DualLensPanelProps) {
  const [mode, setMode] = useState<LensMode>('time');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [focusedNodeId, setFocusedNodeId] = useState<string | undefined>(undefined);
  const advancedCount = projection.lanes.filter((lane) => lane.advanced).length;

  // Selection is highlighted, never stored: the editor owns it, and mirroring it
  // here would give the two lenses two answers to "what is selected".
  const selectedNodeIds = useMemo(
    () => new Set(graphNodeIdsForClips(projection, selectedClipIds)),
    [projection, selectedClipIds],
  );
  const selectedClipSet = useMemo(() => new Set(selectedClipIds), [selectedClipIds]);

  // Keyed on `token` alone: revealing the same clip twice must re-fire, and
  // re-running whenever the request object is merely re-created would fight the
  // user's own mode switches.
  const revealToken = reveal?.token;
  const appliedRevealRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (reveal === undefined || revealToken === appliedRevealRef.current) return;
    appliedRevealRef.current = revealToken;
    setMode(reveal.mode);
    setFocusedNodeId(reveal.nodeId);
  }, [reveal, revealToken]);

  const focusedClipIds =
    focusedNodeId === undefined ? [] : timelineClipIdsForNode(projection, focusedNodeId);

  const selectNode = (node: DualLensNode) => {
    setFocusedNodeId(node.id);
    // Per ADR-0022 selection is not navigation: revealing a node must not move
    // the playhead, or switching lenses would silently change the Program frame.
    if (node.clipIds.length > 0) onSelectClips(node.clipIds);
  };

  return (
    <PanelShell title="Dual Lens" iconUrl={panelTabIconUrl('flow')} className="dual-lens-panel">
      <div className="dual-lens-intro">
        <p lang="fa">در زمان ویرایش کنید؛ جریان را درک کنید.</p>
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
            selectedClipIds={selectedClipSet}
            onAdvancedToggle={() => setAdvancedOpen((open) => !open)}
            onSeek={onSeek}
            onSelectClips={onSelectClips}
          />
        )}
        {(mode === 'flow' || mode === 'split') && (
          <FlowProjection
            nodes={projection.nodes}
            edges={projection.edges}
            traceNodeIds={projection.traceNodeIds}
            traceEdgeIds={projection.traceEdgeIds}
            selectedNodeIds={selectedNodeIds}
            focusedNodeId={focusedNodeId}
            focusedClipIds={focusedClipIds}
            onSelectNode={selectNode}
            onSeek={onSeek}
            onRevealOnTimeline={onRevealOnTimeline}
          />
        )}
      </div>

      {workflowGraph !== undefined && onDispatchGraph !== undefined && (mode === 'flow' || mode === 'split') && (
        <div className="dual-lens-content">
          <WorkflowGraphEditor graph={workflowGraph} onDispatch={onDispatchGraph} />
        </div>
      )}
    </PanelShell>
  );
}

function TimeProjection({
  lanes,
  durationUs,
  playheadUs,
  advancedOpen,
  advancedCount,
  selectedClipIds,
  onAdvancedToggle,
  onSeek,
  onSelectClips,
}: {
  readonly lanes: readonly DualLensLane[];
  readonly durationUs: number;
  readonly playheadUs: number;
  readonly advancedOpen: boolean;
  readonly advancedCount: number;
  readonly selectedClipIds: ReadonlySet<string>;
  readonly onAdvancedToggle: () => void;
  readonly onSeek: (timeUs: number) => void;
  readonly onSelectClips: (clipIds: readonly string[]) => void;
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
          <div key={lane.id} className={lane.advanced ? 'dual-time-lane is-data' : 'dual-time-lane'}>
            <span className="dual-time-lane-label">{lane.label}</span>
            <div className="dual-time-lane-track">
              {lane.items.length === 0 ? (
                <span className="dual-time-empty" lang="fa">
                  داده‌ای وجود ندارد
                </span>
              ) : (
                lane.items.map((item) => {
                  const timed = item.startUs !== undefined && item.endUs !== undefined;
                  const left = timed ? (item.startUs! / safeDurationUs) * 100 : 0;
                  const width = timed
                    ? Math.max(1, ((item.endUs! - item.startUs!) / safeDurationUs) * 100)
                    : undefined;
                  const selected = item.clipId !== undefined && selectedClipIds.has(item.clipId);
                  const classes = ['dual-time-item'];
                  if (!timed) classes.push('is-unplaced');
                  if (selected) classes.push('is-selected');
                  return (
                    <button
                      key={item.id}
                      type="button"
                      className={classes.join(' ')}
                      aria-pressed={item.clipId === undefined ? undefined : selected}
                      style={
                        timed
                          ? {
                              left: `${Math.max(0, left)}%`,
                              width: `${Math.min(100 - Math.max(0, left), width ?? 1)}%`,
                            }
                          : undefined
                      }
                      title={
                        item.clipId === undefined
                          ? item.label
                          : `${item.label} — click to select, double-click to go to it`
                      }
                      onClick={() => {
                        // A placed clip selects; unbound data has nothing to
                        // select, so it stays a navigation affordance.
                        if (item.clipId !== undefined) onSelectClips([item.clipId]);
                        else if (item.startUs !== undefined) onSeek(item.startUs);
                      }}
                      onDoubleClick={() => {
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

const NODE_WIDTH = 150;
const NODE_HEIGHT = 56;
const COLUMN_PITCH = 230;
const ROW_PITCH = 78;

function FlowProjection({
  nodes,
  edges,
  traceNodeIds,
  traceEdgeIds,
  selectedNodeIds,
  focusedNodeId,
  focusedClipIds,
  onSelectNode,
  onSeek,
  onRevealOnTimeline,
}: {
  readonly nodes: readonly DualLensNode[];
  readonly edges: readonly DualLensEdge[];
  readonly traceNodeIds: ReadonlySet<string>;
  readonly traceEdgeIds: ReadonlySet<string>;
  readonly selectedNodeIds: ReadonlySet<string>;
  readonly focusedNodeId: string | undefined;
  readonly focusedClipIds: readonly string[];
  readonly onSelectNode: (node: DualLensNode) => void;
  readonly onSeek: (timeUs: number) => void;
  readonly onRevealOnTimeline: (clipIds: readonly string[]) => void;
}) {
  const graph = layoutGraph(nodes);
  const width = 900;
  const height = Math.max(250, graph.height);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ left: 0, top: 0, width: 1, height: 1 });

  const readViewport = () => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    setViewport({
      left: canvas.scrollLeft / Math.max(1, canvas.scrollWidth),
      top: canvas.scrollTop / Math.max(1, canvas.scrollHeight),
      width: canvas.clientWidth / Math.max(1, canvas.scrollWidth),
      height: canvas.clientHeight / Math.max(1, canvas.scrollHeight),
    });
  };
  useEffect(readViewport, [nodes]);

  // Scroll a revealed node into view. `positions` is read through a ref because
  // it is rebuilt on every projection change, and re-scrolling on each playhead
  // tick would fight the user panning the canvas.
  const positionsRef = useRef(graph.positions);
  positionsRef.current = graph.positions;
  useEffect(() => {
    if (focusedNodeId === undefined) return;
    const canvas = canvasRef.current;
    const position = positionsRef.current.get(focusedNodeId);
    if (canvas === null || position === undefined) return;
    canvas.scrollTo({
      left: Math.max(0, position.x - canvas.clientWidth / 2 + NODE_WIDTH / 2),
      top: Math.max(0, position.y - canvas.clientHeight / 2),
      behavior: 'smooth',
    });
  }, [focusedNodeId]);

  const activeCount = nodes.filter((node) => traceNodeIds.has(node.id)).length;

  return (
    <section className="dual-flow" aria-label="Flow View">
      <div className="dual-lens-section-heading">
        <div>
          <strong>Flow View</strong>
          <span>
            {activeCount}/{nodes.length} active · {edges.length} links
          </span>
        </div>
        <button
          type="button"
          className="dual-lens-disclosure"
          disabled={focusedClipIds.length === 0}
          onClick={() => onRevealOnTimeline(focusedClipIds)}
        >
          Reveal on Timeline
        </button>
      </div>
      <div className="dual-flow-canvas" ref={canvasRef} onScroll={readViewport}>
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
                className={traceEdgeIds.has(edge.id) ? 'dual-flow-edge is-traced' : 'dual-flow-edge'}
                d={`M ${from.x + NODE_WIDTH} ${from.y + 28} C ${from.x + 185} ${from.y + 28}, ${to.x - 35} ${to.y + 28}, ${to.x} ${to.y + 28}`}
                markerEnd="url(#dual-flow-arrow)"
              />
            );
          })}
          {nodes.map((node) => {
            const position = graph.positions.get(node.id);
            if (position === undefined) return null;
            const classes = ['dual-flow-node'];
            if (traceNodeIds.has(node.id)) classes.push('is-traced');
            if (selectedNodeIds.has(node.id)) classes.push('is-selected');
            if (node.id === focusedNodeId) classes.push('is-focused');
            return (
              <g
                key={node.id}
                className={classes.join(' ')}
                role="button"
                tabIndex={0}
                aria-pressed={selectedNodeIds.has(node.id)}
                aria-label={`${node.label}, ${node.detail}`}
                transform={`translate(${position.x} ${position.y})`}
                onClick={() => onSelectNode(node)}
                onDoubleClick={() => {
                  if (node.startUs !== undefined) onSeek(node.startUs);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onSelectNode(node);
                  }
                }}
              >
                <rect width={NODE_WIDTH} height={NODE_HEIGHT} rx="8" />
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
      <FlowMinimap
        nodes={nodes}
        positions={graph.positions}
        traceNodeIds={traceNodeIds}
        focusedNodeId={focusedNodeId}
        width={width}
        height={height}
        viewport={viewport}
      />
    </section>
  );
}

/**
 * Orientation for a graph taller than its canvas. It reflects scroll position
 * rather than driving it — a draggable viewport belongs with real pan/zoom,
 * which the read-only lens does not have yet.
 */
function FlowMinimap({
  nodes,
  positions,
  traceNodeIds,
  focusedNodeId,
  width,
  height,
  viewport,
}: {
  readonly nodes: readonly DualLensNode[];
  readonly positions: ReadonlyMap<string, { readonly x: number; readonly y: number }>;
  readonly traceNodeIds: ReadonlySet<string>;
  readonly focusedNodeId: string | undefined;
  readonly width: number;
  readonly height: number;
  readonly viewport: { readonly left: number; readonly top: number; readonly width: number; readonly height: number };
}) {
  const covered = viewport.width >= 1 && viewport.height >= 1;
  return (
    <div className="dual-flow-minimap" aria-hidden="true">
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="xMidYMid meet">
        {nodes.map((node) => {
          const position = positions.get(node.id);
          if (position === undefined) return null;
          const classes = ['dual-flow-minimap-node'];
          if (traceNodeIds.has(node.id)) classes.push('is-traced');
          if (node.id === focusedNodeId) classes.push('is-focused');
          return (
            <rect
              key={node.id}
              className={classes.join(' ')}
              x={position.x}
              y={position.y}
              width={NODE_WIDTH}
              height={NODE_HEIGHT}
              rx="6"
            />
          );
        })}
        {!covered && (
          <rect
            className="dual-flow-minimap-viewport"
            x={viewport.left * width}
            y={viewport.top * height}
            width={Math.min(1, viewport.width) * width}
            height={Math.min(1, viewport.height) * height}
          />
        )}
      </svg>
    </div>
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
    positions.set(node.id, { x: 30 + node.column * COLUMN_PITCH, y: 35 + row * ROW_PITCH });
    columnCounts.set(node.column, row + 1);
  }
  const rows = Math.max(1, ...columnCounts.values());
  return { positions, height: 70 + rows * ROW_PITCH };
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}
