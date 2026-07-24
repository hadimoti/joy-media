import type { ReactNode } from 'react';
import {
  CutIcon,
  DuplicateIcon,
  FreezeIcon,
  SelectIcon,
  SpeedIcon,
  TrashIcon,
} from './icons.js';

export const SPEED_PRESETS = [0.5, 0.75, 1, 1.5, 2] as const;

export interface TimelineContextMenuState {
  readonly x: number;
  readonly y: number;
  readonly clipId: string;
  readonly trackId: string;
  readonly locked: boolean;
  readonly selected: boolean;
  readonly canSplit: boolean;
  readonly canSpeed: boolean;
  readonly canFreeze: boolean;
  readonly currentRate: number;
}

export function TimelineContextMenu({
  menu,
  onClose,
  onSplit,
  onDuplicate,
  onDelete,
  onFreeze,
  onToggleSelect,
  onSetRate,
}: {
  readonly menu: TimelineContextMenuState;
  readonly onClose: () => void;
  readonly onSplit: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  readonly onFreeze: () => void;
  readonly onToggleSelect: () => void;
  readonly onSetRate: (rate: number) => void;
}) {
  const locked = menu.locked;
  return (
    <>
      <button
        type="button"
        className="timeline-context-backdrop"
        aria-label="Dismiss context menu"
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        className="timeline-context-menu"
        role="menu"
        style={{ left: menu.x, top: menu.y }}
        onClick={(event) => event.stopPropagation()}
      >
        <MenuRow
          icon={<SelectIcon />}
          label={menu.selected ? 'Deselect' : 'Select'}
          onClick={() => {
            onToggleSelect();
            onClose();
          }}
        />
        <MenuRow
          icon={<CutIcon />}
          label="Split at playhead"
          disabled={locked || !menu.canSplit}
          onClick={() => {
            onSplit();
            onClose();
          }}
        />
        <MenuRow
          icon={<DuplicateIcon />}
          label="Duplicate"
          disabled={locked}
          onClick={() => {
            onDuplicate();
            onClose();
          }}
        />
        <MenuRow
          icon={<TrashIcon />}
          label="Ripple delete"
          disabled={locked}
          onClick={() => {
            onDelete();
            onClose();
          }}
        />
        <div className="timeline-context-sep" role="separator" />
        <div className="timeline-context-section" role="group" aria-label="Speed">
          <span className="timeline-context-heading">
            <SpeedIcon />
            Speed
          </span>
          <div className="timeline-context-presets">
            {SPEED_PRESETS.map((rate) => (
              <button
                key={rate}
                type="button"
                role="menuitemradio"
                aria-checked={menu.currentRate === rate}
                className="timeline-context-preset"
                disabled={locked || !menu.canSpeed}
                onClick={() => {
                  onSetRate(rate);
                  onClose();
                }}
              >
                {rate === 1 ? '1×' : `${rate}×`}
              </button>
            ))}
          </div>
        </div>
        <MenuRow
          icon={<FreezeIcon />}
          label="Freeze frame (1s)"
          disabled={locked || !menu.canFreeze}
          onClick={() => {
            onFreeze();
            onClose();
          }}
        />
      </div>
    </>
  );
}

function MenuRow({
  icon,
  label,
  disabled,
  onClick,
}: {
  readonly icon: ReactNode;
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      className="timeline-context-item"
      disabled={disabled}
      onClick={onClick}
    >
      <span className="timeline-context-icon">{icon}</span>
      {label}
    </button>
  );
}
