import { useCallback, useRef, useState } from 'react';
import { UploadIcon } from './icons.js';
import type { SpikeProject } from '@joy-media/project-schema';

export interface TimelineEmptyStateProps {
  readonly project: SpikeProject;
  readonly _playheadUs: number;
  readonly compositionDurationUs: number;
  readonly viewportPixelsPerSecond: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onImportClick: () => void;
  readonly onAddFromLibrary: () => void;
  readonly onFilesDrop?: (files: readonly File[]) => void;
  readonly onAssetDrop?: (asset: {
    readonly assetId: string;
    readonly kind: string;
    readonly displayName?: string;
    readonly descriptor?: { readonly durationUs?: number; readonly mimeType?: string };
  }) => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onToast?: (message: string) => void;
}

/**
 * Minimal horizontal drop zone shown while the timeline has no clips. It sits
 * near the top of the track area as a slim dashed strip (reference image 2) and
 * does not obscure the grid/empty lanes. Clicking it opens the import dialog.
 */
export function TimelineEmptyState({
  project,
  _playheadUs,
  onImportClick,
  onAddFromLibrary,
  onFilesDrop,
  onAssetDrop,
  onContextMenu,
  onToast,
}: TimelineEmptyStateProps) {
  const [dragActive, setDragActive] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (
      !event.dataTransfer.types.includes('application/x-joy-media-asset') &&
      !event.dataTransfer.types.includes('Files')
    ) {
      return;
    }
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  }, []);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    if (dropRef.current && dropRef.current.contains(event.relatedTarget as Node)) {
      return;
    }
    setDragActive(false);
  }, []);

  const handleDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();
      setDragActive(false);
      if (
        event.dataTransfer.types.includes('application/x-joy-effect') ||
        event.dataTransfer.types.includes('application/x-joy-transition')
      ) {
        onToast?.('Add media to the timeline first, then drag the effect onto a clip.');
        return;
      }
      if (event.dataTransfer.files.length > 0) {
        onFilesDrop?.(Array.from(event.dataTransfer.files));
        return;
      }
      const raw = event.dataTransfer.getData('application/x-joy-media-asset');
      if (raw.length > 0) {
        try {
          const value: unknown = JSON.parse(raw);
          if (
            value === null ||
            typeof value !== 'object' ||
            typeof (value as { readonly assetId?: unknown }).assetId !== 'string' ||
            typeof (value as { readonly kind?: unknown }).kind !== 'string'
          )
            throw new Error('invalid media reference');
          onAssetDrop?.(
            value as {
              assetId: string;
              kind: string;
              displayName?: string;
              descriptor?: { readonly durationUs?: number; readonly mimeType?: string };
            },
          );
        } catch {
          onToast?.('The dropped media reference is invalid.');
        }
        return;
      }
      onImportClick();
    },
    [onAssetDrop, onFilesDrop, onImportClick, onToast],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu(event.clientX, event.clientY);
    },
    [onContextMenu],
  );

  const handleClick = useCallback(() => {
    onImportClick();
  }, [onImportClick]);

  const composition = project.compositions[project.rootCompositionId];
  const isTimelineEmpty =
    composition === undefined ||
    composition.tracks.length === 0 ||
    composition.tracks.every((track) => track.clips.length === 0);

  if (!isTimelineEmpty) return null;

  return (
    <div
      ref={dropRef}
      className={`timeline-empty-state ${dragActive ? 'drag-active' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onContextMenu={handleContextMenu}
      onClick={handleClick}
      role="region"
      tabIndex={0}
      aria-label="Empty timeline — drop media to start editing"
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onImportClick();
      }}
    >
      <div className="timeline-empty-strip-icon" aria-hidden="true">
        <UploadIcon />
      </div>
      <p className="timeline-empty-text">
        {dragActive ? 'Release to import media' : 'Drag media here and start creating'}
      </p>
      <div className="timeline-empty-actions">
        <button type="button" className="timeline-empty-action" onClick={onImportClick}>
          <UploadIcon />
          Import media
        </button>
        <button type="button" className="timeline-empty-action" onClick={onAddFromLibrary}>
          Browse library
        </button>
      </div>
    </div>
  );
}
