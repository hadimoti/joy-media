import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { EditorPanelContext, type EditorPanelContextValue } from '../editor-panel-context.js';
import { withVideoFrameNode } from '@joy-media/playback-engine';
import type { EditorOverlayIR, RenderFrameIR } from '@joy-media/render-ir';
import {
  textGradientAnchors,
  textDocumentToString,
  type TextGradientPointV1,
  type VisualObjectV1,
} from '@joy-media/project-schema';
import { MonitorGradientAnchors } from './MonitorGradientAnchors.js';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import {
  buildRenderFrameIR,
  isBoundObjectActive,
  type ResolvedObject,
} from '@joy-media/visual-object-renderer';
import { effectRegistry } from '@joy-media/visual-effects';
import {
  createBrowserPixiRenderer,
  type BrowserPixiRenderer,
} from '@joy-media/renderer-pixi/browser';
import { HtmlSceneSurfaceCache } from '../html-scene-surfaces.js';
import { withCaptionBurnInNodes } from '../caption-burn-in.js';
import { canvasFormatPresetId } from '../canvas-format.js';
import { setMonitorPixelReader, setMonitorUngradedPixelReader } from '../monitor-readback.js';
import { readImageMatteMap, resolveObjectIdForSelection } from '../sticker-bindings.js';
import { isSingleVideoClipSelected } from '../effects-apply-state.js';
import {
  loadEditorUiPreferences,
  saveEditorUiPreferences,
  DEFAULT_EDITOR_UI_PREFERENCES,
} from '../ui-preferences.js';
import {
  chooseAutoPreviewQuality,
  INITIAL_AUTO_PREVIEW_QUALITY_STATE,
  previewQualityResolution,
  resolvePreviewQuality,
  type FixedPreviewQuality,
  type PreviewQuality,
} from '../preview-quality.js';
import { timelineEffectiveDurationUs } from '../timeline-layout.js';
import { hiddenClipIds } from '../timeline-hidden-clips.js';
import { COVER_MAX_SIDE, saveProjectCard } from '../project-card-save.js';
import { AgentPreviewBadge } from '../AgentPreviewBadge.js';
import { useAgentPreviewSnapshot } from '../agent-preview-store.js';
import {
  recordPreviewResourceCreated,
  recordPreviewResourceReleased,
} from '../preview-resource-audit.js';
import {
  activeTransitionAt,
  applyClipGradesToTransitionBitmaps,
  findVideoClipById,
  imageSizesFromCache,
  renderFrameOptions,
  transitionClipTimes,
} from '../preview-frame-helpers.js';
import {
  useColorGradePreview,
  withColorGradePreview,
  withColorGradePreviewNode,
} from '../color-grade-preview.js';
import {
  useColorGradeBypass,
  withoutColorGrades,
  withoutVideoNodeGrade,
} from '../color-grade-bypass.js';
import { MonitorEyedropper } from './MonitorEyedropper.js';
import { appAgentPreviewStore, stickerImageCache } from '../editor-runtime-singletons.js';
import { usePopup, type PopupControl } from '../popup-manager.js';
import { POPUP_IDS } from '../popup-ids.js';
import { MonitorTransport } from './MonitorTransport.js';
import { TimelineContextMenu, type TimelineContextMenuState } from '../TimelineContextMenu.js';
import { MonitorOverlays } from './MonitorOverlays.js';
import { MediaOfflineNote } from './MediaOfflineNote.js';
import { useMonitorViewOptions } from './MonitorViewMenu.js';
import { createMonitorPerformanceTracker, recordMonitorFrame } from './monitor-performance.js';
import { monitorZoomLabel } from './monitor-view.js';
import {
  MONITOR_KEY_SCOPE,
  MonitorViewport,
  monitorFrameRect,
  useDevicePixelRatio,
  useMonitorView,
  useSpaceHold,
  type MonitorViewportSelection,
} from './MonitorViewport.js';
import { nextElementClipId } from './monitor-keyboard.js';
import { clipIdToObjectId } from './monitor-ids.js';
import { scopedKeyTable } from '../keyboard-shortcuts.js';
import { MonitorSelectionOverlay } from './MonitorSelectionOverlay.js';
import { MonitorTransformBox } from './MonitorTransformBox.js';
import { MonitorSnapOverlay, type MonitorSnapFeedback } from './MonitorSnapOverlay.js';
import { collectSnapTargets, snapMove } from './snap-targets.js';
import { boxContainsPoint } from './monitor-hit-test.js';
import { monitorHoverElementAt } from './monitor-hover.js';
import { buildMonitorGroupOverlay, buildMonitorOverlays } from './monitor-overlay-model.js';
import type { MonitorTransformHost, TransformPatches } from './monitor-transform-drag.js';
import {
  monitorTransformPreview,
  useMonitorTransformPreview,
  withPreviewVideoNode,
  withTransformPatches,
} from './monitor-transform-preview.js';
import { buildTransformTargets, type MonitorTransformTarget } from './monitor-transform-targets.js';
import { useMonitorTransform } from './useMonitorTransform.js';
import {
  EMPTY_MONITOR_OVERLAY,
  applyMonitorSelection,
  buildMonitorElements,
  monitorClickAction,
  monitorHitClipIds,
  monitorMarqueeAction,
  monitorMarqueeClipIds,
  monitorSelectionOverlay,
  monitorCropAvailable,
  currentMissingAssetIds,
  monitorCropOverlayNodeId,
  sameMonitorOverlay,
  buildMonitorContextMenuItems,
  type MonitorContextAction,
  type MonitorElement,
} from './monitor-selection.js';
import { buildMediaFitTransaction, mediaFitSelection } from '../media-fit-transform.js';
import { monitorContextTransformState } from './monitor-context-transform.js';
import type { CropInsets } from '../media-fit-transform.js';
import { textObjectWithDraftText } from '../TextPanel.js';
import { MonitorCropBox } from './MonitorCropBox.js';
import { MonitorTextInlineEditor } from './MonitorTextInlineEditor.js';
import { monitorPixelScale } from './monitor-pixel-scale.js';
import { createProjectColorLutResolver } from '../project-color-luts.js';
import {
  DroppedImportProgress,
  type DroppedImportProgressState,
} from '../DroppedImportProgress.js';
import {
  registerEditorPointerDndRoot,
  type EditorPointerDragPayload,
  type EditorPointerDropTarget,
  type EditorPointerMediaAsset,
} from '../editor-pointer-dnd.js';

/**
 * The Program Monitor panel: the preview canvas, its renderer lifecycle and the
 * Monitor preview and direct-manipulation surface, moved out of App.tsx (T-M02a).
 */

/** How long the project stays unchanged before its library card is refreshed. */
const PROJECT_CARD_SAVE_DELAY_MS = 3000;

export function MonitorPanel({
  agentPreviewSurfaceVisible = true,
  onFilesDrop,
  onAssetDrop,
  droppedImportProgress,
  onCancelDroppedImport,
  formatMenu,
  mediaOfflineName,
  missingAssetIds,
  onRelinkMissing,
}: {
  readonly agentPreviewSurfaceVisible?: boolean;
  readonly onFilesDrop?: (files: readonly File[]) => void;
  readonly onAssetDrop?: (asset: EditorPointerMediaAsset) => void;
  readonly droppedImportProgress?: DroppedImportProgressState;
  readonly onCancelDroppedImport?: () => void;
  /** The App-owned Format popup; the monitor bar's read-out opens the same popover. */
  readonly formatMenu: PopupControl;
  /** Set while the video clip at the playhead has a missing file: its name, for the "Media offline" frame (T-R03). */
  readonly mediaOfflineName?: string;
  readonly missingAssetIds?: ReadonlySet<string>;
  readonly onRelinkMissing?: () => void;
}) {
  const context = useContext(EditorPanelContext);
  if (context === undefined)
    return (
      <article className="joy-panel-root" aria-label="Monitor">
        <p className="empty-hint">Loading monitor…</p>
      </article>
    );
  return (
    <MonitorPanelContent
      context={context}
      agentPreviewSurfaceVisible={agentPreviewSurfaceVisible}
      onFilesDrop={onFilesDrop}
      onAssetDrop={onAssetDrop}
      droppedImportProgress={droppedImportProgress}
      onCancelDroppedImport={onCancelDroppedImport}
      formatMenu={formatMenu}
      mediaOfflineName={mediaOfflineName}
      missingAssetIds={currentMissingAssetIds(context.missingAssetIds, missingAssetIds)}
      onRelinkMissing={onRelinkMissing}
    />
  );
}

function MonitorPanelContent({
  context,
  agentPreviewSurfaceVisible,
  onFilesDrop,
  onAssetDrop,
  droppedImportProgress,
  onCancelDroppedImport,
  formatMenu,
  mediaOfflineName,
  missingAssetIds,
  onRelinkMissing,
}: {
  readonly context: EditorPanelContextValue;
  readonly agentPreviewSurfaceVisible: boolean;
  readonly onFilesDrop?: ((files: readonly File[]) => void) | undefined;
  readonly onAssetDrop?: ((asset: EditorPointerMediaAsset) => void) | undefined;
  readonly droppedImportProgress?: DroppedImportProgressState | undefined;
  readonly mediaOfflineName?: string | undefined;
  readonly missingAssetIds?: ReadonlySet<string> | undefined;
  readonly onRelinkMissing?: (() => void) | undefined;
  readonly onCancelDroppedImport?: (() => void) | undefined;
  readonly formatMenu: PopupControl;
}) {
  const {
    state,
    previewVideoFrame,
    clipFrameCache,
    clipFrameTick,
    visualProject,
    timelineProject,
    loadProjectAssetBlob,
    stickerTick,
    togglePlayback,
    seek,
    dispatchProject,
    session,
    storage,
    bumpProjectRevision,
    showToast,
    selectClips,
    toggleSelection,
    clearSelection,
  } = context;
  const agentPreviewState = useAgentPreviewSnapshot();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [monitorDragOver, setMonitorDragOver] = useState(false);
  const [contextMenu, setContextMenu] = useState<TimelineContextMenuState | undefined>();
  const [editingTextId, setEditingTextId] = useState<string | undefined>();
  const [cropMode, setCropMode] = useState(false);
  const [cropObjectId, setCropObjectId] = useState<string | undefined>();
  const rendererRef = useRef<BrowserPixiRenderer | null>(null);
  const rendererPromiseRef = useRef<Promise<BrowserPixiRenderer> | null>(null);
  const rendererDisposeTimerRef = useRef<number | undefined>(undefined);
  const paintRef = useRef<() => void>(() => {});
  const colorLutResolverRef = useRef<ReturnType<typeof createProjectColorLutResolver> | undefined>(
    undefined,
  );
  const applyViewRef = useRef<(renderer: BrowserPixiRenderer) => void>(() => {});
  const currentFrameRef = useRef<RenderFrameIR | undefined>(undefined);
  const sceneCacheRef = useRef(new HtmlSceneSurfaceCache());
  const [sceneTick, setSceneTick] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [fullscreen, setFullscreen] = useState(false);
  const [agentPreviewBefore, setAgentPreviewBefore] = useState(false);
  const [documentPreviewAcknowledgement, setDocumentPreviewAcknowledgement] = useState<
    string | undefined
  >(undefined);
  const documentPreviewAcknowledgementRef = useRef<string | undefined>(undefined);
  const stagedDocumentPreviewKey =
    agentPreviewState.document === undefined
      ? undefined
      : `${agentPreviewState.document.runId}:${agentPreviewState.document.bundleVersion}`;
  useEffect(() => {
    // Comparison is deliberately deferred until each immutable staged document
    // has visibly painted once. Without this reset, a prior bundle's Before
    // state could suppress the new bundle forever.
    setAgentPreviewBefore(false);
    documentPreviewAcknowledgementRef.current = undefined;
    setDocumentPreviewAcknowledgement(undefined);
  }, [stagedDocumentPreviewKey]);
  const documentPreviewInitialPaintPending =
    stagedDocumentPreviewKey !== undefined &&
    documentPreviewAcknowledgement !== stagedDocumentPreviewKey;
  const previewVisualProject =
    !agentPreviewBefore &&
    agentPreviewState.document !== undefined &&
    agentPreviewState.document.baseRevision === session.projectRevisionId
      ? agentPreviewState.document.preview
      : visualProject;
  const colorLutResolver = useMemo(
    () =>
      createProjectColorLutResolver({
        project: previewVisualProject,
        loadProjectAssetBlob,
        onReady: () => paintRef.current(),
        onWarning: (message) => showToast(message, 'info'),
      }),
    [loadProjectAssetBlob, previewVisualProject, showToast],
  );
  colorLutResolverRef.current = colorLutResolver;
  const renderedAgentDocumentPreview =
    !agentPreviewBefore &&
    agentPreviewState.document !== undefined &&
    agentPreviewState.document.baseRevision === session.projectRevisionId &&
    agentPreviewState.document.preview === previewVisualProject
      ? agentPreviewState.document
      : undefined;
  // The zoom drawer is one popup (OB-18): outside click, Escape and a second popup close it.
  const zoomDrawer = usePopup(POPUP_IDS.monitorZoom);
  // The View menu (T-M08) options are saved per user.
  const [viewOptions, setViewOptions] = useMonitorViewOptions(storage);
  const panelRef = useRef<HTMLElement | null>(null);
  const initialPreviewPreference = useRef(
    loadEditorUiPreferences(storage).monitorPreview ??
      DEFAULT_EDITOR_UI_PREFERENCES.monitorPreview!,
  );
  const [previewQuality, setPreviewQuality] = useState<PreviewQuality>(
    initialPreviewPreference.current.quality,
  );
  const [autoPreviewQuality, setAutoPreviewQuality] = useState<FixedPreviewQuality>('full');
  const autoPreviewQualityStateRef = useRef(INITIAL_AUTO_PREVIEW_QUALITY_STATE);
  const activePreviewQuality = resolvePreviewQuality(
    previewQuality,
    autoPreviewQuality,
    !state.playing,
  );
  // The renderer effect below is keyed on the chosen mode only; Auto changes the
  // active quality while it runs, so the effect reads it through a ref instead of
  // rebuilding the Pixi renderer on every Auto step.
  const activePreviewQualityRef = useRef(activePreviewQuality);
  activePreviewQualityRef.current = activePreviewQuality;
  const [performanceStats, setPerformanceStats] = useState({ fps: 0, droppedFrames: 0 });
  const performanceTrackerRef = useRef(createMonitorPerformanceTracker());
  useEffect(() => {
    performanceTrackerRef.current = createMonitorPerformanceTracker(performance.now());
    if (state.playing) setPerformanceStats({ fps: 0, droppedFrames: 0 });
  }, [state.playing]);
  const composition = previewVisualProject.compositions[previewVisualProject.rootCompositionId];
  const previewFrameRate = composition?.frameRate ?? { num: 30, den: 1 };
  useEffect(() => {
    autoPreviewQualityStateRef.current = INITIAL_AUTO_PREVIEW_QUALITY_STATE;
  }, [previewQuality, previewFrameRate.num, previewFrameRate.den, state.playing]);
  const width = composition?.width ?? 1080;
  const height = composition?.height ?? 1920;
  const frameSize = useMemo(() => ({ width, height }), [width, height]);
  const monitorView = useMonitorView(frameSize, panelRef);
  const readNavigatorThumbnail = useCallback(
    (maxWidth: number, maxHeight: number) => rendererRef.current?.readPixels(maxWidth, maxHeight),
    [],
  );
  // Project card (T-D07): keep the library card's format, length and cover up to date.
  // A short wait after the last change, and once more when the editor closes.
  // The renderer exposes only its currently displayed frame; do not seek or disturb the
  // playhead for a card capture. Save a first-frame cover only when the monitor is already at 0.
  // A missing frame keeps the old cover or the placeholder (see saveProjectCard).
  const cardSnapshotRef = useRef<() => void>(() => undefined);
  cardSnapshotRef.current = () => {
    const rootId = timelineProject.rootCompositionId;
    const timelineComposition = timelineProject.compositions[rootId];
    const visualComposition = visualProject.compositions[visualProject.rootCompositionId];
    if (timelineComposition === undefined || visualComposition === undefined) return;
    saveProjectCard(storage, {
      projectId: visualProject.id,
      canvas: { width: visualComposition.width, height: visualComposition.height },
      durationUs: timelineEffectiveDurationUs(timelineComposition),
      readFrame: () =>
        state.playheadUs === 0
          ? rendererRef.current?.readPixels(COVER_MAX_SIDE, COVER_MAX_SIDE)
          : undefined,
    });
  };
  useEffect(() => {
    const timer = window.setTimeout(() => cardSnapshotRef.current(), PROJECT_CARD_SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [visualProject, timelineProject]);
  useEffect(() => {
    const flush = cardSnapshotRef;
    return () => flush.current();
  }, []);
  const devicePixelRatio = useDevicePixelRatio();
  // Selection (T-M04): the Monitor keeps none of its own. It reads the shared
  // `state.selectedIds` and writes through the shared setters; the elements
  // come from the frame that was drawn last and the renderer's nodeBounds.
  const [selectionOutline, setSelectionOutline] = useState<{
    readonly overlay: EditorOverlayIR;
    readonly clipByNode: ReadonlyMap<string, string>;
  }>({ overlay: EMPTY_MONITOR_OVERLAY, clipByNode: new Map() });
  const [snapFeedback, setSnapFeedback] = useState<MonitorSnapFeedback | null>(null);
  const readMonitorElementsRef = useRef<() => readonly MonitorElement[]>(() => []);
  const monitorElementsRef = useRef<readonly MonitorElement[]>([]);
  readMonitorElementsRef.current = () => {
    const renderer = rendererRef.current;
    const frame = currentFrameRef.current;
    if (renderer === null || frame === undefined) return [];
    return buildMonitorElements({
      frame,
      nodeBounds: (id) => renderer.nodeBounds(id),
      project: previewVisualProject,
      timeline: timelineProject,
    });
  };
  const selectedIdsRef = useRef(state.selectedIds);
  selectedIdsRef.current = state.selectedIds;
  const refreshSelectionOutlineRef = useRef<() => void>(() => {});
  refreshSelectionOutlineRef.current = () => {
    const elements = readMonitorElementsRef.current();
    monitorElementsRef.current = elements;
    const targets = readTransformTargetsRef.current();
    setTransformTargets((current) =>
      JSON.stringify(current) === JSON.stringify(targets) ? current : targets,
    );
    const overlay = monitorSelectionOverlay(elements, state.selectedIds);
    setSelectionOutline((current) =>
      sameMonitorOverlay(current.overlay, overlay)
        ? current
        : {
            overlay,
            clipByNode: new Map(elements.map((element) => [element.id, element.clipId])),
          },
    );
  };
  // Free transform (T-M05a): the box edits the selected elements drawn on
  // this frame. While an agent's staged preview is on screen nothing can be edited.
  const agentPreviewOnScreen =
    agentPreviewState.document !== undefined &&
    agentPreviewState.document.baseRevision === session.projectRevisionId;
  const readTransformTargetsRef = useRef<
    (clipIds?: readonly string[]) => readonly MonitorTransformTarget[]
  >(() => []);
  readTransformTargetsRef.current = (clipIds) => {
    const frame = currentFrameRef.current;
    if (frame === undefined) return [];
    return buildTransformTargets({
      elements: readMonitorElementsRef.current(),
      frame,
      project: previewVisualProject,
      selectedClipIds: clipIds ?? selectedIdsRef.current,
      timeUs: state.playheadUs,
      agentPreviewOnScreen,
    });
  };
  // The playhead a release writes its keyframes at (T-M05b).
  const playheadRef = useRef(state.playheadUs);
  playheadRef.current = state.playheadUs;
  const livePatches = useMonitorTransformPreview();
  // A colour gesture in progress draws with its live grade (never written yet).
  const liveGrade = useColorGradePreview();
  // Hold to compare (T-K04) draws the picture without any colour grade; the
  // eyedropper's read-back draws one such frame, copies it and draws again.
  const gradeBypassed = useColorGradeBypass();
  const ungradedPaintRef = useRef(false);
  const transformHost = useMemo<MonitorTransformHost>(
    () => ({
      preview: (patches) => monitorTransformPreview.set(patches),
      cancel: () => monitorTransformPreview.set(undefined),
      commit: (label: string, patches: TransformPatches) => {
        try {
          // One undo step for the whole gesture, as the aspect-ratio change does.
          // A value whose stopwatch is on gets a keyframe at the playhead (T-M05b).
          session.dispatchCompound(label, {
            document: {
              ...withTransformPatches(session.visualProject, patches, playheadRef.current),
              updatedAt: new Date().toISOString(),
            },
          });
          bumpProjectRevision();
        } catch (reason) {
          showToast(
            `Could not change the element: ${reason instanceof Error ? reason.message : String(reason)}`,
            'error',
          );
        } finally {
          monitorTransformPreview.set(undefined);
        }
      },
    }),
    [bumpProjectRevision, session, showToast],
  );
  const transformController = useMonitorTransform({
    readTargets: (clipIds) => readTransformTargetsRef.current(clipIds),
    host: transformHost,
    onBlocked: (message) => showToast(message, 'info'),
  });
  const [transformTargets, setTransformTargets] = useState<readonly MonitorTransformTarget[]>([]);
  const monitorSelection = useMemo<MonitorViewportSelection>(() => {
    const setters = { selectClips, toggleSelection, clearSelection };
    const hoverRevision = [state.playheadUs, previewVisualProject, timelineProject] as const;
    return {
      isElementAt: (point) => monitorHitClipIds(point, readMonitorElementsRef.current()).length > 0,
      doubleClick: (point) => {
        if (agentPreviewOnScreen) return false;
        const elements = readMonitorElementsRef.current();
        const clipId = monitorHitClipIds(point, elements)[0];
        if (clipId === undefined) return false;
        const element = elements.find((candidate) => candidate.clipId === clipId);
        const objectId =
          element !== undefined && previewVisualProject.visualObjects[element.id] !== undefined
            ? element.id
            : clipIdToObjectId(previewVisualProject, clipId);
        const object = objectId === undefined ? undefined : visualProject.visualObjects[objectId];
        if (object?.kind !== 'text') return false;
        selectClips([clipId]);
        setEditingTextId(objectId);
        return true;
      },
      hover: (point) => monitorHoverElementAt(point, monitorElementsRef.current, state.selectedIds),
      hoverRevision,
      click: (point, modifiers) =>
        applyMonitorSelection(
          monitorClickAction(
            monitorHitClipIds(point, readMonitorElementsRef.current()),
            selectedIdsRef.current,
            modifiers,
          ),
          setters,
        ),
      marquee: (start, end, modifiers) =>
        applyMonitorSelection(
          monitorMarqueeAction(
            monitorMarqueeClipIds(start, end, readMonitorElementsRef.current()),
            selectedIdsRef.current,
            modifiers.shift,
          ),
          setters,
        ),
      // A drag inside a selected box moves the selection; a drag on another
      // element selects it (Shift adds it) and moves it.
      dragElement: (start, modifiers) => {
        const elements = readMonitorElementsRef.current();
        const selected = selectedIdsRef.current;
        const insideSelected = elements.some(
          (element) =>
            selected.includes(element.clipId) &&
            element.hidden !== true &&
            boxContainsPoint(element.bounds.corners, start),
        );
        let clipIds = selected;
        if (!insideSelected) {
          const top = monitorHitClipIds(start, elements)[0];
          if (top === undefined) return undefined;
          clipIds = modifiers.shift && !selected.includes(top) ? [...selected, top] : [top];
          selectClips(clipIds);
        }
        const movingElements = elements.filter(
          (element) => clipIds.includes(element.clipId) && element.hidden !== true,
        );
        if (movingElements.length === 0) return undefined;
        const movingIds = new Set(movingElements.map((element) => element.id));
        const initialBox = movingElements
          .map((element) => element.bounds.aabb)
          .reduce((bounds, box) => {
            const left = Math.min(bounds.x, box.x);
            const top = Math.min(bounds.y, box.y);
            const right = Math.max(bounds.x + bounds.width, box.x + box.width);
            const bottom = Math.max(bounds.y + bounds.height, box.y + box.height);
            return { x: left, y: top, width: right - left, height: bottom - top };
          });
        const targets = collectSnapTargets(
          frameSize,
          elements
            .filter((element) => element.hidden !== true && !movingIds.has(element.id))
            .map((element) => element.bounds.aabb),
          viewOptions.guides,
        );
        const drag = transformController.startGesture({ kind: 'move' }, start, clipIds);
        if (drag === undefined) return undefined;
        const angle = movingElements.length === 1 ? movingElements[0]!.bounds.rotationDeg : 0;
        return {
          update: (point, nextModifiers) => {
            const deltaX = point.x - start.x;
            const deltaY = point.y - start.y;
            const result = snapMove(
              {
                ...initialBox,
                x: initialBox.x + deltaX,
                y: initialBox.y + deltaY,
              },
              targets,
              monitorView.view.zoom,
              nextModifiers.ctrl,
            );
            drag.update(
              {
                x: start.x + result.box.x - initialBox.x,
                y: start.y + result.box.y - initialBox.y,
              },
              { shift: nextModifiers.shift, alt: nextModifiers.alt },
            );
            setSnapFeedback({ box: result.box, angle, cursor: point, guides: result.guides });
          },
          end: (commit) => {
            drag.end(commit);
            setSnapFeedback(null);
          },
        };
      },
    };
  }, [
    clearSelection,
    agentPreviewOnScreen,
    frameSize,
    monitorView.view.zoom,
    previewVisualProject,
    selectClips,
    state.playheadUs,
    state.selectedIds,
    timelineProject,
    toggleSelection,
    transformController,
    visualProject,
    setEditingTextId,
    viewOptions.guides,
  ]);
  const openMonitorContextMenu = (
    event: ReactMouseEvent<HTMLDivElement>,
    canvasPoint: { readonly x: number; readonly y: number },
  ) => {
    if (agentPreviewOnScreen) return;
    const elements = readMonitorElementsRef.current();
    const clipId = monitorHitClipIds(canvasPoint, elements)[0];
    if (clipId === undefined) return;
    const element = elements.find((candidate) => candidate.clipId === clipId);
    const objectId =
      element !== undefined && visualProject.visualObjects[element.id] !== undefined
        ? element.id
        : clipIdToObjectId(visualProject, clipId);
    const object = objectId === undefined ? undefined : visualProject.visualObjects[objectId];
    if (object === undefined) return;

    const selectedClip = Object.values(visualProject.compositions)
      .flatMap((composition) => composition.tracks.flatMap((track) => track.clips))
      .find((clip) => clip.id === clipId);
    const assetId =
      object.assetId ?? (selectedClip?.kind === 'video' ? selectedClip.assetId : undefined);
    const mediaFit = mediaFitSelection(visualProject, object, clipId);
    const frame = currentFrameRef.current;
    const composition =
      frame === undefined
        ? undefined
        : (previewVisualProject.compositions[frame.compositionId] ??
          previewVisualProject.compositions[previewVisualProject.rootCompositionId]);
    const transformableVisual =
      object.kind === 'image' ||
      object.kind === 'text' ||
      object.kind === 'shape' ||
      object.kind === 'html-scene' ||
      (object.kind === 'null' &&
        (selectedClip?.kind === 'video' ||
          previewVisualProject.assets[assetId ?? '']?.kind === 'image' ||
          previewVisualProject.assets[assetId ?? '']?.kind === 'video'));
    const transformTarget =
      transformableVisual && frame !== undefined
        ? readTransformTargetsRef
            .current([clipId])
            .find((candidate) => candidate.objectId === object.id)
        : undefined;
    const transformState =
      transformableVisual && transformTarget !== undefined && composition !== undefined
        ? monitorContextTransformState({
            objectId: object.id,
            object,
            project: previewVisualProject,
            target: transformTarget,
            frameWidth: composition.width,
            frameHeight: composition.height,
            activeCamera: composition.activeCameraId !== undefined,
          })
        : undefined;
    const missing =
      assetId !== undefined &&
      missingAssetIds?.has(assetId) === true &&
      onRelinkMissing !== undefined;
    const transformDisabledReason =
      transformState?.disabledReason ??
      (transformableVisual && transformState === undefined
        ? 'This element cannot be transformed in the current view.'
        : undefined);
    const items = buildMonitorContextMenuItems({
      objectId: object.id,
      clipId,
      canFit: mediaFit !== undefined && mediaFit.disabledReason === undefined,
      canCrop: monitorCropAvailable(object, previewVisualProject.assets[assetId ?? '']?.kind),
      missing,
      showTransformActions: transformableVisual,
      ...(transformDisabledReason === undefined ? {} : { transformDisabledReason }),
      ...(transformState?.centreDisabledReason === undefined
        ? {}
        : { centreDisabledReason: transformState.centreDisabledReason }),
      ...(transformState?.resetDisabledReason === undefined
        ? {}
        : { resetDisabledReason: transformState.resetDisabledReason }),
      ...(transformState === undefined
        ? {}
        : {
            alreadyCentred: transformState.alreadyCentred,
            alreadyReset: transformState.alreadyReset,
          }),
      onAction: (action: MonitorContextAction, targetId: string) => {
        if (action === 'fit' || action === 'fill') {
          if (mediaFit === undefined) return;
          const transaction = buildMediaFitTransaction(targetId, mediaFit, action);
          if (transaction !== undefined) dispatchProject(transaction);
        } else if (action === 'centre' || action === 'reset') {
          const transaction =
            action === 'centre'
              ? transformState?.centreTransaction
              : transformState?.resetTransaction;
          if (transaction !== undefined) dispatchProject(transaction);
        } else if (action === 'crop') {
          selectClips([clipId]);
          setCropObjectId(targetId);
          setCropMode(true);
        } else if (action === 'relink') {
          onRelinkMissing?.();
        }
      },
    });
    // A right-click inside the frame never opens the browser's own menu, even when a clip has no items.
    event.preventDefault();
    if (items.length === 0) return;
    selectClips([clipId]);
    setContextMenu({ x: event.clientX, y: event.clientY, items });
  };
  // Announced to screen readers (polite) when Tab changes the selected element (T-M12).
  const [keyAnnouncement, setKeyAnnouncement] = useState('');
  // Keyboard-only editing of the picture (T-M12): with focus on the picture (its
  // stage), Tab and Shift+Tab select the next and previous element and, at the first or last
  // element, let focus leave the picture. Esc leaves it.
  useEffect(() => {
    const onStage = (target: EventTarget | null) =>
      target instanceof HTMLElement && target.hasAttribute('data-monitor-stage');
    const visibleIds = () =>
      readMonitorElementsRef
        .current()
        .filter((element) => element.hidden !== true)
        .map((element) => element.clipId);
    const stepFor = (backwards: boolean) =>
      nextElementClipId(visibleIds(), selectedIdsRef.current, backwards);
    const removeTab = scopedKeyTable.register({
      scope: MONITOR_KEY_SCOPE,
      // No step (the first or last element) means no match: the browser's Tab moves focus out.
      match: (event) =>
        event.key === 'Tab' &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        onStage(event.target ?? null) &&
        stepFor(event.shiftKey) !== undefined,
      run: (event) => {
        const ids = visibleIds();
        const next = stepFor(event.shiftKey);
        if (next === undefined) return;
        selectClips([next]);
        setKeyAnnouncement(`Element ${ids.indexOf(next) + 1} of ${ids.length} selected`);
      },
    });
    const removeEscape = scopedKeyTable.register({
      scope: MONITOR_KEY_SCOPE,
      match: (event) => event.key === 'Escape' && onStage(event.target ?? null),
      run: (event) => {
        if (event.target instanceof HTMLElement) event.target.blur();
      },
    });
    return () => {
      removeTab();
      removeEscape();
    };
  }, [selectClips]);
  const monitorResourceTokenRef = useRef(
    `monitor:${crypto.randomUUID?.() ?? Date.now().toString(36)}`,
  );

  useEffect(() => {
    const syncFullscreenState = () =>
      setFullscreen(document.fullscreenElement === panelRef.current);
    document.addEventListener('fullscreenchange', syncFullscreenState);
    return () => document.removeEventListener('fullscreenchange', syncFullscreenState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const mattes = readImageMatteMap(previewVisualProject);
    const activeStickerIds = new Set(
      Object.values(previewVisualProject.visualObjects)
        .filter((object) => object.kind === 'image' && object.assetId !== undefined)
        .map((object) => object.id),
    );
    stickerImageCache.clearMissing(activeStickerIds);
    void Promise.all(
      Object.values(previewVisualProject.visualObjects).map(async (object) => {
        if (object.kind !== 'image' || object.assetId === undefined) return;
        await stickerImageCache.syncObject({
          objectId: object.id,
          assetId: object.assetId,
          ...(mattes[object.id] !== undefined ? { matteAssetId: mattes[object.id] } : {}),
          crop: object.transform.crop,
          loadBlob: loadProjectAssetBlob,
        });
      }),
    )
      .then(() => {
        if (cancelled) return;
        setSceneTick((tick) => tick + 1);
      })
      .catch((error) => {
        if (cancelled) return;
        console.warn('Failed to sync sticker bitmaps', error);
      });
    return () => {
      cancelled = true;
    };
  }, [loadProjectAssetBlob, previewVisualProject, stickerTick]);

  // Zoom, pan, panel size, screen pixel ratio and quality go to the renderer
  // as a Monitor-only view and pixel scale. They re-draw the pixels without
  // rebuilding the frame, and they never enter the IR or the export.
  applyViewRef.current = (renderer: BrowserPixiRenderer): void => {
    renderer.setPixelScale(monitorPixelScale(activePreviewQuality, devicePixelRatio));
    renderer.setView(monitorView.view, monitorView.viewportSize);
  };

  paintRef.current = (): void => {
    const renderStartedAtMs = performance.now();
    const renderer = rendererRef.current;
    if (renderer === null) return;
    const composition = previewVisualProject.compositions[previewVisualProject.rootCompositionId];
    if (composition === undefined) return;
    const cameraId = composition.activeCameraId;
    // A Monitor drag in progress draws with its live values (never written yet).
    const patches = monitorTransformPreview.get();
    const drawnProject = withTransformPatches(previewVisualProject, patches, state.playheadUs);
    // A colour gesture in progress draws with its live grade (never written yet).
    const withoutGrade = gradeBypassed || ungradedPaintRef.current;
    const drawnGrade = withoutGrade ? undefined : liveGrade;
    const gradedProject = withoutGrade
      ? withoutColorGrades(previewVisualProject)
      : withColorGradePreview(previewVisualProject, liveGrade);
    const gradedClip =
      drawnGrade?.scope === 'clip' && drawnGrade.clipId !== undefined
        ? findVideoClipById(timelineProject, drawnGrade.clipId)
        : undefined;
    const objectsById = drawnProject.visualObjects as Readonly<Record<string, VisualObjectV1>>;
    // A text or sticker bound to a clip is drawn only while that clip plays.
    const resolved: ResolvedObject[] = Object.values(drawnProject.visualObjects)
      .filter((object) =>
        isBoundObjectActive(
          drawnProject,
          object.id,
          state.playheadUs,
          hiddenClipIds(timelineProject),
          timelineProject,
        ),
      )
      .map((object) => ({
        object,
        transform: evaluateCameraExpressionTransform(
          object.id,
          cameraId,
          objectsById,
          state.playheadUs,
          composition.height,
        ).transform,
      }));
    const visualFrame = withCaptionBurnInNodes(
      buildRenderFrameIR(
        composition.id,
        state.playheadUs,
        composition.width,
        composition.height,
        resolved,
        renderFrameOptions(
          gradedProject,
          timelineProject,
          state.playheadUs,
          imageSizesFromCache(state.playheadUs),
        ),
      ),
      previewVisualProject,
    );
    const frame =
      previewVideoFrame === undefined
        ? visualFrame
        : withVideoFrameNode(
            visualFrame,
            withPreviewVideoNode(
              withColorGradePreviewNode(
                withoutGrade
                  ? withoutVideoNodeGrade(previewVideoFrame.node)
                  : previewVideoFrame.node,
                drawnGrade,
                gradedProject,
                state.playheadUs,
                gradedClip === undefined
                  ? undefined
                  : { startUs: gradedClip.startUs, durationUs: gradedClip.durationUs },
              ),
              drawnProject,
              patches,
              state.playheadUs,
            ),
          );
    currentFrameRef.current = frame;
    const videoBitmaps = new Map(clipFrameCache);
    if (previewVideoFrame !== undefined) {
      videoBitmaps.set(previewVideoFrame.node.id, previewVideoFrame.bitmap);
    }
    for (const [id, bitmap] of sceneCacheRef.current.bitmaps()) {
      videoBitmaps.set(id, bitmap);
    }
    for (const [id, bitmap] of stickerImageCache.bitmaps(state.playheadUs)) {
      videoBitmaps.set(id, bitmap);
    }
    applyClipGradesToTransitionBitmaps(
      gradedProject,
      activeTransitionAt(gradedProject, state.playheadUs, transitionClipTimes(timelineProject)),
      state.playheadUs,
      videoBitmaps,
      (grade) => colorLutResolverRef.current?.resolveColorLut(grade),
    );
    applyViewRef.current(renderer);
    renderer.render(frame, videoBitmaps);
    const renderedAtMs = performance.now();
    if (state.playing) {
      const sample = recordMonitorFrame(
        performanceTrackerRef.current,
        frame.timeUs,
        renderedAtMs,
        previewFrameRate,
      );
      performanceTrackerRef.current = sample.tracker;
      if (sample.stats !== undefined) setPerformanceStats(sample.stats);
      if (previewQuality === 'auto') {
        const decision = chooseAutoPreviewQuality(
          activePreviewQualityRef.current,
          renderedAtMs - renderStartedAtMs,
          previewFrameRate,
          autoPreviewQualityStateRef.current,
        );
        autoPreviewQualityStateRef.current = decision.state;
        if (decision.quality !== activePreviewQualityRef.current)
          setAutoPreviewQuality(decision.quality);
      } else {
        autoPreviewQualityStateRef.current = INITIAL_AUTO_PREVIEW_QUALITY_STATE;
      }
    } else {
      autoPreviewQualityStateRef.current = INITIAL_AUTO_PREVIEW_QUALITY_STATE;
    }
    refreshSelectionOutlineRef.current();
    // A staged document becomes review-ready only after the real program
    // renderer has accepted it. This is not a commit/approval path.
    if (renderedAgentDocumentPreview !== undefined && agentPreviewSurfaceVisible) {
      appAgentPreviewStore.acknowledgeRender(
        renderedAgentDocumentPreview.runId,
        renderedAgentDocumentPreview.bundleVersion,
        'document',
      );
      const acknowledgementKey = `${renderedAgentDocumentPreview.runId}:${renderedAgentDocumentPreview.bundleVersion}`;
      if (documentPreviewAcknowledgementRef.current !== acknowledgementKey) {
        documentPreviewAcknowledgementRef.current = acknowledgementKey;
        setDocumentPreviewAcknowledgement(acknowledgementKey);
      }
    }
  };

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const rendererResourceToken = monitorResourceTokenRef.current;
    if (rendererDisposeTimerRef.current !== undefined) {
      window.clearTimeout(rendererDisposeTimerRef.current);
      rendererDisposeTimerRef.current = undefined;
    }
    let disposed = false;
    const initialization =
      rendererPromiseRef.current ??
      createBrowserPixiRenderer({
        parent: container,
        resolution: previewQualityResolution(activePreviewQualityRef.current),
        resolveColorLut: (grade) => colorLutResolverRef.current?.resolveColorLut(grade),
      });
    rendererPromiseRef.current = initialization;
    initialization
      .then((created) => {
        if (disposed) return;
        rendererRef.current = created;
        recordPreviewResourceCreated('pixi-renderer', rendererResourceToken);
        setMonitorPixelReader(() => created.readPixels());
        setMonitorUngradedPixelReader((maxWidth, maxHeight, region) => {
          ungradedPaintRef.current = true;
          try {
            paintRef.current();
            return created.readPixels(maxWidth, maxHeight, region);
          } finally {
            ungradedPaintRef.current = false;
            paintRef.current();
          }
        });
        paintRef.current();
      })
      .catch((reason: unknown) => {
        if (disposed) return;
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      disposed = true;
      // React StrictMode replays effects while preserving this panel. Reuse
      // the same async Pixi Application across that replay so two renderers do
      // not race through Pixi's process-wide CanvasText texture pool. A real
      // unmount has no matching setup and disposes after the zero-delay gate.
      rendererDisposeTimerRef.current = window.setTimeout(() => {
        rendererDisposeTimerRef.current = undefined;
        const pending = rendererPromiseRef.current;
        const existing = rendererRef.current;
        rendererPromiseRef.current = null;
        rendererRef.current = null;
        setMonitorPixelReader(undefined);
        setMonitorUngradedPixelReader(undefined);
        if (pending !== null)
          void pending
            .then((created) => created.destroy())
            .catch(() => undefined)
            .finally(() => recordPreviewResourceReleased('pixi-renderer', rendererResourceToken));
        else {
          existing?.destroy();
          recordPreviewResourceReleased('pixi-renderer', rendererResourceToken);
        }
      }, 0);
    };
  }, [previewQuality]);

  useEffect(() => {
    const current = loadEditorUiPreferences(storage);
    saveEditorUiPreferences(storage, {
      ...current,
      monitorPreview: { quality: previewQuality },
    });
  }, [previewQuality, storage]);

  useEffect(() => {
    let cancelled = false;
    void sceneCacheRef.current
      .sync(previewVisualProject.visualObjects, state.playheadUs)
      .then(() => {
        if (cancelled) return;
        setSceneTick((value) => value + 1);
      });
    return () => {
      cancelled = true;
    };
  }, [state.playheadUs, previewVisualProject]);

  useEffect(() => () => sceneCacheRef.current.destroy(), []);

  // A timeline selection shows on the Monitor without a repaint.
  useEffect(() => {
    refreshSelectionOutlineRef.current();
  }, [state.selectedIds, timelineProject, previewVisualProject]);

  useEffect(() => {
    const renderer = rendererRef.current;
    if (renderer !== null) applyViewRef.current(renderer);
  }, [activePreviewQuality, devicePixelRatio, monitorView.view, monitorView.viewportSize]);

  useEffect(() => {
    paintRef.current();
  }, [
    agentPreviewSurfaceVisible,
    clipFrameCache,
    clipFrameTick,
    previewVideoFrame,
    state.playing,
    state.playheadUs,
    visualProject,
    previewVisualProject,
    sceneTick,
    livePatches,
    liveGrade,
    gradeBypassed,
  ]);

  // The read-out follows the persisted canvas, so Undo, Redo and reload keep it true.
  const canvasPresetId = canvasFormatPresetId(visualProject.exportPreset, { width, height });
  const timelineComposition = timelineProject.compositions[timelineProject.rootCompositionId];
  const durationUs =
    timelineComposition === undefined
      ? (composition?.durationUs ?? 30_000_000)
      : timelineEffectiveDurationUs(timelineComposition);
  const hasTimelineContent =
    timelineComposition?.tracks.some((track) => track.clips.length > 0) ?? false;
  const zoomLabel = monitorZoomLabel(monitorView.fit, monitorView.view.zoom);
  const spaceHeld = useSpaceHold();
  const transformOverlays = useMemo(
    () => buildMonitorOverlays(transformTargets, monitorView.view.zoom),
    [monitorView.view.zoom, transformTargets],
  );
  const transformGroup = useMemo(
    () => buildMonitorGroupOverlay(transformTargets, monitorView.view.zoom),
    [monitorView.view.zoom, transformTargets],
  );
  const editingTextObject =
    editingTextId === undefined ? undefined : visualProject.visualObjects[editingTextId];
  const editingTextOverlay =
    editingTextId === undefined
      ? undefined
      : transformOverlays.find((overlay) => overlay.elementId === editingTextId);
  const selectedMediaOverlay = transformOverlays.length === 1 ? transformOverlays[0] : undefined;
  const selectedMediaObject =
    selectedMediaOverlay === undefined
      ? undefined
      : visualProject.visualObjects[selectedMediaOverlay.elementId];
  const selectedTimelineClip =
    state.selectedIds.length !== 1
      ? undefined
      : Object.values(timelineProject.compositions)
          .flatMap((entry) => entry.tracks.flatMap((track) => track.clips))
          .find((clip) => clip.id === state.selectedIds[0]);
  const selectedMediaAssetId =
    selectedMediaObject?.assetId ??
    (selectedTimelineClip?.kind === 'video' ? selectedTimelineClip.assetId : undefined);
  const selectedMediaAssetKind =
    selectedMediaAssetId === undefined
      ? undefined
      : previewVisualProject.assets[selectedMediaAssetId]?.kind;
  const selectedCropOverlay =
    selectedMediaObject !== undefined &&
    monitorCropAvailable(selectedMediaObject, selectedMediaAssetKind)
      ? selectedMediaOverlay
      : undefined;
  const selectedCropTarget =
    selectedCropOverlay === undefined
      ? undefined
      : transformTargets.find((target) => target.nodeId === selectedCropOverlay.elementId);
  const cropTargetId =
    cropObjectId ?? selectedCropTarget?.objectId ?? selectedCropOverlay?.elementId;
  const cropTargetObject =
    cropTargetId === undefined ? undefined : visualProject.visualObjects[cropTargetId];
  const cropOverlayNodeId =
    monitorCropOverlayNodeId(cropTargetId, transformTargets) ?? cropTargetId;
  const cropOverlay =
    cropOverlayNodeId === undefined
      ? undefined
      : transformOverlays.find((overlay) => overlay.elementId === cropOverlayNodeId);
  useEffect(() => {
    if (!cropMode || cropObjectId === undefined) return;
    if (resolveObjectIdForSelection(visualProject, state.selectedIds) === cropObjectId) return;
    setCropMode(false);
    setCropObjectId(undefined);
  }, [cropMode, cropObjectId, state.selectedIds, visualProject]);
  const commitMonitorText = (text: string) => {
    if (editingTextId === undefined) return;
    const project = session.visualProject;
    const object = project.visualObjects[editingTextId];
    if (object?.kind !== 'text') return;
    const currentText =
      object.textDocument === undefined
        ? (object.text ?? '')
        : textDocumentToString(object.textDocument);
    if (text === currentText) return;
    try {
      const updatedObject = textObjectWithDraftText(object, text);
      session.dispatchCompound('Edit text', {
        document: {
          ...project,
          updatedAt: new Date().toISOString(),
          visualObjects: { ...project.visualObjects, [object.id]: updatedObject },
        },
      });
      bumpProjectRevision();
    } catch (reason) {
      showToast(
        `Could not edit the title: ${reason instanceof Error ? reason.message : String(reason)}`,
        'error',
      );
    }
  };
  const commitMonitorCrop = (crop: CropInsets) => {
    if (cropTargetId === undefined) return;
    const object = session.visualProject.visualObjects[cropTargetId];
    const selectedClip =
      state.selectedIds.length !== 1
        ? undefined
        : Object.values(timelineProject.compositions)
            .flatMap((entry) => entry.tracks.flatMap((track) => track.clips))
            .find((clip) => clip.id === state.selectedIds[0]);
    const assetId =
      object?.assetId ?? (selectedClip?.kind === 'video' ? selectedClip.assetId : undefined);
    const assetKind =
      assetId === undefined ? undefined : session.visualProject.assets[assetId]?.kind;
    if (
      object === undefined ||
      !monitorCropAvailable(object, assetKind) ||
      JSON.stringify(object.transform.crop) === JSON.stringify(crop)
    )
      return;
    dispatchProject({
      label: 'Crop',
      commands: [{ type: 'object.setCrop', payload: { objectId: cropTargetId, crop } }],
    });
  };
  const transformSnapTargets = collectSnapTargets(
    frameSize,
    monitorElementsRef.current
      .filter((element) => element.hidden !== true && !state.selectedIds.includes(element.clipId))
      .map((element) => element.bounds.aabb),
    viewOptions.guides,
  );
  // A selected text with a gradient fill shows its two anchors on the picture: drag them to place the gradient.
  const gradientTarget = useMemo(() => {
    if (transformOverlays.length !== 1) return undefined;
    const overlay = transformOverlays[0]!;
    const object = visualProject.visualObjects[overlay.elementId];
    const fill = object?.kind === 'text' ? object.textStyle?.fill : undefined;
    if (object === undefined || fill === undefined || fill.kind !== 'linear-gradient')
      return undefined;
    const anchors = textGradientAnchors(fill);
    return {
      overlay,
      objectId: object.id,
      start: anchors.start,
      end: anchors.end,
      startColor: fill.stops[0]?.color ?? '#ffffff',
      endColor: fill.stops[fill.stops.length - 1]?.color ?? '#ffffff',
    };
  }, [transformOverlays, visualProject]);
  const gradientPending = useRef<{
    objectId: string;
    start: TextGradientPointV1;
    end: TextGradientPointV1;
  } | null>(null);
  const gradientFrame = useRef<number | undefined>(undefined);
  const moveGradientAnchors = (next: {
    readonly start: TextGradientPointV1;
    readonly end: TextGradientPointV1;
  }) => {
    if (gradientTarget === undefined) return;
    gradientPending.current = { objectId: gradientTarget.objectId, ...next };
    if (gradientFrame.current !== undefined) return;
    // One project write per frame while the dot is dragged.
    gradientFrame.current = requestAnimationFrame(() => {
      gradientFrame.current = undefined;
      const pending = gradientPending.current;
      gradientPending.current = null;
      if (pending === null) return;
      const project = context.visualProject;
      const object = project.visualObjects[pending.objectId];
      if (object?.kind !== 'text' || object.textStyle?.fill.kind !== 'linear-gradient') return;
      context.replaceVisualProject({
        ...project,
        visualObjects: {
          ...project.visualObjects,
          [pending.objectId]: {
            ...object,
            textStyle: {
              ...object.textStyle,
              fill: { ...object.textStyle.fill, start: pending.start, end: pending.end },
            },
          },
        },
      });
    });
  };
  const frameRect = monitorFrameRect(monitorView.view, frameSize);

  const toggleFullscreen = () => {
    const el = panelRef.current;
    if (el === null) return;
    if (document.fullscreenElement === el) {
      void document
        .exitFullscreen()
        .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
      return;
    }
    void el
      .requestFullscreen()
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  };

  const handleMonitorEffectDragOver = useCallback((event: React.DragEvent) => {
    if (
      !event.dataTransfer.types.includes('application/x-joy-effect') &&
      !event.dataTransfer.types.includes('Files')
    )
      return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setMonitorDragOver(true);
  }, []);

  const handleMonitorEffectDragLeave = useCallback(() => {
    setMonitorDragOver(false);
  }, []);

  const applyMonitorEffect = useCallback(
    (effectId: string) => {
      const objectId = resolveObjectIdForSelection(visualProject, state.selectedIds);
      if (!objectId || !isSingleVideoClipSelected(timelineProject, state.selectedIds)) {
        showToast('Select one video clip before dropping an effect.', 'info');
        return;
      }
      const descriptor = effectRegistry.getEffect(effectId);
      if (!descriptor) return;
      const defaults: Record<string, unknown> = {};
      for (const p of descriptor.params) defaults[p.key] = p.defaultValue;
      dispatchProject({
        label: `Effect: ${effectId}`,
        commands: [
          {
            type: 'effect.add',
            payload: { objectId, effectId, params: defaults },
          },
        ],
      } as unknown as VisualObjectTransaction);
    },
    [dispatchProject, timelineProject, visualProject, state.selectedIds, showToast],
  );

  const handleMonitorEffectDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setMonitorDragOver(false);
      if (event.dataTransfer.types.includes('Files') || event.dataTransfer.files.length > 0) {
        event.stopPropagation();
        onFilesDrop?.(Array.from(event.dataTransfer.files));
        return;
      }
      const raw = event.dataTransfer.getData('application/x-joy-effect');
      if (!raw) return;
      try {
        const payload = JSON.parse(raw) as { kind: string; effectId: string; source: string };
        applyMonitorEffect(payload.effectId);
      } catch {
        /* ignore malformed */
      }
    },
    [applyMonitorEffect, onFilesDrop],
  );

  const handlePointerDndMove = useCallback(
    (
      payload: EditorPointerDragPayload,
      target: EditorPointerDropTarget | undefined,
      event: globalThis.PointerEvent | undefined,
    ) => {
      setMonitorDragOver(
        event !== undefined &&
          target?.kind === 'monitor' &&
          (payload.kind === 'media' || payload.kind === 'effect'),
      );
    },
    [],
  );

  const handlePointerDndDrop = useCallback(
    (payload: EditorPointerDragPayload, target: EditorPointerDropTarget) => {
      setMonitorDragOver(false);
      if (target.kind !== 'monitor') return;
      if (payload.kind === 'media') {
        if (onAssetDrop === undefined) {
          showToast('The Monitor cannot add media in this workspace.', 'info');
          return;
        }
        onAssetDrop(payload.asset);
      } else if (payload.kind === 'effect') {
        applyMonitorEffect(payload.effectId);
      }
    },
    [applyMonitorEffect, onAssetDrop, showToast],
  );

  useEffect(() => {
    const root = panelRef.current;
    if (root === null) return;
    return registerEditorPointerDndRoot(root, {
      onMove: handlePointerDndMove,
      onDrop: handlePointerDndDrop,
    });
  }, [handlePointerDndDrop, handlePointerDndMove]);

  return (
    <article className="monitor-panel" ref={panelRef} data-editor-pointer-dnd-root="">
      <p className="sr-only" role="status" aria-live="polite" data-monitor-announcement>
        {keyAnnouncement}
      </p>
      {error !== undefined && <p className="monitor-error">{error}</p>}
      {droppedImportProgress !== undefined && onCancelDroppedImport !== undefined && (
        <DroppedImportProgress progress={droppedImportProgress} onCancel={onCancelDroppedImport} />
      )}
      <MonitorViewport
        controller={monitorView}
        dragOver={monitorDragOver}
        onDragOver={handleMonitorEffectDragOver}
        onDragLeave={handleMonitorEffectDragLeave}
        onDrop={handleMonitorEffectDrop}
        readThumbnail={readNavigatorThumbnail}
        selection={monitorSelection}
        background={viewOptions.background}
        playing={state.playing}
        onContextMenu={openMonitorContextMenu}
      >
        <div ref={containerRef} className="monitor-canvas" />
        {mediaOfflineName !== undefined && <MediaOfflineNote name={mediaOfflineName} />}
        <MonitorOverlays
          view={monitorView.view}
          frame={frameSize}
          viewportSize={monitorView.viewportSize}
          options={viewOptions}
          onGuidesChange={(guides) => setViewOptions((current) => ({ ...current, guides }))}
        />
        <MonitorSelectionOverlay
          overlay={selectionOutline.overlay}
          frame={frameSize}
          frameRect={frameRect}
          clipIdOf={(nodeId) => selectionOutline.clipByNode.get(nodeId)}
        />
        <MonitorTransformBox
          overlays={editingTextId === undefined && !cropMode ? transformOverlays : []}
          group={editingTextId === undefined && !cropMode ? transformGroup : undefined}
          view={monitorView.view}
          viewportSize={monitorView.viewportSize}
          interactive={monitorView.tool === 'select' && !spaceHeld && editingTextId === undefined}
          startGesture={transformController.startGesture}
          snapTargets={transformSnapTargets}
          onSnapFeedback={setSnapFeedback}
        />
        {editingTextObject?.kind === 'text' && editingTextOverlay !== undefined && (
          <MonitorTextInlineEditor
            key={editingTextObject.id}
            object={editingTextObject}
            overlay={editingTextOverlay}
            view={monitorView.view}
            onCommit={commitMonitorText}
            onClose={() => setEditingTextId(undefined)}
          />
        )}
        {cropMode &&
          cropTargetObject !== undefined &&
          monitorCropAvailable(cropTargetObject, selectedMediaAssetKind) &&
          cropOverlay !== undefined && (
            <MonitorCropBox
              key={cropTargetObject.id}
              crop={cropTargetObject.transform.crop}
              overlay={cropOverlay}
              view={monitorView.view}
              viewportSize={monitorView.viewportSize}
              onCommit={commitMonitorCrop}
              onClose={() => {
                setCropMode(false);
                setCropObjectId(undefined);
              }}
            />
          )}
        <MonitorSnapOverlay
          feedback={snapFeedback}
          view={monitorView.view}
          viewportSize={monitorView.viewportSize}
        />
        {!cropMode && gradientTarget !== undefined && (
          <MonitorGradientAnchors
            overlay={gradientTarget.overlay}
            start={gradientTarget.start}
            end={gradientTarget.end}
            startColor={gradientTarget.startColor}
            endColor={gradientTarget.endColor}
            view={monitorView.view}
            viewportSize={monitorView.viewportSize}
            interactive={monitorView.tool === 'select' && !spaceHeld}
            onChange={moveGradientAnchors}
          />
        )}
        <MonitorEyedropper
          view={monitorView.view}
          frame={frameSize}
          playheadUs={state.playheadUs}
        />
        <AgentPreviewBadge
          surface="Program Monitor"
          before={agentPreviewBefore}
          beforeDisabled={documentPreviewInitialPaintPending}
          onBeforeChange={setAgentPreviewBefore}
        />
      </MonitorViewport>
      {contextMenu !== undefined && (
        <TimelineContextMenu menu={contextMenu} onClose={() => setContextMenu(undefined)} />
      )}
      <MonitorTransport
        zoomDrawer={zoomDrawer}
        zoomFit={monitorView.fit}
        zoom={monitorView.view.zoom}
        onZoomFit={monitorView.setFit}
        onZoomSet={monitorView.setZoom}
        zoomLabel={zoomLabel}
        fullscreen={fullscreen}
        toggleFullscreen={toggleFullscreen}
        playing={state.playing}
        playheadUs={state.playheadUs}
        durationUs={durationUs}
        hasTimelineContent={hasTimelineContent}
        seek={seek}
        togglePlayback={togglePlayback}
        previewQuality={previewQuality}
        activePreviewQuality={activePreviewQuality}
        setPreviewQuality={setPreviewQuality}
        performanceStats={performanceStats}
        formatMenu={formatMenu}
        width={width}
        height={height}
        canvasPresetId={canvasPresetId}
        viewOptions={viewOptions}
        onViewOptionsChange={setViewOptions}
        cropMode={cropMode}
        cropAvailable={selectedCropOverlay !== undefined}
        onCropToggle={() => {
          if (cropMode) {
            setCropMode(false);
            setCropObjectId(undefined);
          } else if (selectedCropOverlay !== undefined) {
            setCropObjectId(selectedCropOverlay.elementId);
            setCropMode(true);
          }
        }}
      />
    </article>
  );
}
