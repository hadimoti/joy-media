import { useEffect, useId, useRef, useState } from 'react';
import { AspectRatioIcon, CloseIcon } from './icons.js';

/**
 * `fit` deliberately has no CSS aspect-ratio value. It leaves the monitor in
 * its existing contain/fit behavior until a composition ratio is selected.
 */
export type MonitorAspectRatio =
  'fit' | '16:9' | '4:3' | '3:2' | '21:9' | '1:1' | '9:16' | '4:5' | '3:4' | '2:3';

export interface MonitorAspectRatioPreset {
  readonly id: MonitorAspectRatio;
  readonly label: string;
  readonly cssAspectRatio?: string;
  readonly group: 'Landscape' | 'Square' | 'Portrait';
}

export const DEFAULT_MONITOR_ASPECT_RATIO: MonitorAspectRatio = 'fit';

export const MONITOR_ASPECT_RATIO_PRESETS: readonly MonitorAspectRatioPreset[] = [
  { id: 'fit', label: 'Fit', group: 'Landscape' },
  { id: '16:9', label: '16:9', cssAspectRatio: '16 / 9', group: 'Landscape' },
  { id: '4:3', label: '4:3', cssAspectRatio: '4 / 3', group: 'Landscape' },
  { id: '3:2', label: '3:2', cssAspectRatio: '3 / 2', group: 'Landscape' },
  { id: '21:9', label: '21:9', cssAspectRatio: '21 / 9', group: 'Landscape' },
  { id: '1:1', label: '1:1', cssAspectRatio: '1 / 1', group: 'Square' },
  { id: '9:16', label: '9:16', cssAspectRatio: '9 / 16', group: 'Portrait' },
  { id: '4:5', label: '4:5', cssAspectRatio: '4 / 5', group: 'Portrait' },
  { id: '3:4', label: '3:4', cssAspectRatio: '3 / 4', group: 'Portrait' },
  { id: '2:3', label: '2:3', cssAspectRatio: '2 / 3', group: 'Portrait' },
] as const;

/** Returns a CSS-safe ratio for the monitor canvas or `undefined` for Fit. */
export function monitorAspectRatioCssValue(value: MonitorAspectRatio): string | undefined {
  return MONITOR_ASPECT_RATIO_PRESETS.find((preset) => preset.id === value)?.cssAspectRatio;
}

export function monitorAspectRatioLabel(value: MonitorAspectRatio): string {
  return MONITOR_ASPECT_RATIO_PRESETS.find((preset) => preset.id === value)?.label ?? 'Fit';
}

/**
 * Canonical project canvas dimensions for each authored ratio. `fit` is a
 * monitor-only view choice and therefore deliberately leaves documents alone.
 */
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

/**
 * Returns the authored preset represented by a canvas size. This keeps a
 * controlled monitor selector in sync after Undo, Redo, reload, or an edit
 * made from another surface. Custom dimensions intentionally report Fit: the
 * footer must never claim a preset that is not actually persisted.
 */
export function monitorAspectRatioForDimensions(width: number, height: number): MonitorAspectRatio {
  for (const preset of MONITOR_ASPECT_RATIO_PRESETS) {
    const dimensions = monitorAspectRatioDimensions(preset.id);
    if (dimensions?.width === width && dimensions.height === height) return preset.id;
  }
  return 'fit';
}

export interface MonitorAspectRatioSelectorProps {
  /** Controlled selection. Omit to retain the component's Fit-default selection. */
  readonly selectedAspectRatio?: MonitorAspectRatio;
  /** Initial value for an uncontrolled selector. Defaults to Fit. */
  readonly defaultAspectRatio?: MonitorAspectRatio;
  /** Called after a user chooses a ratio; Fit reports `fit`. */
  readonly onAspectRatioChange?: (aspectRatio: MonitorAspectRatio) => void;
  /** Authored canvas dimensions shown so view state is not confused with project state. */
  readonly authoredWidth?: number;
  readonly authoredHeight?: number;
}

const GROUPS = ['Landscape', 'Square', 'Portrait'] as const;

/**
 * Compact Program Monitor footer selector. The caller owns the actual
 * composition/canvas resize; this component only owns the accessible UI and
 * reports a stable preset ID through `onAspectRatioChange`.
 */
export function MonitorAspectRatioSelector({
  selectedAspectRatio,
  defaultAspectRatio = DEFAULT_MONITOR_ASPECT_RATIO,
  onAspectRatioChange,
  authoredWidth,
  authoredHeight,
}: MonitorAspectRatioSelectorProps) {
  const [uncontrolledAspectRatio, setUncontrolledAspectRatio] = useState(defaultAspectRatio);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();
  const aspectRatio = selectedAspectRatio ?? uncontrolledAspectRatio;
  const currentLabel = monitorAspectRatioLabel(aspectRatio);
  const orientation =
    authoredWidth === undefined || authoredHeight === undefined
      ? undefined
      : authoredWidth === authoredHeight
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
    const wrappedIndex = (nextIndex + options.length) % options.length;
    options[wrappedIndex]?.focus();
  };

  const openMenu = () => {
    setOpen(true);
    window.requestAnimationFrame(() => {
      const currentIndex = MONITOR_ASPECT_RATIO_PRESETS.findIndex(
        (preset) => preset.id === aspectRatio,
      );
      focusOption(currentIndex < 0 ? 0 : currentIndex);
    });
  };

  const selectAspectRatio = (nextAspectRatio: MonitorAspectRatio) => {
    if (selectedAspectRatio === undefined) setUncontrolledAspectRatio(nextAspectRatio);
    onAspectRatioChange?.(nextAspectRatio);
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
        aria-pressed={open}
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
          {currentLabel}
          {authoredWidth !== undefined && authoredHeight !== undefined
            ? ` · ${authoredWidth}×${authoredHeight}`
            : ''}
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
              {currentLabel}
              {authoredWidth !== undefined && authoredHeight !== undefined
                ? ` · ${authoredWidth}×${authoredHeight}`
                : ''}
              {orientation === undefined ? '' : ` · ${orientation}`}
            </span>
          </div>
          <button
            type="button"
            className="monitor-transport-btn"
            aria-label="Close aspect ratio options"
            title="Close"
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
              aria-checked={aspectRatio === 'fit'}
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
          if (presets.length === 0) return null;
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
                      aria-checked={aspectRatio === preset.id}
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
