import { useCallback, useRef, useState } from 'react';
import { UploadIcon } from './icons.js';
import type { SpikeProject } from '@joy-media/project-schema';

export interface TimelineEmptyStateProps {
  readonly project: SpikeProject;
  readonly _playheadUs: number;
  readonly compositionDurationUs: number;
  readonly viewportPixelsPerSecond: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onImportClick: (files?: readonly File[]) => void;
  readonly onAddFromLibrary: () => void;
  readonly onContextMenu: (x: number, y: number) => void;
  readonly onToast?: (message: string) => void;
}

export function isTimelineEmptyStateActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ';
}

export function extractTimelineDroppedFiles(
  dataTransfer:
    | Pick<DataTransfer, 'types' | 'files'>
    | {
        readonly types: readonly string[];
        readonly files: FileList;
      }
    | null
    | undefined,
): File[] {
  if (dataTransfer === null || dataTransfer === undefined) return [];
  if (!dataTransfer.types.includes('Files')) return [];
  return Array.from(dataTransfer.files ?? []);
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
        onToast?.('ابتدا مدیا را به تایم‌لاین اضافه کنید، سپس افکت را روی یک کلیپ بکشید.');
        return;
      }
      const droppedFiles = extractTimelineDroppedFiles(event.dataTransfer);
      if (droppedFiles.length > 0) {
        onImportClick(droppedFiles);
        return;
      }
      onImportClick();
    },
    [onImportClick, onToast],
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onContextMenu(event.clientX, event.clientY);
    },
    [onContextMenu],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.target !== event.currentTarget) return;
      onImportClick();
    },
    [onImportClick],
  );

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
      onKeyDown={(event) => {
        if (!isTimelineEmptyStateActivationKey(event.key)) return;
        event.preventDefault();
        onImportClick();
      }}
      role="button"
      tabIndex={0}
      aria-label="Empty timeline — drop media to start editing"
    >
      <div className="timeline-empty-strip-icon" aria-hidden="true">
        <UploadIcon />
      </div>
      <p className="timeline-empty-text" lang="fa">
        {dragActive ? 'برای وارد کردن مدیا رها کنید' : 'مدیا را اینجا بکشید و ساختن را شروع کنید'}
      </p>
    </div>
  );
}
