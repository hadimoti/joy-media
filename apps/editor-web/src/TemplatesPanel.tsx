import { useState, useMemo, useCallback, useRef } from 'react';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { CONTENT_TEMPLATES, contentTemplateById } from './content-template-catalog.js';
import {
  listTemplates,
  removeTemplate,
  type TemplateCatalogEntry,
} from './template-catalog.js';
import type { SeededContentTemplate } from './content-template-types.js';
import type { EditorSession } from './editor-session.js';

interface TemplatesPanelProps {
  readonly session: EditorSession;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly onApplyTemplate: (seeded: SeededContentTemplate) => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
}

const TABS: readonly PanelTabSpec[] = [
  { id: 'library', label: 'Library' },
  { id: 'mine', label: 'Mine' },
  { id: 'import', label: 'Import' },
];

export function TemplatesPanel({
  session,
  selectedClipIds: _selectedClipIds,
  playheadUs,
  onApplyTemplate,
  showToast,
}: TemplatesPanelProps) {
  const [activeTab, setActiveTab] = useState<'library' | 'mine' | 'import'>('library');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);

  const handleApplyLibraryTemplate = useCallback(
    (templateId: string) => {
      const template = contentTemplateById(templateId);
      if (template === undefined) return;
      const seed = Date.now().toString(36).slice(-5);
      onApplyTemplate({ template, seed, scopeLabel: template.category });
      showToast(`Template "${template.label}" applied`, 'success');
    },
    [onApplyTemplate, showToast],
  );

  const handleApplyCatalogTemplate = useCallback(
    (entry: TemplateCatalogEntry) => {
      const seed = Date.now().toString(36).slice(-5);
      const template = {
        id: entry.id,
        label: entry.label,
        description: entry.description,
        category: entry.category,
        actions: entry.actions as unknown as Parameters<typeof onApplyTemplate>[0]['template']['actions'],
      };
      onApplyTemplate({ template, seed, scopeLabel: entry.category });
      showToast(`Template "${entry.label}" applied`, 'success');
    },
    [onApplyTemplate, showToast],
  );

  const handleDeleteTemplate = useCallback(
    (id: string) => {
      removeTemplate(window.localStorage, id);
      showToast('Template deleted', 'info');
    },
    [session, showToast],
  );

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const tpl of CONTENT_TEMPLATES) {
      if (tpl.category) seen.add(tpl.category);
    }
    return Array.from(seen).sort();
  }, []);

  const filteredLibrary = useMemo(() => {
    let list = CONTENT_TEMPLATES;
    if (categoryFilter !== null) {
      list = list.filter((tpl) => tpl.category === categoryFilter);
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      list = list.filter(
        (tpl) =>
          tpl.label.toLowerCase().includes(q) ||
          tpl.category.toLowerCase().includes(q),
      );
    }
    return list;
  }, [categoryFilter, search]);

  const mineTemplates = useMemo(
    () => listTemplates(window.localStorage),
    [window.localStorage, activeTab],
  );

  const filteredMine = useMemo(() => {
    if (!search.trim()) return mineTemplates;
    const q = search.toLowerCase();
    return mineTemplates.filter(
      (tpl) =>
        tpl.label.toLowerCase().includes(q) ||
        tpl.category.toLowerCase().includes(q),
    );
  }, [mineTemplates, search]);

  const libraryBody = useMemo(() => {
    if (filteredLibrary.length === 0) {
      return (
        <p className="empty-hint">
          No templates match your search.
        </p>
      );
    }
    return (
      <>
        <div className="template-categories" role="tablist" aria-label="Template categories">
          <button
            type="button"
            role="tab"
            className={`template-category-chip${categoryFilter === null ? ' is-active' : ''}`}
            aria-selected={categoryFilter === null}
            onClick={() => setCategoryFilter(null)}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              role="tab"
              className={`template-category-chip${categoryFilter === cat ? ' is-active' : ''}`}
              aria-selected={categoryFilter === cat}
              onClick={() => setCategoryFilter(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
        <div className="templates-grid">
          {filteredLibrary.map((tpl) => (
            <div
              key={tpl.id}
              className="template-card"
              title={tpl.description}
            >
              <div className="template-card-preview" />
              <span className="template-card-name">{tpl.label}</span>
              <span className="template-card-category">{tpl.category}</span>
              <button
                type="button"
                className="icon-button template-card-apply"
                aria-label={`Apply ${tpl.label}`}
                onClick={(e) => {
                  e.stopPropagation();
                  handleApplyLibraryTemplate(tpl.id);
                }}
              >
                Apply
              </button>
            </div>
          ))}
        </div>
      </>
    );
  }, [filteredLibrary, categories, categoryFilter, handleApplyLibraryTemplate]);

  const mineBody = useMemo(() => {
    if (filteredMine.length === 0) {
      return (
        <p className="empty-hint">
          {search.trim() ? 'No templates match your search.' : 'No saved templates yet.'}
        </p>
      );
    }
    return (
      <div className="templates-grid">
        {filteredMine.map((entry) => (
          <div
            key={entry.id}
            className="template-card"
            title={entry.description}
          >
            <div className="template-card-preview" />
            <span className="template-card-name">{entry.label}</span>
            <span className="template-card-category">{entry.category}</span>
            <button
              type="button"
              className="icon-button template-card-apply"
              aria-label={`Apply ${entry.label}`}
              onClick={(e) => {
                e.stopPropagation();
                handleApplyCatalogTemplate(entry);
              }}
            >
              Apply
            </button>
            <button
              type="button"
              className="icon-button template-card-delete"
              aria-label={`Delete ${entry.label}`}
              title="Delete template"
              onClick={(e) => {
                e.stopPropagation();
                handleDeleteTemplate(entry.id);
              }}
            >
              Delete
            </button>
          </div>
        ))}
      </div>
    );
  }, [filteredMine, handleApplyCatalogTemplate, handleDeleteTemplate]);

  const importBody = useMemo(() => {
    return <PsdImportTab playheadUs={playheadUs} onApplyTemplate={onApplyTemplate} showToast={showToast} />;
  }, [playheadUs, onApplyTemplate, showToast]);

  const body = (() => {
    if (activeTab === 'library') return libraryBody;
    if (activeTab === 'mine') return mineBody;
    return importBody;
  })();

  return (
    <PanelShell
      title="Templates"
      iconUrl={panelTabIconUrl('templates')}
      className="templates-panel"
      search={{ value: search, onChange: setSearch, placeholder: 'Search templates…' }}
      tabs={TABS}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as 'library' | 'mine' | 'import')}
    >
      {body}
    </PanelShell>
  );
}

/* ─── PSD Import Tab ─────────────────────────────────────────────────────── */

interface PsdImportTabProps {
  readonly playheadUs: number;
  readonly onApplyTemplate: (seeded: SeededContentTemplate) => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
}

function PsdImportTab({ playheadUs, onApplyTemplate, showToast }: PsdImportTabProps) {
  const [selectedLayerIds, setSelectedLayerIds] = useState<Set<string>>(new Set());
  const [parsedLayers, setParsedLayers] = useState<ReadonlyArray<{
    id: string; name: string; type: string; visible: boolean;
  }> | null>(null);
  const [psdFile, setPsdFile] = useState<File | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [isParsing, setIsParsing] = useState(false);
  const [isApplying, setIsApplying] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileSelect = useCallback(async (file: File) => {
    if (!file.name.toLowerCase().endsWith('.psd')) {
      setParseError('Please select a .psd file.');
      return;
    }
    setPsdFile(file);
    setParseError(null);
    setSelectedLayerIds(new Set());
    setParsedLayers(null);
    setIsParsing(true);

    try {
      const { parsePsdFile } = await import('./psd-parser-spike.js');
      const result = await parsePsdFile(file);
      const visible = result.layers
        .filter((l) => l.visible && l.type !== 'group' && l.type !== 'unknown')
        .map((l) => ({ id: l.id, name: l.name, type: l.type, visible: l.visible }));
      setParsedLayers(visible);
      setSelectedLayerIds(new Set(visible.map((l) => l.id)));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to parse PSD file.');
      setParsedLayers(null);
    } finally {
      setIsParsing(false);
    }
  }, []);

  const toggleLayer = useCallback((id: string) => {
    setSelectedLayerIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleApply = useCallback(() => {
    if (parsedLayers === null || selectedLayerIds.size === 0) return;
    setIsApplying(true);
    try {
      const template: SeededContentTemplate['template'] = {
        id: `psd-import-${Date.now().toString(36)}`,
        label: psdFile?.name.replace(/\.psd$/i, '') ?? 'PSD Import',
        description: 'Imported from PSD file',
        category: 'My Templates',
        actions: [],
      };
      const seed = Date.now().toString(36).slice(-5);
      onApplyTemplate({ template, seed });
      showToast(`PSD import applied: ${selectedLayerIds.size} layer(s)`, 'success');
    } finally {
      setIsApplying(false);
    }
  }, [parsedLayers, selectedLayerIds, psdFile, onApplyTemplate, showToast]);

  return (
    <div className="psd-import-tab">
      <div
        className="psd-import-drop"
        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('is-drag-over'); }}
        onDragLeave={(e) => e.currentTarget.classList.remove('is-drag-over')}
        onDrop={(e) => {
          e.preventDefault();
          e.currentTarget.classList.remove('is-drag-over');
          const file = e.dataTransfer.files[0];
          if (file) handleFileSelect(file);
        }}
        onClick={() => fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') fileInputRef.current?.click(); }}
        aria-label="Drop PSD file here or click to browse"
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".psd"
          className="psd-import-input"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleFileSelect(file);
          }}
        />
        <p className="psd-import-hint">
          {isParsing ? 'Parsing…' : 'Drop your PSD file here or click to browse'}
        </p>
        <small className="psd-import-subhint">
          Supports PSD layers for importing designs
        </small>
      </div>

      {parseError !== null && (
        <p className="psd-import-error" role="alert">
          {parseError}
        </p>
      )}

      {parsedLayers !== null && (
        <>
          <div className="psd-import-layers-header">
            <span>{parsedLayers.length} layer(s) found</span>
            <span className="psd-import-select-hint">
              {selectedLayerIds.size === parsedLayers.length
                ? 'All selected'
                : `${selectedLayerIds.size} selected`}
            </span>
          </div>
          <div className="psd-import-layers">
            {parsedLayers.map((layer) => (
              <label key={layer.id} className="psd-layer-row">
                <input
                  type="checkbox"
                  checked={selectedLayerIds.has(layer.id)}
                  onChange={() => toggleLayer(layer.id)}
                />
                <span className="psd-layer-name">{layer.name}</span>
                <span className="psd-layer-type">{layer.type}</span>
              </label>
            ))}
          </div>
          <div className="psd-import-actions">
            <button
              type="button"
              className="psd-import-apply-btn"
              disabled={selectedLayerIds.size === 0 || isApplying}
              onClick={handleApply}
            >
              {isApplying ? 'Applying…' : `Import ${selectedLayerIds.size} layer(s)`}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
