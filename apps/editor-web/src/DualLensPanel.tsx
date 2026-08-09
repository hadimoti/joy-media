import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorkflowGraphV2 } from '@joy-media/project-schema';
import type { CommandTransaction, GraphTransaction } from '@joy-media/commands';
import {
  clampPixelsPerSecond,
  fitPixelsPerSecond,
  MIN_PIXELS_PER_SECOND,
  MAX_PIXELS_PER_SECOND,
  toggleTrackFlag,
  type TimelineTrackView,
  type TimelineViewport,
} from '@joy-media/timeline-engine';
import { PanelShell } from './PanelShell.js';
import { WorkflowGraphEditor } from './WorkflowGraphEditor.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import {
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
import { isTraversalKey, traverseGraph, type TraversalKey } from './graph-traversal.js';
import { TimelineCanvas, type TimelineCanvasTrack } from './TimelineCanvas.js';
import { timelineContentWidthPx } from './timeline-layout.js';
import {
  FitWidthIcon,
  MarkerIcon,
  PauseIcon,
  PlayIcon,
  SkipBackIcon,
  SkipForwardIcon,
  ZoomInIcon,
  ZoomOutIcon,
} from './icons.js';

export interface DualLensPanelProps {
  /**
   * Built once by the editor and shared with the timeline, so both lenses read
   * the same projection instead of each deriving its own.
   */
  readonly projection: DualLensProjection;
  readonly playheadUs: number;
  readonly playing: boolean;
  readonly selectedClipIds: readonly string[];
  /** A `Reveal in Flow` issued from another panel. */
  readonly reveal?: LensRevealRequest;
  /** The authored workflow graph. Editing appears only when it is present. */
  readonly workflowGraph?: WorkflowGraphV2;
  readonly onSeek: (timeUs: number) => void;
  readonly onTogglePlayback: () => void;
  readonly onSelectClips: (clipIds: readonly string[]) => void;
  readonly onRevealOnTimeline: (clipIds: readonly string[]) => void;
  readonly onDispatchGraph?: (transaction: GraphTransaction) => void;
  /** Shared with TimelinePanel so Time View clip widths match the main NLE. */
  readonly timelineViewport: TimelineViewport;
  readonly onTimelineViewportChange: (next: TimelineViewport) => void;
  /** Shared lock/visibility/solo flags with the main Timeline gutter. */
  readonly trackFlags: readonly TimelineTrackView[];
  readonly onTrackFlagsChange: (next: readonly TimelineTrackView[]) => void;
  readonly compositionId: string;
  readonly onDispatch: (transaction: CommandTransaction) => void;
  readonly onAddMarker?: (timeUs: number, label: string) => void;
  readonly onRemoveMarker?: (id: string) => void;
  readonly markers?: readonly {
    readonly id: string;
    readonly timeUs: number;
    readonly label: string;
  }[];
  /** Rendered by the editor so this panel stays free of agent wiring. */
  readonly specialistReview?: ReactNode;
}

export function DualLensPanel({
  projection,
  playheadUs,
  playing,
  selectedClipIds,
  reveal,
  workflowGraph,
  onSeek,
  onTogglePlayback,
  onSelectClips,
  onRevealOnTimeline,
  onDispatchGraph,
  timelineViewport,
  onTimelineViewportChange,
  trackFlags,
  onTrackFlagsChange,
  compositionId,
  onDispatch,
  onAddMarker,
  onRemoveMarker,
  markers = [],
  specialistReview,
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

  /** The span the selection covers, read off the projection's own clip nodes. */
  const selectionRange = useMemo(() => {
    const spans = projection.nodes.filter(
      (node) =>
        node.kind === 'clip' &&
        node.startUs !== undefined &&
        node.endUs !== undefined &&
        node.clipIds.some((clipId) => selectedClipSet.has(clipId)),
    );
    if (spans.length === 0) return undefined;
    const startUs = Math.min(...spans.map((node) => node.startUs ?? 0));
    const endUs = Math.max(...spans.map((node) => node.endUs ?? 0));
    return { startUs, durationUs: Math.max(1, endUs - startUs) };
  }, [projection, selectedClipSet]);

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
    <PanelShell
      title="Dual Lens"
      iconUrl={panelTabIconUrl('flow')}
      className="dual-lens-panel"
      hideHeader
    >
      <div className="dual-lens-trace" aria-live="polite">
        <span>Frame-to-Flow Trace</span>
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
        <strong>{projection.traceSummary}</strong>
      </div>

      <div className={mode === 'split' ? 'dual-lens-content is-split' : 'dual-lens-content'}>
        {(mode === 'time' || mode === 'split') && (
          <TimeProjection
            lanes={projection.lanes}
            durationUs={projection.durationUs}
            playheadUs={playheadUs}
            playing={playing}
            advancedOpen={advancedOpen}
            advancedCount={advancedCount}
            selectedClipIds={selectedClipSet}
            viewport={timelineViewport}
            onViewportChange={onTimelineViewportChange}
            onAdvancedToggle={() => setAdvancedOpen((open) => !open)}
            onSeek={onSeek}
            onTogglePlayback={onTogglePlayback}
            onSelectClips={onSelectClips}
            trackFlags={trackFlags}
            onTrackFlagsChange={onTrackFlagsChange}
            compositionId={compositionId}
            onDispatch={onDispatch}
            {...(onAddMarker === undefined ? {} : { onAddMarker })}
            {...(onRemoveMarker === undefined ? {} : { onRemoveMarker })}
            markers={markers}
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

      {workflowGraph !== undefined &&
        onDispatchGraph !== undefined &&
        (mode === 'flow' || mode === 'split') && (
          <div className="dual-lens-content">
            <WorkflowGraphEditor
              graph={workflowGraph}
              onDispatch={onDispatchGraph}
              selectedClipIds={selectedClipIds}
              {...(selectionRange === undefined ? {} : { selectionRange })}
            />
          </div>
        )}

      {specialistReview !== undefined && (mode === 'flow' || mode === 'split') && (
        <div className="dual-lens-content">{specialistReview}</div>
      )}
    </PanelShell>
  );
}

function lanesToCanvasTracks(
  lanes: readonly DualLensLane[],
  advancedOpen: boolean,
  trackFlags: readonly TimelineTrackView[],
  onToggleTrackFlag: (
    trackId: string,
    flag: 'locked' | 'visible' | 'solo',
    enabledSeed: boolean,
  ) => void,
): readonly TimelineCanvasTrack[] {
  return lanes
    .filter((lane) => !lane.advanced || advancedOpen)
    .map((lane) => {
      const sourceTrackId = lane.sourceTrackId;
      let controls: TimelineCanvasTrack['controls'];
      if (sourceTrackId !== undefined) {
        const enabled = lane.trackEnabled ?? true;
        const saved = trackFlags.find((item) => item.id === sourceTrackId);
        controls = {
          trackId: sourceTrackId,
          locked: saved?.locked ?? false,
          // Time View mirrors the project track, while lock/solo stay ephemeral.
          visible: enabled,
          solo: saved?.solo ?? false,
          onToggle: (flag) => onToggleTrackFlag(sourceTrackId, flag, enabled),
        };
      }
      return {
        id: lane.id,
        label: lane.label,
        advanced: lane.advanced,
        ...(lane.header === undefined ? {} : { header: lane.header }),
        ...(controls === undefined ? {} : { controls }),
        items: lane.items.map((item) => {
          const timed = item.startUs !== undefined && item.endUs !== undefined;
          return {
            id: item.id,
            label: item.label,
            startUs: item.startUs ?? 0,
            endUs: item.endUs ?? item.startUs ?? 0,
            ...(item.clipId === undefined ? {} : { clipId: item.clipId }),
            ...(item.icon === undefined ? {} : { icon: item.icon }),
            ...(timed ? {} : { unplaced: true as const }),
          };
        }),
      };
    });
}

function TimeProjection({
  lanes,
  durationUs,
  playheadUs,
  playing,
  advancedOpen,
  advancedCount,
  selectedClipIds,
  viewport,
  onViewportChange,
  onAdvancedToggle,
  onSeek,
  onTogglePlayback,
  onSelectClips,
  trackFlags,
  onTrackFlagsChange,
  compositionId,
  onDispatch,
  onAddMarker,
  onRemoveMarker,
  markers,
}: {
  readonly lanes: readonly DualLensLane[];
  readonly durationUs: number;
  readonly playheadUs: number;
  readonly playing: boolean;
  readonly advancedOpen: boolean;
  readonly advancedCount: number;
  readonly selectedClipIds: ReadonlySet<string>;
  readonly viewport: TimelineViewport;
  readonly onViewportChange: (next: TimelineViewport) => void;
  readonly onAdvancedToggle: () => void;
  readonly onSeek: (timeUs: number) => void;
  readonly onTogglePlayback: () => void;
  readonly onSelectClips: (clipIds: readonly string[]) => void;
  readonly trackFlags: readonly TimelineTrackView[];
  readonly onTrackFlagsChange: (next: readonly TimelineTrackView[]) => void;
  readonly compositionId: string;
  readonly onDispatch: (transaction: CommandTransaction) => void;
  readonly onAddMarker?: (timeUs: number, label: string) => void;
  readonly onRemoveMarker?: (id: string) => void;
  readonly markers: readonly {
    readonly id: string;
    readonly timeUs: number;
    readonly label: string;
  }[];
}) {
  const rootRef = useRef<HTMLElement | null>(null);
  const tracks = useMemo(() => {
    const onToggleTrackFlag = (
      trackId: string,
      flag: 'locked' | 'visible' | 'solo',
      enabledSeed: boolean,
    ) => {
      const current = {
        ...(trackFlags.find((item) => item.id === trackId) ?? {
          id: trackId,
          heightPx: 44,
          locked: false,
          solo: false,
        }),
        // The lane projection is derived from the schema command result.
        visible: enabledSeed,
      };
      if (flag === 'visible') {
        onDispatch({
          label: current.visible ? `Hide ${trackId}` : `Show ${trackId}`,
          commands: [
            {
              type: 'property.setTrackEnabled',
              payload: {
                compositionId,
                trackId,
                enabled: !current.visible,
              },
            },
          ],
        });
      }
      onTrackFlagsChange([
        ...trackFlags.filter((item) => item.id !== trackId),
        toggleTrackFlag(current, flag),
      ]);
    };
    return lanesToCanvasTracks(lanes, advancedOpen, trackFlags, onToggleTrackFlag);
  }, [lanes, advancedOpen, trackFlags, compositionId, onDispatch, onTrackFlagsChange]);

  const applyZoom = (nextPps: number) => {
    onViewportChange({ ...viewport, pixelsPerSecond: clampPixelsPerSecond(nextPps) });
  };

  const fitToWidth = () => {
    const scroll = rootRef.current?.querySelector('.timeline-tracks');
    const lane = rootRef.current?.querySelector('.timeline-lane');
    const scrollClientW = scroll instanceof HTMLElement ? scroll.clientWidth : 0;
    const laneW = lane instanceof HTMLElement ? lane.clientWidth : 0;
    const width = timelineContentWidthPx(scrollClientW) || laneW;
    if (width <= 0) return;
    onViewportChange({
      ...viewport,
      pixelsPerSecond: fitPixelsPerSecond(durationUs, width),
    });
  };

  return (
    <section className="dual-time" aria-label="Time View" ref={rootRef}>
      <div className="dual-lens-section-heading">
        <div className="dual-time-transport" role="toolbar" aria-label="Time View transport">
          <div className="timeline-toolbar-group">
            <button
              type="button"
              className="icon-button"
              onClick={onTogglePlayback}
              aria-label={playing ? 'Pause' : 'Play'}
              title={playing ? 'Pause (Space)' : 'Play (Space)'}
            >
              {playing ? <PauseIcon /> : <PlayIcon />}
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => onSeek(Math.max(0, playheadUs - 1_000_000))}
              aria-label="Back one second"
              title="Back 1s (←)"
            >
              <SkipBackIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              onClick={() => onSeek(Math.min(durationUs, playheadUs + 1_000_000))}
              aria-label="Forward one second"
              title="Forward 1s (→)"
            >
              <SkipForwardIcon />
            </button>
          </div>
          {onAddMarker !== undefined && (
            <>
              <span className="timeline-toolbar-sep" aria-hidden="true" />
              <div className="timeline-toolbar-group">
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Add marker at playhead"
                  title="Add marker at playhead"
                  data-guide="Add marker"
                  onClick={() => onAddMarker(playheadUs, `Marker ${markers.length + 1}`)}
                >
                  <MarkerIcon />
                </button>
              </div>
            </>
          )}
        </div>
        <div className="dual-time-heading-end">
          <button
            type="button"
            className="dual-lens-disclosure"
            aria-expanded={advancedOpen}
            onClick={onAdvancedToggle}
          >
            {advancedOpen ? 'Hide' : 'Show'} data lanes ({advancedCount})
          </button>
          <div
            className="timeline-toolbar-group timeline-toolbar-zoom"
            role="group"
            aria-label="Timeline zoom"
          >
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom out"
              title="Zoom out"
              onClick={() => applyZoom(viewport.pixelsPerSecond / 1.25)}
            >
              <ZoomOutIcon />
            </button>
            <input
              aria-label="Timeline zoom"
              className="timeline-zoom-slider"
              type="range"
              min={MIN_PIXELS_PER_SECOND}
              max={MAX_PIXELS_PER_SECOND}
              step={1}
              value={Math.round(viewport.pixelsPerSecond)}
              onChange={(event) => applyZoom(event.currentTarget.valueAsNumber)}
            />
            <button
              type="button"
              className="icon-button"
              aria-label="Zoom in"
              title="Zoom in"
              onClick={() => applyZoom(viewport.pixelsPerSecond * 1.25)}
            >
              <ZoomInIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Fit timeline to width"
              title="Fit to width"
              onClick={fitToWidth}
            >
              <FitWidthIcon />
            </button>
          </div>
        </div>
      </div>
      <TimelineCanvas
        className="dual-time-canvas"
        durationUs={durationUs}
        playheadUs={playheadUs}
        viewport={viewport}
        onViewportChange={onViewportChange}
        autoFit={false}
        tracks={tracks}
        selectedClipIds={selectedClipIds}
        onSeek={onSeek}
        onSelectClips={onSelectClips}
        markers={markers}
        {...(onRemoveMarker === undefined ? {} : { onRemoveMarker })}
      />
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

  // Arrow keys follow edges and columns, so the connections are reachable
  // without a mouse (§12.5). Focus only — Enter still does the selecting.
  const nodeElements = useRef(new Map<string, SVGGElement>());
  const moveFocus = (fromId: string, key: TraversalKey) => {
    const nextId = traverseGraph({ nodes, edges, positions: graph.positions }, fromId, key);
    if (nextId === undefined) return false;
    const element = nodeElements.current.get(nextId);
    if (element === undefined) return false;
    element.focus();
    const canvas = canvasRef.current;
    const position = graph.positions.get(nextId);
    if (canvas !== null && position !== undefined) {
      canvas.scrollTo({
        left: Math.max(0, position.x - canvas.clientWidth / 2 + NODE_WIDTH / 2),
        top: Math.max(0, position.y - canvas.clientHeight / 2),
        behavior: 'smooth',
      });
    }
    return true;
  };

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
      <p className="sr-only" id="dual-flow-keys">
        Use the left and right arrow keys to follow a connection, up and down to move within a
        column, Home and End for the first and last node, and Enter to select.
      </p>
      <div className="dual-flow-canvas" ref={canvasRef} onScroll={readViewport}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label="Media and data flow graph"
          aria-describedby="dual-flow-keys"
        >
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
                ref={(element) => {
                  if (element === null) nodeElements.current.delete(node.id);
                  else nodeElements.current.set(node.id, element);
                }}
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
                    return;
                  }
                  if (!isTraversalKey(event.key)) return;
                  // Only swallow the key when it actually moved somewhere, so a
                  // leaf still lets the canvas scroll rather than trapping it.
                  if (moveFocus(node.id, event.key)) event.preventDefault();
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
  readonly viewport: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
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
