/**
 * Timeline Command Registry (P14.S3)
 * Central registry driving toolbar, shortcuts, and context menus.
 */

import {
  normalizePlaybackRate,
  type SpikeProject,
  type Clip,
  type Track,
} from '@joy-media/project-schema';
import type { SpikeCommand } from '@joy-media/commands';

export interface CommandContext {
  readonly project: SpikeProject;
  readonly compositionId: string;
  readonly playheadUs: number;
  readonly selectedClip: { readonly track: Track; readonly clip: Clip } | undefined;
  readonly selectedTrackIds: readonly string[];
}

export interface CommandSpec {
  readonly id: string;
  readonly label: string;
  readonly icon?: React.ComponentType<{ className?: string }>;
  readonly shortcut?: string;
  readonly group: 'playback' | 'tracks' | 'tools' | 'edit' | 'zoom';
  readonly canExecute: (ctx: CommandContext) => boolean;
  readonly execute: (ctx: CommandContext) => SpikeCommand | null;
  readonly toggleState?: (ctx: CommandContext) => boolean;
}

export type CommandGroup = CommandSpec['group'];

// --- Toolbar button icon components (inline SVG to avoid extra imports) ---
export function PlayIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}
export function PauseIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  );
}
export function SkipBackIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <polygon points="11,18 11,6 6,12" />
      <rect x="13" y="6" width="4" height="12" />
    </svg>
  );
}
export function SkipForwardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <polygon points="13,18 13,6 18,12" />
      <rect x="6" y="6" width="4" height="12" />
    </svg>
  );
}
export function TrackAddIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="16"
      height="16"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="12" y1="8" x2="12" y2="16" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}
export function MarkerIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
      <path d="M17 12V3.5L21 7.5V20.5L17 16.5V8H7V3.5L3 7.5V16.5L7 12.5V17H17Z" />
    </svg>
  );
}
export function SelectIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="16"
      height="16"
    >
      <path d="M3 3l18 18" />
      <path d="M13.73 13.73A9 9 0 1 0 10.27 10.27" />
    </svg>
  );
}
export function ScissorsIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="16"
      height="16"
    >
      <circle cx="6" cy="6" r="3" />
      <path d="M8.12 8.12 20 20" />
      <path d="M20 4 8.12 15.88" />
      <circle cx="18" cy="18" r="3" />
    </svg>
  );
}
export function DuplicateIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="16"
      height="16"
    >
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
export function ReverseIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="16"
      height="16"
    >
      <path d="M7 7h10l-3-3" />
      <path d="M17 17H7l3 3" />
      <path d="M17 7a7 7 0 0 0-7 7" />
      <path d="M7 17a7 7 0 0 0 7-7" />
    </svg>
  );
}
export function TrashIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="16"
      height="16"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
export function ZoomInIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="16"
      height="16"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="11" y1="8" x2="11" y2="14" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}
export function ZoomOutIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      width="16"
      height="16"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}
import { FitWidthIcon } from '../icons.js';
export { FitWidthIcon };

// --- Command Registry ---
export const TIMELINE_COMMANDS: readonly CommandSpec[] = [
  // PLAYBACK GROUP
  {
    id: 'playback.toggle',
    label: 'Play/Pause',
    icon: PlayIcon,
    shortcut: 'Space',
    group: 'playback',
    canExecute: () => true,
    execute: () => null, // handled by App-level togglePlayback
  },
  {
    id: 'playback.back1s',
    label: 'Back 1 second',
    icon: SkipBackIcon,
    shortcut: '←',
    group: 'playback',
    canExecute: () => true,
    execute: () => null, // handled by App-level seek
  },
  {
    id: 'playback.forward1s',
    label: 'Forward 1 second',
    icon: SkipForwardIcon,
    shortcut: '→',
    group: 'playback',
    canExecute: () => true,
    execute: () => null, // handled by App-level seek
  },

  // TRACKS GROUP
  {
    id: 'track.addVideo',
    label: 'Add video track',
    icon: TrackAddIcon,
    shortcut: 'T',
    group: 'tracks',
    canExecute: (ctx) => !!ctx.project.compositions[ctx.compositionId],
    execute: (ctx) => {
      const comp = ctx.project.compositions[ctx.compositionId];
      if (!comp) return null;
      const order = comp.tracks.length;
      return {
        type: 'timeline.addTrack',
        payload: {
          compositionId: ctx.compositionId,
          track: {
            id: `V${order + 1}`,
            kind: 'video',
            order,
            enabled: true,
            clips: [],
          },
        },
      };
    },
  },
  {
    id: 'marker.add',
    label: 'Add marker at playhead',
    icon: MarkerIcon,
    shortcut: 'M',
    group: 'tracks',
    canExecute: (ctx) => !!ctx.project.compositions[ctx.compositionId],
    execute: () => null, // handled by App-level onAddMarker
  },

  // TOOLS GROUP
  {
    id: 'tool.select',
    label: 'Select tool',
    icon: SelectIcon,
    shortcut: 'V',
    group: 'tools',
    canExecute: () => true,
    execute: () => null, // handled by toolbar state toggle
    toggleState: () => false, // handled by toolbar state
  },
  {
    id: 'tool.split',
    label: 'Split tool (razor)',
    icon: ScissorsIcon,
    shortcut: 'S',
    group: 'tools',
    canExecute: (ctx) => !!ctx.selectedClip,
    execute: (ctx) => {
      const clip = ctx.selectedClip?.clip;
      const track = ctx.selectedClip?.track;
      if (!clip || !track) return null;
      return {
        type: 'timeline.splitClip',
        payload: {
          compositionId: ctx.compositionId,
          trackId: track.id,
          clipId: clip.id,
          atUs: ctx.playheadUs,
          newClipId: `${clip.id}-split-${ctx.playheadUs}`,
        },
      };
    },
    toggleState: () => false, // handled by toolbar state
  },

  // EDIT GROUP
  {
    id: 'clip.duplicate',
    label: 'Duplicate clip',
    icon: DuplicateIcon,
    shortcut: 'Cmd/Ctrl+D',
    group: 'edit',
    canExecute: (ctx) => !!ctx.selectedClip,
    execute: (ctx) => {
      const clip = ctx.selectedClip?.clip;
      const track = ctx.selectedClip?.track;
      if (!clip || !track) return null;
      return {
        type: 'timeline.duplicateClip',
        payload: {
          compositionId: ctx.compositionId,
          trackId: track.id,
          clipId: clip.id,
          newClipId: `${clip.id}-dup-${Date.now()}`,
          newStartUs: clip.startUs + clip.durationUs,
        },
      };
    },
  },
  {
    id: 'clip.delete',
    label: 'Ripple delete',
    icon: TrashIcon,
    shortcut: 'Delete / Backspace',
    group: 'edit',
    canExecute: (ctx) => !!ctx.selectedClip,
    execute: (ctx) => {
      const clip = ctx.selectedClip?.clip;
      const track = ctx.selectedClip?.track;
      if (!clip || !track) return null;
      return {
        type: 'timeline.removeClip',
        payload: {
          compositionId: ctx.compositionId,
          trackId: track.id,
          clipId: clip.id,
        },
      };
    },
  },
  {
    id: 'clip.freezeFrame',
    label: 'Freeze frame at playhead',
    icon: ScissorsIcon,
    shortcut: 'F',
    group: 'edit',
    canExecute: (ctx) => {
      const clip = ctx.selectedClip?.clip;
      return (
        clip?.kind === 'video' &&
        ctx.playheadUs > clip.startUs &&
        ctx.playheadUs < clip.startUs + clip.durationUs
      );
    },
    execute: (ctx) => {
      const clip = ctx.selectedClip?.clip;
      const track = ctx.selectedClip?.track;
      if (!clip || !track || clip.kind !== 'video') return null;
      const holdUs = 2_000_000; // 2 seconds default
      return {
        type: 'timeline.freezeFrame',
        payload: {
          compositionId: ctx.compositionId,
          trackId: track.id,
          clipId: clip.id,
          atUs: ctx.playheadUs,
          holdUs,
          freezeClipId: `${clip.id}-freeze-${ctx.playheadUs}`,
          rightClipId: `${clip.id}-right-${ctx.playheadUs}`,
        },
      };
    },
  },
  {
    id: 'clip.reverse',
    label: 'Reverse clip',
    icon: ReverseIcon,
    group: 'edit',
    canExecute: (ctx) => {
      const clip = ctx.selectedClip?.clip;
      return clip?.kind === 'video' && normalizePlaybackRate(clip.playbackRate) !== 0;
    },
    execute: (ctx) => {
      const clip = ctx.selectedClip?.clip;
      const track = ctx.selectedClip?.track;
      if (
        !clip ||
        !track ||
        clip.kind !== 'video' ||
        normalizePlaybackRate(clip.playbackRate) === 0
      )
        return null;
      return {
        type: 'timeline.toggleClipReverse',
        payload: {
          compositionId: ctx.compositionId,
          trackId: track.id,
          clipId: clip.id,
        },
      };
    },
  },
  {
    id: 'clip.setRate',
    label: 'Set playback rate',
    icon: ZoomInIcon,
    shortcut: 'R',
    group: 'edit',
    canExecute: (ctx) => {
      const clip = ctx.selectedClip?.clip;
      return clip?.kind === 'video' && normalizePlaybackRate(clip.playbackRate) !== 0;
    },
    execute: (ctx) => {
      const clip = ctx.selectedClip?.clip;
      const track = ctx.selectedClip?.track;
      if (
        !clip ||
        !track ||
        clip.kind !== 'video' ||
        normalizePlaybackRate(clip.playbackRate) === 0
      )
        return null;
      // Return a rate of 0.5x as example - actual rate chosen via submenu
      return {
        type: 'timeline.setClipRate',
        payload: {
          compositionId: ctx.compositionId,
          trackId: track.id,
          clipId: clip.id,
          playbackRate: 0.5,
          preserveSourceRange: true,
        },
      };
    },
  },

  // ZOOM GROUP
  {
    id: 'zoom.out',
    label: 'Zoom out',
    icon: ZoomOutIcon,
    shortcut: '-',
    group: 'zoom',
    canExecute: () => true,
    execute: () => null, // handled by applyZoom
  },
  {
    id: 'zoom.in',
    label: 'Zoom in',
    icon: ZoomInIcon,
    shortcut: '=',
    group: 'zoom',
    canExecute: () => true,
    execute: () => null, // handled by applyZoom
  },
  {
    id: 'zoom.fit',
    label: 'Fit timeline to width',
    icon: FitWidthIcon,
    shortcut: 'Shift+F',
    group: 'zoom',
    canExecute: () => true,
    execute: () => null, // handled by fitToWidth
    toggleState: () => false, // handled by toolbar state
  },
];

// --- Helper: filter commands by group ---
export function getCommandsByGroup(group: CommandGroup): readonly CommandSpec[] {
  return TIMELINE_COMMANDS.filter((c) => c.group === group);
}

// --- Context menu generators ---
export interface ContextMenuItem {
  readonly label: string;
  readonly icon?: React.ComponentType<{ className?: string }>;
  readonly action?: () => void;
  readonly shortcut?: string;
  readonly disabled?: boolean;
  readonly dividerBefore?: boolean;
}

export function buildClipContextMenu(
  ctx: CommandContext,
  onExecute: (cmd: SpikeCommand) => void,
): readonly ContextMenuItem[] {
  const items: ContextMenuItem[] = [];

  // Split
  const splitCmd = TIMELINE_COMMANDS.find((c) => c.id === 'tool.split')!;
  if (splitCmd.canExecute(ctx)) {
    const result = splitCmd.execute(ctx);
    if (result) {
      items.push({
        label: 'Split at playhead',
        icon: ScissorsIcon,
        shortcut: 'S',
        action: () => onExecute(result),
      });
    }
  }

  // Duplicate
  const dupCmd = TIMELINE_COMMANDS.find((c) => c.id === 'clip.duplicate')!;
  if (dupCmd.canExecute(ctx)) {
    const result = dupCmd.execute(ctx);
    if (result) {
      items.push({
        label: 'Duplicate',
        icon: DuplicateIcon,
        shortcut: 'Cmd/Ctrl+D',
        action: () => onExecute(result),
      });
    }
  }

  items.push({ label: '', action: () => {}, dividerBefore: true });

  // Freeze frame
  const freezeCmd = TIMELINE_COMMANDS.find((c) => c.id === 'clip.freezeFrame')!;
  if (freezeCmd.canExecute(ctx)) {
    const result = freezeCmd.execute(ctx);
    if (result) {
      items.push({
        label: 'Freeze frame at playhead',
        icon: ScissorsIcon,
        shortcut: 'F',
        action: () => onExecute(result),
      });
    }
  }

  // Reverse / restore forward direction. Freeze clips deliberately omit this:
  // a locked frame has no direction and the command layer rejects it too.
  const reverseCmd = TIMELINE_COMMANDS.find((c) => c.id === 'clip.reverse')!;
  if (reverseCmd.canExecute(ctx)) {
    const result = reverseCmd.execute(ctx);
    if (result) {
      const clip = ctx.selectedClip?.clip;
      items.push({
        label:
          clip?.kind === 'video' && clip.reversed === true
            ? 'Restore forward playback'
            : 'Reverse clip',
        icon: ReverseIcon,
        action: () => onExecute(result),
      });
    }
  }

  // Set playback rate
  const rateCmd = TIMELINE_COMMANDS.find((c) => c.id === 'clip.setRate')!;
  if (rateCmd.canExecute(ctx)) {
    const result = rateCmd.execute(ctx);
    if (result) {
      items.push({
        label: 'Set playback rate…',
        icon: ZoomInIcon,
        shortcut: 'R',
        action: () => onExecute(result),
      });
    }
  }

  // Delete
  const delCmd = TIMELINE_COMMANDS.find((c) => c.id === 'clip.delete')!;
  if (delCmd.canExecute(ctx)) {
    const result = delCmd.execute(ctx);
    if (result) {
      items.push({
        label: 'Ripple delete',
        icon: TrashIcon,
        shortcut: 'Delete / Backspace',
        action: () => onExecute(result),
      });
    }
  }

  return items;
}

export function buildEmptyCanvasContextMenu(
  onImportClick: () => void,
  onAddFromLibrary: () => void,
): readonly ContextMenuItem[] {
  return [
    {
      label: 'Import Media...',
      shortcut: 'Cmd/Ctrl+I',
      action: onImportClick,
    },
    {
      label: 'Add from Library...',
      shortcut: 'L',
      action: onAddFromLibrary,
    },
  ];
}

export function buildTrackHeaderContextMenu(
  onAddTrack: () => void,
  onRemoveTrack: () => void,
  onToggleVisibility: (visible: boolean) => void,
  currentVisible: boolean,
  canRemove: boolean,
): readonly ContextMenuItem[] {
  return [
    { label: 'Add Video Track', shortcut: 'T', action: onAddTrack },
    { label: 'Remove Track', shortcut: 'Shift+T', action: onRemoveTrack, disabled: !canRemove },
    { label: '', action: () => {}, dividerBefore: true },
    {
      label: currentVisible ? 'Hide Track' : 'Show Track',
      shortcut: 'E',
      action: () => onToggleVisibility(!currentVisible),
    },
  ];
}

export function buildRulerContextMenu(
  onAddMarker: (timeUs: number) => void,
  timeUs: number,
): readonly ContextMenuItem[] {
  return [
    {
      label: `Add Marker at ${formatTimecode(timeUs)}`,
      shortcut: 'M',
      action: () => onAddMarker(timeUs),
    },
  ];
}

function formatTimecode(us: number): string {
  const totalSec = Math.floor(us / 1_000_000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const frames = Math.floor((us % 1_000_000) / 33333); // ~30fps
  return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}:${frames.toString().padStart(2, '0')}`;
}
