import { useEffect, useRef } from 'react';
import { ChevronDownIcon } from './icons.js';
import type { WorkspacePresetId } from './panel-metadata.js';
import { usePopup } from './popup-manager.js';
import { POPUP_IDS } from './popup-ids.js';
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
  // Opening this menu closes any other header popup; outside click and Escape close it (OB-18).
  const popup = usePopup(POPUP_IDS.workspaceSwitcher);
  const open = popup.open;
  const optionRefs = useRef(new Map<WorkspacePresetId, HTMLButtonElement>());

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
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
    document.addEventListener('keydown', onKeyDown);
    window.setTimeout(() => optionRefs.current.get(value)?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, value]);

  return (
    <div className="workspace-switcher" ref={popup.rootRef}>
      <button
        type="button"
        className="workspace-switcher-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Workspace preset"
        title="Workspace preset"
        onClick={(event) => popup.toggle(event.currentTarget)}
      >
        <span className="workspace-switcher-chevron" aria-hidden="true">
          <ChevronDownIcon />
        </span>
        <span className="workspace-switcher-label">{workspacePresetLabel(value)}</span>
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
                popup.close();
              }}
            >
              <span>
                <strong>{preset.label}</strong>
                <small>{preset.description}</small>
              </span>
              {preset.id === value && <span aria-label="Current workspace">✓</span>}
            </button>
          ))}
          <button
            type="button"
            className="workspace-switcher-reset"
            onClick={() => {
              popup.close();
              onReset();
            }}
          >
            Reset Workspace
          </button>
        </div>
      )}
    </div>
  );
}
