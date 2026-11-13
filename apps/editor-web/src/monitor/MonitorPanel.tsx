import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { EditorPanelContext, type EditorPanelContextValue } from '../editor-panel-context.js';
import { withVideoFrameNode } from '@joy-media/playback-engine';
import type { EditorOverlayIR, RenderFrameIR } from '@joy-media/render-ir';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import { evaluateCameraExpressionTransform } from '@joy-media/evaluator';
import { buildRenderFrameIR, type ResolvedObject } from '@joy-media/visual-object-renderer';
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
  previewQualityResolution,
  resolvePreviewQuality,
  type FixedPreviewQuality,
  type PreviewQuality,
} from '../preview-quality.js';
import { timelineEffectiveDurationUs } from '../timeline-layout.js';
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
import {
  appAgentPreviewStore,
  stickerImageCache,
} from '../editor-runtime-singletons.js';
import { usePopup, type PopupControl } from '../popup-manager.js';
import { POPUP_IDS } from '../popup-ids.js';
import { MonitorTransport } from './MonitorTransport.js';
import { MonitorOverlays } from './MonitorOverlays.js';
import { useMonitorViewOptions } from './MonitorViewMenu.js';
import { createMonitorPerformanceTracker, recordMonitorFrame } from './monitor-performance.js';
import { monitorZoomLabel } from './monitor-view.js';
import {
  MonitorViewport,
  monitorFrameRect,
  useDevicePixelRatio,
  useMonitorView,
  useSpaceHold,
  type MonitorViewportSelection,
} from './MonitorViewport.js';
import { MonitorSelectionOverlay } from './MonitorSelectionOverlay.js';
import { MonitorTransformBox } from './MonitorTransformBox.js';
import { boxContainsPoint } from './monitor-hit-test.js';
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
  sameMonitorOverlay,
  type MonitorElement,
} from './monitor-selection.js';
import { monitorPixelScale } from './monitor-pixel-scale.js';
import { createProjectColorLutResolver } from '../project-color-luts.js';
import {
  DroppedImportProgress,
  type DroppedImportProgressState,
} from '../DroppedImportProgress.js';

/**
 * The Program Monitor panel: the preview canvas, its renderer lifecycle and the
 * Monitor preview and direct-manipulation surface, moved out of App.tsx (T-M02a).
 */

export function MonitorPanel({
  agentPreviewSurfaceVisible = true,
  onFilesDrop,
  droppedImportProgress,
  onCancelDroppedImport,
  formatMenu,
}: {
  readonly agentPreviewSurfaceVisible?: boolean;
  readonly onFilesDrop?: (files: readonly File[]) => void;
  readonly droppedImportProgress?: DroppedImportProgressState;
  readonly onCancelDroppedImport?: () => void;
  /** The App-owned Format popup; the monitor bar's read-out opens the same popover. */
  readonly formatMenu: PopupControl;
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
      droppedImportProgress={droppedImportProgress}
      onCancelDroppedImport={onCancelDroppedImport}
      formatMenu={formatMenu}
    />
  );
}

function MonitorPanelContent({
  context,
  agentPreviewSurfaceVisible,
  onFilesDrop,
  droppedImportProgress,
  onCancelDroppedImport,
  formatMenu,
}: {
  readonly context: EditorPanelContextValue;
  readonly agentPreviewSurfaceVisible: boolean;
  readonly onFilesDrop?: ((files: readonly File[]) => void) | undefined;
  readonly droppedImportProgress?: DroppedImportProgressState | undefined;
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
  const activePreviewQuality = resolvePreviewQuality(
    previewQuality,
    autoPreviewQuality,
    !state.playing,
  );
  const [performanceStats, setPerformanceStats] = useState({ fps: 0, droppedFrames: 0 });
  const performanceTrackerRef = useRef(createMonitorPerformanceTracker());
  useEffect(() => {
    performanceTrackerRef.current = createMonitorPerformanceTracker(performance.now());
    if (state.playing) setPerformanceStats({ fps: 0, droppedFrames: 0 });
  }, [state.playing]);
  const composition = previewVisualProject.compositions[previewVisualProject.rootCompositionId];
  const previewFrameRate = composition?.frameRate ?? { num: 30, den: 1 };
  const width = composition?.width ?? 1080;
  const height = composition?.height ?? 1920;
  const frameSize = useMemo(() => ({ width, height }), [width, height]);
  const monitorView = useMonitorView(frameSize, panelRef);
  const readNavigatorThumbnail = useCallback(
    (maxWidth: number, maxHeight: number) => rendererRef.current?.readPixels(maxWidth, maxHeight),
    [],
  );
  const devicePixelRatio = useDevicePixelRatio();
  // Selection (T-M04): the Monitor keeps none of its own. It reads the shared
  // `state.selectedIds` and writes through the shared setters; the elements
  // come from the frame that was drawn last and the renderer's nodeBounds.
  const [selectionOutline, setSelectionOutline] = useState<{
    readonly overlay: EditorOverlayIR;
    readonly clipByNode: ReadonlyMap<string, string>;
  }>({ overlay: EMPTY_MONITOR_OVERLAY, clipByNode: new Map() });
  const readMonitorElementsRef = useRef<() => readonly MonitorElement[]>(() => []);
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
    return {
      isElementAt: (point) => monitorHitClipIds(point, readMonitorElementsRef.current()).length > 0,
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
        return transformController.startGesture({ kind: 'move' }, start, clipIds);
      },
    };
  }, [clearSelection, selectClips, toggleSelection, transformController]);
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
    const resolved: ResolvedObject[] = Object.values(drawnProject.visualObjects).map((object) => ({
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
        const nextQuality = chooseAutoPreviewQuality(
          activePreviewQuality,
          renderedAtMs - renderStartedAtMs,
          previewFrameRate,
        );
        if (nextQuality !== activePreviewQuality) setAutoPreviewQuality(nextQuality);
      }
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
        resolution: previewQualityResolution(activePreviewQuality),
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
        const objectId = resolveObjectIdForSelection(visualProject, state.selectedIds);
        if (!objectId || !isSingleVideoClipSelected(timelineProject, state.selectedIds)) {
          showToast('Select one video clip before dropping an effect.', 'info');
          return;
        }
        const descriptor = effectRegistry.getEffect(payload.effectId);
        if (!descriptor) return;
        const defaults: Record<string, unknown> = {};
        for (const p of descriptor.params) {
          defaults[p.key] = p.defaultValue;
        }
        dispatchProject({
          label: `Effect: ${payload.effectId}`,
          commands: [
            {
              type: 'effect.add',
              payload: { objectId, effectId: payload.effectId, params: defaults },
            },
          ],
        } as unknown as VisualObjectTransaction);
      } catch {
        /* ignore malformed */
      }
    },
    [dispatchProject, onFilesDrop, timelineProject, visualProject, state.selectedIds, showToast],
  );

  return (
    <article className="monitor-panel" ref={panelRef}>
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
      >
        <div ref={containerRef} className="monitor-canvas" />
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
          overlays={transformOverlays}
          group={transformGroup}
          view={monitorView.view}
          viewportSize={monitorView.viewportSize}
          interactive={monitorView.tool === 'select' && !spaceHeld}
          startGesture={transformController.startGesture}
        />
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
      />
    </article>
  );
}
