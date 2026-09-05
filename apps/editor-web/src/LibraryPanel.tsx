import { useCallback, useState } from 'react';
import type { SeededContentTemplate } from './content-template-types.js';
import { TemplatesPanel } from './TemplatesPanel.js';
import { MyMotionsTab } from './MotionPanel.js';
import {
  createMotionScene,
  duplicateMotionScene,
  listCatalogScenes,
  removeCatalogScene,
  renameMotionScene,
} from './motion-scene-catalog.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';

export interface LibraryPanelProps {
  readonly onApplyTemplate: (seeded: SeededContentTemplate) => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
  readonly openMotionStudio: (sceneId: string) => void;
  /**
   * The root writer gate supplies this guarded adapter. Motion scenes and
   * authored templates are project data, so this panel must never reach for
   * raw browser storage after a tab has lost writer authority.
   */
  readonly storage: BrowserKeyValueStore;
}

type LibraryView = 'templates' | 'motions';

/** Shared home for reusable templates and user-authored Motion scenes. */
export function LibraryPanel({
  onApplyTemplate,
  showToast,
  openMotionStudio,
  storage,
}: LibraryPanelProps) {
  const [view, setView] = useState<LibraryView>('templates');
  const [, setRevision] = useState(0);
  const entries = listCatalogScenes(storage);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const createMotion = useCallback(() => {
    const scene = createMotionScene(storage, `Untitled Motion ${entries.length + 1}`);
    refresh();
    openMotionStudio(scene.id);
  }, [entries.length, openMotionStudio, refresh, storage]);

  return (
    <PanelShell title="Library" iconUrl={panelTabIconUrl('templates')} className="library-panel">
      <div className="library-panel-tabs" role="tablist" aria-label="Library sections">
        <button
          type="button"
          role="tab"
          aria-selected={view === 'templates'}
          onClick={() => setView('templates')}
        >
          Templates
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={view === 'motions'}
          onClick={() => setView('motions')}
        >
          My Motions
        </button>
      </div>
      {view === 'templates' ? (
        <TemplatesPanel onApplyTemplate={onApplyTemplate} showToast={showToast} storage={storage} />
      ) : (
        <div className="library-motions-view">
          <div className="library-motions-toolbar">
            <span>Reusable motion scenes</span>
            <button type="button" onClick={createMotion}>
              + New motion
            </button>
          </div>
          <MyMotionsTab
            entries={entries}
            onOpen={openMotionStudio}
            onRename={(id, title) => {
              renameMotionScene(storage, id, title);
              refresh();
            }}
            onDuplicate={(id) => {
              const source = entries.find((entry) => entry.id === id);
              duplicateMotionScene(storage, id, `${source?.title ?? 'Motion'} (Copy)`);
              refresh();
            }}
            onDelete={(id) => {
              removeCatalogScene(storage, id);
              refresh();
            }}
          />
        </div>
      )}
    </PanelShell>
  );
}
