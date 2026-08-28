import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { EditorSession } from './editor-session.js';
import { AspectRatioIcon, CloseIcon } from './icons.js';

export type MonitorAspectRatio =
  'fit' | '16:9' | '4:3' | '3:2' | '21:9' | '1:1' | '9:16' | '4:5' | '3:4' | '2:3';

export interface MonitorAspectRatioPreset {
  readonly id: MonitorAspectRatio;
  readonly label: string;
  readonly group: 'Landscape' | 'Square' | 'Portrait';
}

export const MONITOR_ASPECT_RATIO_PRESETS: readonly MonitorAspectRatioPreset[] = [
  { id: 'fit', label: 'Fit', group: 'Landscape' },
  { id: '16:9', label: '16:9', group: 'Landscape' },
  { id: '4:3', label: '4:3', group: 'Landscape' },
  { id: '3:2', label: '3:2', group: 'Landscape' },
  { id: '21:9', label: '21:9', group: 'Landscape' },
  { id: '1:1', label: '1:1', group: 'Square' },
  { id: '9:16', label: '9:16', group: 'Portrait' },
  { id: '4:5', label: '4:5', group: 'Portrait' },
  { id: '3:4', label: '3:4', group: 'Portrait' },
  { id: '2:3', label: '2:3', group: 'Portrait' },
] as const;

export function monitorAspectRatioDimensions(
  value: MonitorAspectRatio,
): { readonly width: number; readonly height: number } | undefined {
  switch (value) {
    case '16:9':
      return { width: 1920, height: 1080 };
    case '4:3':
      return { width: 1440, height: 1080 };
    case '3:2':
      return { width: 1620, height: 1080 };
    case '21:9':
      return { width: 2520, height: 1080 };
    case '1:1':
      return { width: 1080, height: 1080 };
    case '9:16':
      return { width: 1080, height: 1920 };
    case '4:5':
      return { width: 1080, height: 1350 };
    case '3:4':
      return { width: 1080, height: 1440 };
    case '2:3':
      return { width: 1080, height: 1620 };
    case 'fit':
      return undefined;
  }
}

export function monitorAspectRatioForDimensions(width: number, height: number): MonitorAspectRatio {
  for (const preset of MONITOR_ASPECT_RATIO_PRESETS) {
    const dimensions = monitorAspectRatioDimensions(preset.id);
    if (dimensions?.width === width && dimensions.height === height) return preset.id;
  }
  return 'fit';
}

export interface MonitorAspectRatioSelectorProps {
  readonly selectedAspectRatio: MonitorAspectRatio;
  readonly onAspectRatioChange: (aspectRatio: MonitorAspectRatio) => void;
  readonly authoredWidth: number;
  readonly authoredHeight: number;
}

export interface MonitorAspectRatioControlProps {
  readonly session: EditorSession;
  readonly visualProject: JoyProjectV1;
  readonly timelineProject: SpikeProject;
  readonly bumpProjectRevision: () => void;
  readonly showToast: (message: string, kind: 'success' | 'error') => void;
}

const GROUPS = ['Landscape', 'Square', 'Portrait'] as const;

/** Mounted controller that binds the selector to the editor's compound history. */
export function MonitorAspectRatioControl({
  session,
  visualProject,
  timelineProject,
  bumpProjectRevision,
  showToast,
}: MonitorAspectRatioControlProps) {
  const [fitView, setFitView] = useState(false);
  const visualComposition = visualProject.compositions[visualProject.rootCompositionId];
  const width = visualComposition?.width ?? 1080;
  const height = visualComposition?.height ?? 1920;
  const selectedAspectRatio = fitView ? 'fit' : monitorAspectRatioForDimensions(width, height);

  const changeAspectRatio = useCallback(
    (nextAspectRatio: MonitorAspectRatio) => {
      const dimensions = monitorAspectRatioDimensions(nextAspectRatio);
      if (dimensions === undefined) {
        setFitView(true);
        return;
      }
      const visualRoot = visualProject.compositions[visualProject.rootCompositionId];
      const timelineRoot = timelineProject.compositions[timelineProject.rootCompositionId];
      if (visualRoot === undefined || timelineRoot === undefined) {
        showToast('The root composition is unavailable for this canvas change.', 'error');
        return;
      }
      if (
        visualRoot.width === dimensions.width &&
        visualRoot.height === dimensions.height &&
        timelineRoot.width === dimensions.width &&
        timelineRoot.height === dimensions.height
      ) {
        setFitView(false);
        return;
      }
      const label = `Change canvas aspect ratio to ${nextAspectRatio}`;
      try {
        session.dispatchCompound(label, {
          document: {
            ...visualProject,
            updatedAt: new Date().toISOString(),
            compositions: {
              ...visualProject.compositions,
              [visualRoot.id]: {
                ...visualRoot,
                width: dimensions.width,
                height: dimensions.height,
              },
            },
          },
          timeline: {
            label,
            commands: [
              {
                type: 'timeline.setCompositionDimensions',
                payload: {
                  compositionId: timelineRoot.id,
                  width: dimensions.width,
                  height: dimensions.height,
                },
              },
            ],
          },
        });
        setFitView(false);
        bumpProjectRevision();
        showToast(`Canvas changed to ${nextAspectRatio}.`, 'success');
      } catch (reason) {
        showToast(
          `Could not change canvas aspect ratio: ${
            reason instanceof Error ? reason.message : String(reason)
          }`,
          'error',
        );
      }
    },
    [bumpProjectRevision, session, showToast, timelineProject, visualProject],
  );

  return (
    <MonitorAspectRatioSelector
      selectedAspectRatio={selectedAspectRatio}
      authoredWidth={width}
      authoredHeight={height}
      onAspectRatioChange={changeAspectRatio}
    />
  );
}

export function MonitorAspectRatioSelector({
  selectedAspectRatio,
  onAspectRatioChange,
  authoredWidth,
  authoredHeight,
}: MonitorAspectRatioSelectorProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const currentLabel =
    MONITOR_ASPECT_RATIO_PRESETS.find((preset) => preset.id === selectedAspectRatio)?.label ??
    'Fit';
  const orientation =
    authoredWidth === authoredHeight
      ? 'Square'
      : authoredWidth > authoredHeight
        ? 'Landscape'
        : 'Portrait';

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const focusOption = (nextIndex: number) => {
    const options = rootRef.current?.querySelectorAll<HTMLButtonElement>(
      '[data-monitor-aspect-ratio-option]',
    );
    if (options === undefined || options.length === 0) return;
    options[(nextIndex + options.length) % options.length]?.focus();
  };

  const openMenu = () => {
    setOpen(true);
    window.requestAnimationFrame(() => {
      const currentIndex = MONITOR_ASPECT_RATIO_PRESETS.findIndex(
        (preset) => preset.id === selectedAspectRatio,
      );
      focusOption(currentIndex < 0 ? 0 : currentIndex);
    });
  };

  const selectAspectRatio = (nextAspectRatio: MonitorAspectRatio) => {
    onAspectRatioChange(nextAspectRatio);
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const handleOptionKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusOption(index + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusOption(index - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusOption(0);
        break;
      case 'End':
        event.preventDefault();
        focusOption(MONITOR_ASPECT_RATIO_PRESETS.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
        break;
    }
  };

  return (
    <div className="monitor-aspect-ratio" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="monitor-transport-btn"
        aria-label={`Canvas aspect ratio (${currentLabel})`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        data-guide="Ratio"
        onClick={() => (open ? setOpen(false) : openMenu())}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
          event.preventDefault();
          openMenu();
        }}
      >
        <AspectRatioIcon />
        <span className="monitor-aspect-ratio-trigger-details" aria-hidden="true">
          {currentLabel} · {authoredWidth}×{authoredHeight}
        </span>
      </button>
      <div
        className="monitor-aspect-ratio-drawer"
        id={menuId}
        role="menu"
        aria-label="Canvas aspect ratio"
        hidden={!open}
      >
        <div className="monitor-aspect-ratio-drawer-head">
          <div>
            <strong>Canvas format</strong>
            <span className="monitor-aspect-ratio-current">
              {currentLabel} · {authoredWidth}×{authoredHeight} · {orientation}
            </span>
          </div>
          <button
            type="button"
            className="monitor-transport-btn"
            aria-label="Close aspect ratio options"
            onClick={() => {
              setOpen(false);
              triggerRef.current?.focus();
            }}
          >
            <CloseIcon />
          </button>
        </div>
        <div
          className="monitor-aspect-ratio-group monitor-preview-only"
          role="group"
          aria-label="Preview — view only"
        >
          <span className="monitor-aspect-ratio-group-label">Preview — view only</span>
          <div className="monitor-aspect-ratio-options">
            <button
              type="button"
              role="menuitemradio"
              className="monitor-aspect-ratio-option"
              aria-checked={selectedAspectRatio === 'fit'}
              data-monitor-aspect-ratio-option="fit"
              onClick={() => selectAspectRatio('fit')}
              onKeyDown={(event) => handleOptionKeyDown(event, 0)}
            >
              Fit
            </button>
          </div>
        </div>
        <p className="monitor-aspect-ratio-authored-note">
          Canvas format — changes project/export; undoable
        </p>
        {GROUPS.map((group) => {
          const presets = MONITOR_ASPECT_RATIO_PRESETS.filter(
            (preset) => preset.group === group && preset.id !== 'fit',
          );
          return (
            <div key={group} className="monitor-aspect-ratio-group" role="group" aria-label={group}>
              <span className="monitor-aspect-ratio-group-label">{group}</span>
              <div className="monitor-aspect-ratio-options">
                {presets.map((preset) => {
                  const index = MONITOR_ASPECT_RATIO_PRESETS.findIndex(
                    (candidate) => candidate.id === preset.id,
                  );
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      role="menuitemradio"
                      className="monitor-aspect-ratio-option"
                      aria-checked={selectedAspectRatio === preset.id}
                      data-monitor-aspect-ratio-option={preset.id}
                      onClick={() => selectAspectRatio(preset.id)}
                      onKeyDown={(event) => handleOptionKeyDown(event, index)}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
