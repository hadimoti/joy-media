/**
 * Motion panel: redesigned with a library-first approach.
 * Includes:
 *  - Library view with search, filter, categories, favorites
 *  - Built-in, user-created, recent sections
 *  - + button to create new motions in Motion Studio
 *  - Existing presets/keyframe/spatial subtabs preserved beneath
 */

import {
  useEffect,
  useRef,
  useState,
  useMemo,
  useCallback,
  useContext,
  type MutableRefObject,
  type CSSProperties,
} from 'react';
import type { AnimatablePropertyV1, VisualObjectV1 } from '@joy-media/project-schema';
import { ANIMATABLE_PROPERTIES } from '@joy-media/project-schema';
import type { VisualObjectTransaction } from '@joy-media/property-system';
import {
  buildPresetChannels,
  JOY_MOTION_PRESETS,
  parentChain,
  sampleCurve,
  MotionRegistry,
  registerBuiltinMotions,
  type MotionDescriptor,
} from '@joy-media/motion-core';
import type { SetSpatialPathCommand } from '@joy-media/motion-core';
import {
  createScenePreviewHost,
  defaultVariablesForScene,
  type ScenePreviewHost,
} from '@joy-media/html-scene-runtime/browser';
import {
  FIRST_PARTY_SCENES,
  findFirstPartyScene,
  type FirstPartySceneId,
  type FirstPartyScenePackage,
} from '@joy-media/html-scene-runtime/first-party';
import {
  CheckIcon,
  CloseIcon,
  InfoIcon,
  PlusIcon,
  SaveIcon,
  DuplicateIcon,
  StarIcon,
  StarFilledIcon,
} from './icons.js';
import { GraphEditor } from './GraphEditor.js';
import { focusCoverTransform, getFirstPartySceneThumbUrl } from './html-scene-thumbs.js';
import { EditorPanelContext } from './App.js';
import { JOY_COLORS } from './theme.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';

interface MotionPanelProps {
  readonly object: VisualObjectV1 | undefined;
  readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
  readonly compositionDurationUs: number;
  readonly playheadUs: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
  readonly selectedClipId?: string;
  readonly onAddHtmlSceneToSelection: (sceneId: FirstPartySceneId) => void;
}

const LANE_WIDTH = 280;
const PRESET_DURATION_US = 1_000_000;
const LIVE_TILE_W = 90;
const LIVE_TILE_H = 160;
const INFO_PREVIEW_W = 168;
const INFO_PREVIEW_H = 298;
const LIVE_LOOP_MS = 3_200;

type LiveProgressListener = (progress: number) => void;

/* ─── Global motion registry (singleton) ─── */

const motionRegistry = new MotionRegistry();
registerBuiltinMotions(motionRegistry);

/* ─── Favorites persistence (localStorage) ─── */

function loadFavorites(): Set<string> {
  try {
    const raw = window.localStorage.getItem('joy-media.motion-favorites');
    if (raw === null) return new Set();
    return new Set(JSON.parse(raw) as string[]);
  } catch {
    return new Set();
  }
}

function saveFavorites(favorites: Set<string>): void {
  window.localStorage.setItem('joy-media.motion-favorites', JSON.stringify([...favorites]));
}

/* ─── Categories ─── */

/* ─── Subtab model ─── */

type LibrarySubtab = 'library' | 'presets' | 'spatial' | 'html-scenes';

/** Stand-in bound by the Motion/Spatial tabs when nothing is selected (§3c). */
const IDLE_OBJECT: VisualObjectV1 = {
  id: '',
  kind: 'null',
  transform: {
    x: 0,
    y: 0,
    scaleX: 1,
    scaleY: 1,
    rotationDeg: 0,
    opacity: 1,
    crop: { left: 0, top: 0, right: 0, bottom: 0 },
  },
};

const LIBRARY_SUBTABS: readonly { readonly id: LibrarySubtab; readonly label: string }[] = [
  { id: 'library', label: 'Library' },
  { id: 'html-scenes', label: 'Scenes' },
  { id: 'presets', label: 'Presets' },
  { id: 'spatial', label: 'Spatial' },
];

/* ─── Motion Card ─── */

/**
 * Card preview per built-in motion: the `@keyframes` name in `app.css` plus its
 * timing function. Every card runs the same logo PNG — the loop alternates, so
 * an intro reads as enter-then-leave and an outro as leave-then-return.
 */
const MOTION_CARD_PREVIEWS: Readonly<Record<string, readonly [string, string]>> = {
  'joy-fade-in': ['m-fade-in', 'ease-in'],
  'joy-fade-out': ['m-fade-out', 'ease-out'],
  'joy-pop-in': ['m-pop-in', 'ease-out'],
  'joy-pop-out': ['m-pop-out', 'ease-in'],
  'joy-zoom-in': ['m-zoom-in', 'ease-out'],
  'joy-zoom-out': ['m-zoom-out', 'ease-in'],
  'joy-punch-in': ['m-punch-in', 'cubic-bezier(0.2, 0.9, 0.25, 1)'],
  'joy-slide-up': ['m-slide-up', 'ease-out'],
  'joy-slide-down': ['m-slide-down', 'ease-out'],
  'joy-slide-in-left': ['m-slide-in-left', 'ease-out'],
  'joy-slide-in-right': ['m-slide-in-right', 'ease-out'],
  'joy-slide-out-up': ['m-slide-out-up', 'ease-in'],
  'joy-slide-out-left': ['m-slide-out-left', 'ease-in'],
  'joy-slide-out-right': ['m-slide-out-right', 'ease-in'],
  'joy-bounce-in': ['m-bounce-in', 'cubic-bezier(0.28, 0.84, 0.42, 1)'],
  'joy-bounce-out': ['m-bounce-out', 'cubic-bezier(0.6, 0.04, 0.98, 0.34)'],
  'joy-bounce-drop': ['m-bounce-drop', 'cubic-bezier(0.3, 0.8, 0.4, 1)'],
  'joy-rubber-band': ['m-rubber-band', 'ease-in-out'],
  'joy-spin-in': ['m-spin-in', 'ease-out'],
  'joy-spin-out': ['m-spin-out', 'ease-in'],
  'joy-swing-in': ['m-swing-in', 'ease-out'],
  'joy-roll-in': ['m-roll-in', 'ease-out'],
  'joy-roll-out': ['m-roll-out', 'ease-in'],
  'joy-arc-in': ['m-arc-in', 'ease-out'],
  'joy-flip-in-x': ['m-flip-in-x', 'ease-out'],
  'joy-flip-in-y': ['m-flip-in-y', 'ease-out'],
  'joy-flip-out-y': ['m-flip-out-y', 'ease-in'],
  'joy-depth-push-in': ['m-depth-push-in', 'ease-out'],
  'joy-depth-pull-out': ['m-depth-pull-out', 'ease-in'],
  'joy-fly-through-out': ['m-fly-through-out', 'cubic-bezier(0.5, 0, 0.9, 0.4)'],
};

function animationForMotion(motion: MotionDescriptor): CSSProperties | undefined {
  const preview = MOTION_CARD_PREVIEWS[motion.id];
  if (preview === undefined) return undefined;
  const [keyframes, easing] = preview;
  return { animation: `${keyframes} ${motion.durationMs}ms ${easing} infinite alternate` };
}

function MotionCard({
  motion,
  isFavorite,
  onToggleFavorite,
  onOpen,
  onDuplicate,
}: {
  readonly motion: MotionDescriptor;
  readonly isFavorite: boolean;
  readonly onToggleFavorite: (id: string) => void;
  readonly onOpen: (id: string) => void;
  readonly onDuplicate: (id: string) => void;
}) {
  const animStyle = animationForMotion(motion);
  return (
    <div className="motion-card" role="listitem">
      <div className="motion-card-preview" aria-hidden="true">
        <div className="motion-card-live" style={animStyle}>
          <img src="/assets/logo.png?v=joycode" alt="" draggable={false} />
        </div>
        <span className="motion-card-duration">{(motion.durationMs / 1000).toFixed(1)}s</span>
      </div>
      <div className="motion-card-body">
        <span className="motion-card-name" title={motion.name}>
          {motion.name}
        </span>
        <span className="motion-card-source">
          {motion.source === 'built-in' ? 'Built-in' : 'User'}
        </span>
      </div>
      <div className="motion-card-actions">
        <button
          type="button"
          className={`icon-button motion-fav-btn${isFavorite ? ' favored' : ''}`}
          aria-label={
            isFavorite ? `Remove ${motion.name} from favorites` : `Add ${motion.name} to favorites`
          }
          title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
          onClick={() => onToggleFavorite(motion.id)}
        >
          {isFavorite ? <StarFilledIcon /> : <StarIcon />}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`Open ${motion.name}`}
          title={`Open · ${motion.name}`}
          onClick={() => onOpen(motion.id)}
        >
          <InfoIcon />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`Duplicate ${motion.name}`}
          title={`Duplicate · ${motion.name}`}
          onClick={() => onDuplicate(motion.id)}
        >
          <DuplicateIcon />
        </button>
      </div>
    </div>
  );
}

/* ─── Library Section ─── */

function MotionLibrarySection({
  motions,
  label,
  emptyMessage,
  favorites,
  onToggleFavorite,
  onOpenMotion,
  onDuplicate,
}: {
  readonly motions: readonly MotionDescriptor[];
  readonly label: string;
  readonly emptyMessage: string;
  readonly favorites: Set<string>;
  readonly onToggleFavorite: (id: string) => void;
  readonly onOpenMotion: (id: string) => void;
  readonly onDuplicate: (id: string) => void;
}) {
  if (motions.length === 0) {
    return (
      <section className="motion-library-section">
        <h4 className="motion-library-section-title">{label}</h4>
        <p className="motion-library-empty">{emptyMessage}</p>
      </section>
    );
  }
  return (
    <section className="motion-library-section">
      <h4 className="motion-library-section-title">{label}</h4>
      <div className="motion-library-grid" role="list" aria-label={label}>
        {motions.map((motion) => (
          <MotionCard
            key={motion.id}
            motion={motion}
            isFavorite={favorites.has(motion.id)}
            onToggleFavorite={onToggleFavorite}
            onOpen={onOpenMotion}
            onDuplicate={onDuplicate}
          />
        ))}
      </div>
    </section>
  );
}

/* ─── Library tab ─── */

function LibraryTab({
  registry,
  favorites,
  onToggleFavorite,
  onOpenMotion,
  onDuplicate,
  favoritesOnly,
  query,
}: {
  readonly registry: MotionRegistry;
  readonly favorites: Set<string>;
  readonly onToggleFavorite: (id: string) => void;
  readonly onOpenMotion: (id: string) => void;
  readonly onDuplicate: (id: string) => void;
  readonly favoritesOnly: boolean;
  readonly query: string;
}) {
  // Was `findBySource('built-in')` only, with `findBySource('user')` computed
  // and then discarded — so motions saved out of Motion Studio never appeared
  // in their own library. The listing is the whole registry now.
  const allMotions = useMemo(() => registry.getAll(), [registry]);

  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === '') return allMotions;
    return allMotions.filter(
      (motion) => motion.name.toLowerCase().includes(q) || motion.id.toLowerCase().includes(q),
    );
  }, [allMotions, query]);

  const filtered = useMemo(
    () => matching.filter((motion) => favorites.has(motion.id)),
    [matching, favorites],
  );

  const rest = useMemo(() => {
    if (favoritesOnly) return [];
    return matching.filter((motion) => !favorites.has(motion.id));
  }, [matching, favorites, favoritesOnly]);

  const builtinRest = useMemo(() => rest.filter((motion) => motion.source === 'built-in'), [rest]);
  const userRest = useMemo(() => rest.filter((motion) => motion.source !== 'built-in'), [rest]);

  return (
    <div className="motion-library">
      <div className="motion-library-scroll">
        {filtered.length === 0 && rest.length === 0 ? (
          <p className="motion-library-empty" lang="fa">
            موشنی در دسترس نیست.
          </p>
        ) : (
          <>
            {filtered.length > 0 && (
              <MotionLibrarySection
                motions={filtered}
                label={favoritesOnly ? 'Favorites' : 'Favorited'}
                emptyMessage=""
                favorites={favorites}
                onToggleFavorite={onToggleFavorite}
                onOpenMotion={onOpenMotion}
                onDuplicate={onDuplicate}
              />
            )}
            {builtinRest.length > 0 && (
              <MotionLibrarySection
                motions={builtinRest}
                label="Built-in"
                emptyMessage=""
                favorites={favorites}
                onToggleFavorite={onToggleFavorite}
                onOpenMotion={onOpenMotion}
                onDuplicate={onDuplicate}
              />
            )}
            {userRest.length > 0 && (
              <MotionLibrarySection
                motions={userRest}
                label="User-created"
                emptyMessage=""
                favorites={favorites}
                onToggleFavorite={onToggleFavorite}
                onOpenMotion={onOpenMotion}
                onDuplicate={onDuplicate}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ─── Legacy HTML scenes tab (unchanged) ─── */

function HtmlSceneListThumb({
  sceneId,
  height = 64,
}: {
  readonly sceneId: string;
  readonly height?: number;
}) {
  const [url, setUrl] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void getFirstPartySceneThumbUrl(sceneId, height).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
  }, [sceneId, height]);
  const width = Math.max(1, Math.round((height * 9) / 16));
  if (url === undefined) {
    return (
      <span
        className="html-scene-thumb-placeholder html-scene-thumb-portrait"
        style={{ width, height }}
        aria-hidden="true"
      />
    );
  }
  return (
    <img
      className="html-scene-thumb-img html-scene-thumb-portrait"
      src={url}
      width={width}
      height={height}
      alt=""
      draggable={false}
    />
  );
}

function HtmlSceneLiveThumb({
  scene,
  listenersRef,
  tileW = LIVE_TILE_W,
  tileH = LIVE_TILE_H,
  instancePrefix = 'live-thumb',
  className = 'html-scene-live-thumb',
}: {
  readonly scene: FirstPartyScenePackage;
  readonly listenersRef: MutableRefObject<Set<LiveProgressListener>>;
  readonly tileW?: number;
  readonly tileH?: number;
  readonly instancePrefix?: string;
  readonly className?: string;
}) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    const root = rootRef.current;
    if (mount === null || root === null) return;
    let host: ScenePreviewHost | undefined;
    let cancelled = false;
    const variables = defaultVariablesForScene(scene.id);
    const viewport = scene.manifest.viewport;
    const { scale, tx, ty } = focusCoverTransform(
      viewport.width,
      viewport.height,
      tileW,
      tileH,
      scene.previewFocus,
    );

    host = createScenePreviewHost({
      instanceId: `${instancePrefix}-${scene.id}`,
      scene,
      parent: mount,
      placement: 'inline',
    });
    host.iframe.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    host.iframe.setAttribute('tabindex', '-1');
    host.iframe.setAttribute('aria-hidden', 'true');

    const onProgress: LiveProgressListener = (progress) => {
      if (cancelled || host === undefined) return;
      const durationUs = scene.manifest.durationUs;
      const timeUs = Math.max(0, Math.min(durationUs, Math.floor(progress * durationUs)));
      host.update(timeUs, variables);
      root.dataset.liveProgress = progress.toFixed(3);
    };

    void host.ready.then(() => {
      if (cancelled) return;
      listenersRef.current.add(onProgress);
      onProgress(0.12);
      setReady(true);
    });

    return () => {
      cancelled = true;
      listenersRef.current.delete(onProgress);
      host?.destroy();
    };
  }, [scene, listenersRef, tileW, tileH, instancePrefix]);

  return (
    <div
      ref={rootRef}
      className={className}
      data-scene-id={scene.id}
      style={{ width: tileW, height: tileH }}
      aria-hidden="true"
    >
      <div ref={mountRef} className="html-scene-live-thumb-mount" />
      {!ready && <span className="html-scene-thumb-placeholder html-scene-thumb-portrait" />}
    </div>
  );
}

function HtmlSceneInfoPanel({ scene }: { readonly scene: FirstPartyScenePackage }) {
  const durationSec = (scene.manifest.durationUs / 1_000_000).toFixed(1);
  const { width, height } = scene.manifest.viewport;
  const focus = scene.previewFocus;
  return (
    <div className="html-scene-info-panel" role="dialog" aria-label={`${scene.name} scene data`}>
      <dl className="html-scene-info-dl">
        <div>
          <dt>Name</dt>
          <dd>{scene.name}</dd>
        </div>
        <div>
          <dt>Package id</dt>
          <dd dir="ltr">{scene.id}</dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd dir="ltr">{durationSec}s</dd>
        </div>
        <div>
          <dt>Viewport</dt>
          <dd dir="ltr">
            {width} × {height}
          </dd>
        </div>
        <div>
          <dt>Preview focus</dt>
          <dd dir="ltr">
            x {focus.x.toFixed(2)} · y {focus.y.toFixed(2)} · w {focus.w.toFixed(2)} · h{' '}
            {focus.h.toFixed(2)}
          </dd>
        </div>
      </dl>
      <h4 className="html-scene-info-vars-title">Variables</h4>
      {Object.keys(scene.variableSchema).length === 0 ? (
        <p className="html-scene-info-empty" lang="fa">
          متغیری وجود ندارد.
        </p>
      ) : (
        <ul className="html-scene-info-vars">
          {Object.entries(scene.variableSchema).map(([key, def]) => (
            <li key={key}>
              <span className="html-scene-info-var-key" dir="ltr">
                {key}
              </span>
              <span className="html-scene-info-var-meta">
                {def.label ?? key} · {def.type} · default{' '}
                <code dir="ltr">{String(def.default)}</code>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ─── HTML Scenes Section ─── */

function HtmlSceneAddButton({
  scene,
  onAdd,
  canAdd,
  listenersRef,
  catalogLive,
  infoActive,
  onOpenInfo,
}: {
  readonly scene: FirstPartyScenePackage;
  readonly onAdd: (sceneId: FirstPartySceneId) => void;
  readonly canAdd: boolean;
  readonly listenersRef: MutableRefObject<Set<LiveProgressListener>>;
  readonly catalogLive: boolean;
  readonly infoActive: boolean;
  readonly onOpenInfo: () => void;
}) {
  return (
    <div className={infoActive ? 'html-scene-card info-active' : 'html-scene-card'}>
      <div className="html-scene-thumb" data-guide={scene.name} title={scene.name}>
        {catalogLive ? (
          <HtmlSceneLiveThumb scene={scene} listenersRef={listenersRef} />
        ) : (
          <HtmlSceneListThumb sceneId={scene.id} height={LIVE_TILE_H} />
        )}
        <span className="html-scene-thumb-label">{scene.name}</span>
      </div>
      <button
        type="button"
        className="icon-button html-scene-info-btn"
        data-guide="Scene data"
        aria-label={`Show data for ${scene.name}`}
        aria-expanded={infoActive}
        title={`Data · ${scene.name}`}
        onClick={onOpenInfo}
      >
        <InfoIcon />
      </button>
      <button
        type="button"
        className="icon-button html-scene-add-btn"
        data-guide={canAdd ? 'Add to selection' : 'Select a timeline clip'}
        aria-label={
          canAdd
            ? `Add ${scene.name} to selected clip`
            : `Select a timeline clip to add ${scene.name}`
        }
        title={canAdd ? `Add · ${scene.name}` : 'Select a timeline clip'}
        disabled={!canAdd}
        onClick={() => onAdd(scene.id)}
      >
        <PlusIcon />
      </button>
    </div>
  );
}

function resolveInfoScene(
  infoKey: string | undefined,
  allObjects: Readonly<Record<string, VisualObjectV1>>,
): FirstPartyScenePackage | undefined {
  if (infoKey === undefined) return undefined;
  if (infoKey.startsWith('inst:')) {
    const object = allObjects[infoKey.slice(5)];
    const packageId = object?.scenePackageId;
    return packageId !== undefined ? findFirstPartyScene(packageId) : undefined;
  }
  return findFirstPartyScene(infoKey);
}

function HtmlSceneInfoTab({
  scene,
  listenersRef,
  onClose,
}: {
  readonly scene: FirstPartyScenePackage;
  readonly listenersRef: MutableRefObject<Set<LiveProgressListener>>;
  readonly onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, [scene.id]);
  return (
    <div
      className="html-scene-info-tab"
      role="dialog"
      aria-modal="true"
      aria-label={`${scene.name} scene info`}
    >
      <header className="html-scene-info-tab-bar">
        <span className="html-scene-info-tab-title">{scene.name}</span>
        <button
          ref={closeRef}
          type="button"
          className="icon-button"
          data-guide="Close"
          title="Close scene info"
          aria-label="Close scene info"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </header>
      <div className="html-scene-info-tab-body">
        <div className="html-scene-info-tab-preview">
          <HtmlSceneLiveThumb
            scene={scene}
            listenersRef={listenersRef}
            tileW={INFO_PREVIEW_W}
            tileH={INFO_PREVIEW_H}
            instancePrefix="live-info"
            className="html-scene-live-thumb html-scene-info-live"
          />
        </div>
        <HtmlSceneInfoPanel scene={scene} />
      </div>
    </div>
  );
}

function HtmlScenesSection({
  allObjects,
  onDispatch,
  selectedClipId,
  onAddHtmlSceneToSelection,
}: {
  readonly allObjects: Readonly<Record<string, VisualObjectV1>>;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
  readonly selectedClipId?: string;
  readonly onAddHtmlSceneToSelection: (sceneId: FirstPartySceneId) => void;
}) {
  const existing = Object.values(allObjects).filter((item) => item.kind === 'html-scene');
  const catalogListenersRef = useRef<Set<LiveProgressListener>>(new Set());
  const infoListenersRef = useRef<Set<LiveProgressListener>>(new Set());
  const [infoSceneId, setInfoSceneId] = useState<string | undefined>(undefined);
  const infoScene = resolveInfoScene(infoSceneId, allObjects);
  const catalogLive = infoScene === undefined;
  const canAdd = selectedClipId !== undefined;

  useEffect(() => {
    let raf = 0;
    let start: number | undefined;
    let lastEmit = 0;
    const MIN_FRAME_MS = 50;
    const tick = (now: number) => {
      if (document.visibilityState === 'visible') {
        if (start === undefined) start = now;
        if (now - lastEmit >= MIN_FRAME_MS) {
          lastEmit = now;
          const progress = ((now - start) % LIVE_LOOP_MS) / LIVE_LOOP_MS;
          const active =
            infoListenersRef.current.size > 0
              ? infoListenersRef.current
              : catalogListenersRef.current;
          for (const listener of active) listener(progress);
        }
      } else {
        start = undefined;
        lastEmit = 0;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    if (infoSceneId === undefined) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setInfoSceneId(undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [infoSceneId]);

  const openInfo = (key: string) => {
    setInfoSceneId((current) => (current === key ? undefined : key));
  };

  return (
    <section
      className={
        infoScene !== undefined ? 'html-scenes-section info-tab-open' : 'html-scenes-section'
      }
    >
      <div className="html-scenes-layer" aria-hidden={infoScene !== undefined}>
        <h3 className="html-scenes-heading sr-only">HTML scenes</h3>
        <div className="html-scene-actions" role="list" aria-label="HTML scene catalog">
          {FIRST_PARTY_SCENES.map((scene) => (
            <div key={scene.id} role="listitem">
              <HtmlSceneAddButton
                scene={scene}
                onAdd={onAddHtmlSceneToSelection}
                canAdd={canAdd}
                listenersRef={catalogListenersRef}
                catalogLive={catalogLive}
                infoActive={infoScene?.id === scene.id}
                onOpenInfo={() => openInfo(scene.id)}
              />
            </div>
          ))}
        </div>
        {existing.length > 0 && (
          <ul className="html-scene-list">
            {existing.map((scene) => {
              const packageId = scene.scenePackageId ?? '';
              const pkg = findFirstPartyScene(packageId);
              const label = pkg?.name ?? packageId;
              const listInfoActive = infoSceneId === `inst:${scene.id}`;
              return (
                <li key={scene.id} dir="ltr">
                  <HtmlSceneListThumb sceneId={packageId} height={56} />
                  <span className="html-scene-list-label">{label}</span>
                  {pkg !== undefined && (
                    <button
                      type="button"
                      className="icon-button"
                      data-guide="Scene data"
                      title={`Data · ${label}`}
                      aria-label={`Show data for ${label}`}
                      aria-expanded={listInfoActive}
                      onClick={() => openInfo(`inst:${scene.id}`)}
                    >
                      <InfoIcon />
                    </button>
                  )}
                  <button
                    type="button"
                    className="icon-button"
                    title={`Remove ${scene.id}`}
                    aria-label={`Remove HTML scene ${scene.id}`}
                    onClick={() =>
                      onDispatch({
                        label: `Remove HTML scene ${scene.id}`,
                        commands: [{ type: 'htmlScene.remove', payload: { objectId: scene.id } }],
                      })
                    }
                  >
                    <CloseIcon />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {infoScene !== undefined && (
        <HtmlSceneInfoTab
          scene={infoScene}
          listenersRef={infoListenersRef}
          onClose={() => setInfoSceneId(undefined)}
        />
      )}
    </section>
  );
}

/* ─── Preset+Keyframe subtab content (restored from original) ─── */

function animatedChannels(object: VisualObjectV1): readonly AnimatablePropertyV1[] {
  const animations = object.animations;
  if (animations === undefined) return [];
  return ANIMATABLE_PROPERTIES.filter((key) => animations[key] !== undefined);
}

function SpatialPathPreview({
  object,
  duration,
  playheadUs,
}: {
  readonly object: VisualObjectV1;
  readonly duration: number;
  readonly playheadUs: number;
}) {
  const xCurve = object.animations?.x;
  const yCurve = object.animations?.y;
  if (xCurve === undefined || yCurve === undefined) {
    return (
      <section className="motion-spatial">
        <p className="empty-hint" lang="fa">
          برای پیش‌نمایش مسیر حرکت دوبعدی، هر دو محور X و Y را متحرک کنید.
        </p>
      </section>
    );
  }
  const samples = 48;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = (duration * i) / samples;
    points.push({ x: sampleCurve(xCurve, t), y: sampleCurve(yCurve, t) });
  }
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const w = 280;
  const h = 100;
  const px = (v: number) => ((v - minX) / spanX) * (w - 16) + 8;
  const py = (v: number) => h - 8 - ((v - minY) / spanY) * (h - 16);
  const d = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${px(p.x).toFixed(1)},${py(p.y).toFixed(1)}`)
    .join(' ');
  const now = { x: sampleCurve(xCurve, playheadUs), y: sampleCurve(yCurve, playheadUs) };
  return (
    <section className="motion-spatial">
      <svg viewBox={`0 0 ${w} ${h}`} width={w} height={h} role="img" aria-label="XY motion path">
        <path d={d} fill="none" stroke={JOY_COLORS.textMuted} strokeWidth={1.5} />
        <circle cx={px(now.x)} cy={py(now.y)} r={4} fill={JOY_COLORS.accent} />
      </svg>
    </section>
  );
}

/* ─── Main export ─── */

export function MotionPanel({
  object,
  allObjects,
  compositionDurationUs,
  playheadUs,
  onSeek,
  onDispatch,
  selectedClipId,
  onAddHtmlSceneToSelection,
}: MotionPanelProps) {
  const [subtab, setSubtab] = useState<LibrarySubtab>('library');
  const [graphChannel, setGraphChannel] = useState<AnimatablePropertyV1 | undefined>(undefined);
  const [presetId, setPresetId] = useState<string>(JOY_MOTION_PRESETS[0]!.id);
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  // Was `searchOpen` plus a ref, driving an input with no value/onChange — the
  // box rendered and filtered nothing. PanelShell owns the toggle now and this
  // is the query it feeds.
  const [query, setQuery] = useState('');

  const editorContext = useContext(EditorPanelContext);
  const openMotionStudio = editorContext?.openMotionStudio ?? (() => {});

  const duration = Math.max(1, compositionDurationUs);
  const timeToX = (timeUs: number) =>
    (Math.min(duration, Math.max(0, timeUs)) / duration) * LANE_WIDTH;
  const channels = object !== undefined ? animatedChannels(object) : [];
  const activeGraph =
    object !== undefined && graphChannel !== undefined && channels.includes(graphChannel)
      ? graphChannel
      : channels[0];

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveFavorites(next);
      return next;
    });
  }, []);

  const openMotion = useCallback(
    (_id: string) => {
      openMotionStudio();
    },
    [openMotionStudio],
  );

  const duplicateMotion = useCallback((id: string) => {
    const newId = `user-${crypto.randomUUID()}`;
    const duplicated = motionRegistry.duplicate(
      id,
      newId,
      `${motionRegistry.get(id)?.name ?? 'Motion'} (Copy)`,
    );
    if (duplicated) {
      setFavorites((prev) => prev);
    }
  }, []);

  const applyPreset = () => {
    if (object === undefined) return;
    const built = buildPresetChannels(presetId, {
      startUs: Math.max(0, Math.round(playheadUs)),
      durationUs: PRESET_DURATION_US,
      base: object.transform,
    });
    const commands = Object.entries(built).map(([property, curve]) => ({
      type: 'object.replaceAnimation' as const,
      payload: { objectId: object.id, property: property as AnimatablePropertyV1, curve },
    }));
    if (commands.length > 0) onDispatch({ label: `Apply preset ${presetId}`, commands });
  };

  const setParent = (parentId: string) => {
    if (object === undefined) return;
    onDispatch({
      label: 'Set parent',
      commands: [
        {
          type: 'object.setParent',
          payload: parentId === '' ? { objectId: object.id } : { objectId: object.id, parentId },
        },
      ],
    });
  };

  const saveSpatialPath = () => {
    if (object === undefined) return;
    const xCurve = object.animations?.x;
    const yCurve = object.animations?.y;
    if (xCurve === undefined || yCurve === undefined) return;
    const samples = 48;
    const keyframes = [];
    for (let i = 0; i <= samples; i += 1) {
      const timeUs = Math.round((duration * i) / samples);
      const point = { x: sampleCurve(xCurve, timeUs), y: sampleCurve(yCurve, timeUs) };
      keyframes.push({ timeUs, point, interpolation: 'linear' as const });
    }
    const command: SetSpatialPathCommand = {
      type: 'object.setSpatialPath',
      payload: { objectId: object.id, spatialPath: { keyframes } },
    };
    onDispatch({ label: 'Save spatial path', commands: [command] });
  };

  const parentCandidates =
    object === undefined
      ? []
      : Object.values(allObjects).filter(
          (candidate) =>
            candidate.id !== object.id &&
            !parentChain(candidate.id, allObjects).some((ancestor) => ancestor.id === object.id),
        );
  const canSaveSpatial =
    object !== undefined &&
    object.animations?.x !== undefined &&
    object.animations?.y !== undefined;

  // 3c: Motion and Spatial need a selected visual clip. They keep their
  // controls on screen and disable them rather than swapping in a sentence.
  const needsSelection = subtab === 'presets' || subtab === 'spatial';
  const inactive = needsSelection && object === undefined;
  const target = object ?? IDLE_OBJECT;

  return (
    <PanelShell
      title="Motion"
      iconUrl={panelTabIconUrl('motion')}
      className="motion-panel"
      search={{ value: query, onChange: setQuery, placeholder: 'جست‌وجوی موشن‌ها…' }}
      tabs={LIBRARY_SUBTABS}
      activeTab={subtab}
      onTabChange={(id) => setSubtab(id as LibrarySubtab)}
      inactive={inactive}
      actions={
        <>
          <button
            type="button"
            className="motion-create-btn"
            aria-label="Create new motion"
            title="Create new motion"
            onClick={openMotionStudio}
          >
            <PlusIcon />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label={favoritesOnly ? 'Show all motions' : 'Show favorites only'}
            title={favoritesOnly ? 'Show all motions' : 'Show favorites only'}
            aria-pressed={favoritesOnly}
            onClick={() => setFavoritesOnly((v) => !v)}
          >
            {favoritesOnly ? <StarFilledIcon /> : <StarIcon />}
          </button>
        </>
      }
    >
      <>
        {subtab === 'library' && (
          <LibraryTab
            registry={motionRegistry}
            favorites={favorites}
            onToggleFavorite={toggleFavorite}
            onOpenMotion={openMotion}
            onDuplicate={duplicateMotion}
            favoritesOnly={favoritesOnly}
            query={query}
          />
        )}

        {subtab === 'presets' && (
          <div className="motion-presets">
            <header className="motion-presets-target">
              <span className="motion-presets-target-label">Target</span>
              <p className="motion-object-id" title={target.id}>
                {inactive ? 'Select a clip' : target.id}
              </p>
            </header>
            <div className="motion-controls motion-presets-toolbar">
              <label className="motion-field">
                Parent
                <select
                  value={target.parentId ?? ''}
                  disabled={inactive}
                  onChange={(event) => setParent(event.target.value)}
                >
                  <option value="">(none)</option>
                  {parentCandidates.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.id}
                      {candidate.kind === 'null' ? ' (null)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label className="motion-field motion-field-grow">
                Preset
                <select
                  value={presetId}
                  disabled={inactive}
                  onChange={(event) => setPresetId(event.target.value)}
                >
                  {JOY_MOTION_PRESETS.map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="field-action">
                <span className="field-action-label">Apply</span>
                <div className="field-action-row">
                  <button
                    type="button"
                    className="icon-button motion-preset-apply"
                    data-guide="Apply preset"
                    aria-label="Apply motion preset"
                    disabled={inactive}
                    onClick={applyPreset}
                  >
                    <CheckIcon />
                  </button>
                </div>
              </div>
            </div>
            <section className="motion-presets-channels" aria-label="Animation channels">
              {channels.length === 0 ? (
                <p className="motion-empty" lang="fa">
                  هنوز کی‌فریمی وجود ندارد؛ آن را در Inspector اضافه کنید یا یکی از پریست‌های بالا را
                  اعمال کنید.
                </p>
              ) : (
                <div className="motion-lanes">
                  {channels.map((channel) => {
                    const curve = target.animations![channel]!;
                    return (
                      <div key={channel} className="motion-lane">
                        <button
                          type="button"
                          className={
                            activeGraph === channel
                              ? 'motion-lane-label active'
                              : 'motion-lane-label'
                          }
                          onClick={() => setGraphChannel(channel)}
                          title="Show this channel in the graph"
                        >
                          {channel}
                        </button>
                        <svg
                          className="motion-lane-track"
                          viewBox={`0 0 ${LANE_WIDTH} 16`}
                          width={LANE_WIDTH}
                          height={16}
                          role="img"
                          aria-label={`${channel} keyframes`}
                        >
                          <line
                            x1={0}
                            y1={8}
                            x2={LANE_WIDTH}
                            y2={8}
                            stroke={JOY_COLORS.border}
                            strokeWidth={1}
                          />
                          <line
                            x1={timeToX(playheadUs)}
                            y1={0}
                            x2={timeToX(playheadUs)}
                            y2={16}
                            stroke={JOY_COLORS.accent}
                            strokeWidth={1}
                          />
                          {curve.keyframes.map((kf) => (
                            <rect
                              key={kf.timeUs}
                              x={timeToX(kf.timeUs) - 4}
                              y={4}
                              width={8}
                              height={8}
                              transform={`rotate(45 ${timeToX(kf.timeUs)} 8)`}
                              fill={JOY_COLORS.textMuted}
                              style={{ cursor: 'pointer' }}
                              onClick={() => onSeek(kf.timeUs)}
                            >
                              <title>{`${channel} @ ${(kf.timeUs / 1_000_000).toFixed(2)}s = ${kf.value}`}</title>
                            </rect>
                          ))}
                        </svg>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
            {activeGraph !== undefined && (
              <GraphEditor
                object={target}
                channel={activeGraph}
                duration={duration}
                playheadUs={playheadUs}
                onSeek={onSeek}
                onDispatch={onDispatch}
              />
            )}
          </div>
        )}

        {subtab === 'spatial' && (
          <>
            <div className="motion-spatial-actions">
              <button
                type="button"
                className="icon-button"
                data-guide="Save spatial path"
                aria-label="Save spatial path"
                title="Save spatial path"
                disabled={inactive || !canSaveSpatial}
                onClick={saveSpatialPath}
              >
                <SaveIcon />
              </button>
            </div>
            <SpatialPathPreview object={target} duration={duration} playheadUs={playheadUs} />
          </>
        )}

        {subtab === 'html-scenes' && (
          <HtmlScenesSection
            allObjects={allObjects}
            onDispatch={onDispatch}
            {...(selectedClipId !== undefined ? { selectedClipId } : {})}
            onAddHtmlSceneToSelection={onAddHtmlSceneToSelection}
          />
        )}
      </>
    </PanelShell>
  );
}
