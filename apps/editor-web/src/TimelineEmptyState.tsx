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
}

export function TimelineEmptyState({
  project,
  _playheadUs,
  compositionDurationUs,
  viewportPixelsPerSecond,
  onSeek,
  onImportClick,
  onAddFromLibrary,
}: TimelineEmptyStateProps) {
  const [dragActive, setDragActive] = useState(false);
  const dropRef = useRef<HTMLDivElement>(null);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    if (!event.dataTransfer.types.includes('application/x-joy-media-asset') &&
        !event.dataTransfer.types.includes('Files')) {
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

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    onImportClick();
  }, [onImportClick]);

  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    (window as unknown as { __timelineEmptyContextMenu?: (x: number, y: number) => void }).__timelineEmptyContextMenu?.(event.clientX, event.clientY);
  }, []);

  const handleClick = useCallback((event: React.MouseEvent) => {
    if (event.target !== event.currentTarget) return;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const localX = event.clientX - rect.left;
    const pxPerUs = viewportPixelsPerSecond / 1_000_000;
    const timeUs = Math.max(0, Math.min(compositionDurationUs, localX / pxPerUs));
    onSeek(timeUs);
  }, [compositionDurationUs, viewportPixelsPerSecond, onSeek]);

  const composition = project.compositions[project.rootCompositionId];
  const isTimelineEmpty = composition === undefined || composition.tracks.length === 0 || composition.tracks.every(track => track.clips.length === 0);

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
      role="button"
      tabIndex={0}
      aria-label="Empty timeline — drop media to start editing"
    >
      <div className="timeline-empty-content">
        <div className="timeline-empty-icon" aria-hidden="true">
          <UploadIcon />
        </div>
        <p className="timeline-empty-text">Drag media here to start editing</p>
        <div className="timeline-empty-actions">
          <button
            type="button"
            className="timeline-empty-btn primary"
            onClick={(e) => { e.stopPropagation(); onImportClick(); }}
            aria-label="Import media files"
          >
            Import Media
          </button>
          <button
            type="button"
            className="timeline-empty-btn secondary"
            onClick={(e) => { e.stopPropagation(); onAddFromLibrary(); }}
            aria-label="Add from media library"
          >
            Add from Library
          </button>
        </div>
        <p className="timeline-empty-hint">
          Supports video, audio, images, and subtitles
        </p>
      </div>
    </div>
  );
}
