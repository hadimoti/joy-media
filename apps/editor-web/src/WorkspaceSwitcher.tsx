import { useEffect, useRef, useState } from 'react';
import type { WorkspacePresetId } from './panel-metadata.js';
import { WORKSPACE_PRESETS, workspacePresetLabel } from './workspace-presets.js';

export function WorkspaceSwitcher({
  value,
  onChange,
  onReset,
}: {
  readonly value: WorkspacePresetId;
  readonly onChange: (value: WorkspacePresetId) => void;
  readonly onReset: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const optionRefs = useRef(new Map<WorkspacePresetId, HTMLButtonElement>());

  useEffect(() => {
    if (!open) return;
    const closeOnOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
        return;
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const index = WORKSPACE_PRESETS.findIndex((preset) => preset.id === value);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? WORKSPACE_PRESETS.length - 1
            : (index + (event.key === 'ArrowDown' ? 1 : -1) + WORKSPACE_PRESETS.length) %
              WORKSPACE_PRESETS.length;
      const nextPreset = WORKSPACE_PRESETS[next];
      if (nextPreset !== undefined) optionRefs.current.get(nextPreset.id)?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', onKeyDown);
    window.setTimeout(() => optionRefs.current.get(value)?.focus(), 0);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, value]);

  return (
    <div className="workspace-switcher" ref={rootRef}>
      <button
        type="button"
        className="workspace-switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Workspace preset"
        title="Workspace preset"
        onClick={() => setOpen((current) => !current)}
      >
        <span className="workspace-switcher-label">{workspacePresetLabel(value)}</span>
        <span className="workspace-switcher-caret" aria-hidden="true">
          ⌄
        </span>
      </button>
      {open && (
        <div className="workspace-switcher-menu" role="menu" aria-label="Workspace presets">
          {WORKSPACE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              role="menuitemradio"
              aria-checked={preset.id === value}
              ref={(element) => {
                if (element === null) optionRefs.current.delete(preset.id);
                else optionRefs.current.set(preset.id, element);
              }}
              onClick={() => {
                onChange(preset.id);
                setOpen(false);
              }}
            >
              <span>
                <strong>{preset.label}</strong>
                <small>{preset.description}</small>
              </span>
              {preset.id === value && <span aria-label="Current workspace">✓</span>}
            </button>
          ))}
          <button type="button" className="workspace-switcher-reset" onClick={onReset}>
            Reset Workspace
          </button>
        </div>
      )}
    </div>
  );
}
