import { useEffect, useMemo, useState } from 'react';
import type {
  JoyProjectV1,
  TextDocumentV1,
  TextRunV1,
  TextStyleV1,
  VisualObjectV1,
} from '@joy-media/project-schema';
import {
  CONTENT_FONT_CATALOG,
  DEFAULT_TEXT_STYLE_V1,
  canonicalizeContentFontFamily,
  resolveContentFontFamily,
  textDocumentToString,
} from '@joy-media/project-schema';
import { PanelShell } from './PanelShell.js';
import { PropertyRow } from './components/PropertyRow.js';
import { TextTabIcon } from './icons.js';
import { resolveObjectIdForSelection } from './sticker-bindings.js';
import { TEXT_TEMPLATES, type TextTemplateV1 } from './text-template-catalog.js';
import { insertTextTemplate } from './text-template-transaction.js';
import type { EditorSession } from './editor-session.js';
import { getPageFontCatalogSession, type FontCatalogEntry } from './font-catalog.js';

type TextTab = 'templates' | 'edit';
type TextCategory = 'All' | TextTemplateV1['category'];

const CATEGORIES: readonly TextCategory[] = [
  'All',
  'Titles',
  'Lower thirds',
  'Highlights',
  'Social',
];
export function TextPanel({
  project,
  session,
  selectedIds,
  playheadUs,
  onSelectClip,
  onProjectChange,
  onProjectRevision,
}: {
  readonly project: JoyProjectV1;
  readonly session: EditorSession;
  readonly selectedIds: readonly string[];
  readonly playheadUs: number;
  readonly onSelectClip: (clipIds: readonly string[]) => void;
  readonly onProjectChange: (project: JoyProjectV1) => void;
  readonly onProjectRevision: () => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<TextCategory>('All');
  const [activeTab, setActiveTab] = useState<TextTab>('templates');
  const objectId = resolveTextObjectId(project, selectedIds);
  const selectedObject = objectId === undefined ? undefined : project.visualObjects[objectId];
  const selectedText = selectedObject?.kind === 'text' ? selectedObject : undefined;

  useEffect(() => {
    if (selectedText === undefined && activeTab === 'edit') setActiveTab('templates');
  }, [activeTab, selectedText]);

  const filteredTemplates = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return TEXT_TEMPLATES.filter((template) => {
      if (category !== 'All' && template.category !== category) return false;
      if (normalized.length === 0) return true;
      return `${template.label} ${template.description} ${template.sample}`
        .toLowerCase()
        .includes(normalized);
    });
  }, [category, query]);

  const addTemplate = (template: TextTemplateV1) => {
    const inserted = insertTextTemplate(session, template, playheadUs);
    if (inserted === undefined) return;
    onSelectClip([inserted.clipId]);
    onProjectRevision();
    setActiveTab('edit');
  };

  return (
    <PanelShell
      title="Text"
      icon={<TextTabIcon />}
      className="text-panel"
      search={{ value: query, onChange: setQuery, placeholder: 'Search text templates…' }}
      tabs={[
        { id: 'templates', label: 'Templates' },
        { id: 'edit', label: 'Edit', disabled: selectedText === undefined },
      ]}
      activeTab={activeTab}
      onTabChange={(id) => setActiveTab(id as TextTab)}
    >
      {activeTab === 'templates' ? (
        <section className="text-templates-view" aria-label="Text templates">
          <div className="text-category-row" role="tablist" aria-label="Text template categories">
            {CATEGORIES.map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={category === item}
                className="text-category-button"
                onClick={() => setCategory(item)}
              >
                {item}
              </button>
            ))}
          </div>
          <div className="text-template-grid">
            {filteredTemplates.map((template) => (
              <button
                key={template.id}
                type="button"
                className="text-template-card"
                aria-label={`Add ${template.label}`}
                onClick={() => addTemplate(template)}
              >
                <TemplatePreview template={template} />
                <span className="text-template-card-label">{template.label}</span>
                <span className="text-template-card-description">{template.description}</span>
              </button>
            ))}
          </div>
          {filteredTemplates.length === 0 && (
            <p className="text-empty-hint">No text templates match this search.</p>
          )}
        </section>
      ) : selectedText === undefined ? (
        <section className="text-empty-state">
          <TextTabIcon />
          <p>Select a text item to edit it.</p>
        </section>
      ) : (
        <TextEditor
          object={selectedText}
          onChange={(next) =>
            onProjectChange({
              ...project,
              visualObjects: { ...project.visualObjects, [next.id]: next },
            })
          }
        />
      )}
    </PanelShell>
  );
}

function TemplatePreview({ template }: { readonly template: TextTemplateV1 }) {
  const fill = template.style.fill;
  const background =
    fill.kind === 'linear-gradient'
      ? `linear-gradient(${fill.angleDeg}deg, ${fill.stops.map((stop) => `${stop.color} ${Math.round(stop.offset * 100)}%`).join(', ')})`
      : undefined;
  return (
    <span
      className="text-template-preview"
      dir={template.style.direction === 'rtl' ? 'rtl' : 'auto'}
      style={{
        color: fill.kind === 'solid' ? fill.color : fill.stops[0]?.color,
        backgroundImage: background,
        fontFamily: resolveContentFontFamily(template.style.fontFamily),
        fontSize: `${Math.max(0.68, Math.min(1.2, template.style.fontSizePx / 96))}rem`,
        fontStyle: template.style.italic ? 'italic' : 'normal',
        fontWeight: template.style.fontWeight,
        letterSpacing: `${Math.min(2, template.style.tracking / 4)}px`,
        textShadow:
          template.style.glow === undefined
            ? undefined
            : `0 0 ${template.style.glow.radiusPx / 3}px ${template.style.glow.color}`,
      }}
    >
      {template.sample}
    </span>
  );
}

function TextEditor({
  object,
  onChange,
}: {
  readonly object: VisualObjectV1;
  readonly onChange: (next: VisualObjectV1) => void;
}) {
  const document = useMemo(
    () =>
      object.textDocument ?? {
        version: 1 as const,
        blocks: [{ id: 'text-block-1', runs: [{ text: object.text ?? '' }] }],
      },
    [object.text, object.textDocument],
  );
  const style = object.textStyle ?? DEFAULT_TEXT_STYLE_V1;
  const [draftText, setDraftText] = useState(textDocumentToString(document));
  const fontCatalogSession = useMemo(() => getPageFontCatalogSession(), []);
  const [fontCatalogKey, setFontCatalogKey] = useState('');
  const [fontCatalogEntries, setFontCatalogEntries] = useState<readonly FontCatalogEntry[]>(
    () => fontCatalogSession.localEntries,
  );
  const [fontCatalogBusy, setFontCatalogBusy] = useState(false);
  const [fontCatalogStatus, setFontCatalogStatus] = useState('');
  const bundledFontCount = fontCatalogEntries.filter((entry) => entry.bundled).length;
  const discoveredFontEntries = fontCatalogEntries.slice(fontCatalogSession.localEntries.length);
  useEffect(() => setDraftText(textDocumentToString(document)), [document]);
  useEffect(() => {
    if (fontCatalogSession.hasGoogleApiKey()) {
      setFontCatalogStatus('Google Fonts key is active for this page session.');
    }
  }, [fontCatalogSession]);

  const discoverFontCatalog = async (): Promise<void> => {
    // Keep a previously entered page-session key when a panel remounts. The
    // only way to remove it is the explicit Clear action below.
    if (fontCatalogKey.trim().length > 0) fontCatalogSession.setGoogleApiKey(fontCatalogKey);
    setFontCatalogBusy(true);
    setFontCatalogStatus('Discovering Google Fonts metadata…');
    try {
      const entries = await fontCatalogSession.discoverGoogleFonts();
      setFontCatalogEntries(entries);
      const remoteCount = entries.length - fontCatalogSession.localEntries.length;
      setFontCatalogStatus(
        remoteCount > 0
          ? `${remoteCount} metadata families found. Only bundled families can be applied safely.`
          : 'Local catalog ready. Add a Google Fonts key to discover metadata.',
      );
    } catch {
      setFontCatalogStatus('Catalog discovery failed. Check the key or try again.');
    } finally {
      setFontCatalogBusy(false);
    }
  };

  const clearFontCatalogKey = (): void => {
    fontCatalogSession.clearGoogleApiKey();
    setFontCatalogKey('');
    setFontCatalogEntries(fontCatalogSession.localEntries);
    setFontCatalogStatus('Google Fonts key cleared from this page session.');
  };

  const update = (patch: Partial<TextStyleV1>) =>
    onChange({ ...object, textStyle: { ...style, ...patch } });
  const updateDocument = (nextDocument: TextDocumentV1) =>
    onChange({ ...object, text: textDocumentToString(nextDocument), textDocument: nextDocument });
  const updateRuns = (
    mapper: (
      run: TextDocumentV1['blocks'][number]['runs'][number],
    ) => TextDocumentV1['blocks'][number]['runs'][number],
  ) =>
    updateDocument({
      ...document,
      blocks: document.blocks.map((block) => ({ ...block, runs: block.runs.map(mapper) })),
    });

  const fill = style.fill;
  const solidColor = fill.kind === 'solid' ? fill.color : (fill.stops[0]?.color ?? '#ffffff');
  const secondGradientColor =
    fill.kind === 'linear-gradient'
      ? (fill.stops[fill.stops.length - 1]?.color ?? '#f6c453')
      : '#f6c453';

  return (
    <section className="text-editor-view" aria-label="Edit text">
      <section className="text-editor-section">
        <h4>Content</h4>
        <textarea
          value={draftText}
          dir={style.direction === 'rtl' ? 'rtl' : 'auto'}
          aria-label="Text content"
          onChange={(event) => setDraftText(event.currentTarget.value)}
          onBlur={() =>
            updateDocument({
              version: 1,
              blocks: [
                { id: document.blocks[0]?.id ?? 'text-block-1', runs: [{ text: draftText }] },
              ],
            })
          }
        />
        <div className="text-highlight-actions">
          <button
            type="button"
            className="text-inline-action"
            onClick={() =>
              updateRuns((run) => ({
                ...run,
                style: { ...(run.style ?? {}), highlightColor: '#f6c453' },
              }))
            }
          >
            Highlight runs
          </button>
          <button
            type="button"
            className="text-inline-action"
            onClick={() =>
              updateRuns((run) => {
                if (run.style === undefined) return run;
                const nextStyle = { ...run.style };
                delete nextStyle.highlightColor;
                return Object.keys(nextStyle).length > 0
                  ? ({ text: run.text, style: nextStyle } satisfies TextRunV1)
                  : ({ text: run.text } satisfies TextRunV1);
              })
            }
          >
            Clear highlights
          </button>
        </div>
      </section>
      <section className="text-editor-section">
        <h4>Typography</h4>
        <label className="text-editor-row">
          <span>Font</span>
          <select
            value={canonicalizeContentFontFamily(style.fontFamily)}
            onChange={(event) => update({ fontFamily: event.currentTarget.value })}
          >
            {CONTENT_FONT_CATALOG.map((font) => (
              <option key={font.family} value={font.family}>
                {font.label} · {font.scripts}
              </option>
            ))}
          </select>
        </label>
        <PropertyRow label="Size" value={`${Math.round(style.fontSizePx)}px`}>
          <input
            type="range"
            min={24}
            max={220}
            value={style.fontSizePx}
            onChange={(event) => update({ fontSizePx: event.currentTarget.valueAsNumber })}
          />
        </PropertyRow>
        <PropertyRow label="Weight" value={String(style.fontWeight)}>
          <input
            type="range"
            min={300}
            max={900}
            step={50}
            value={style.fontWeight}
            onChange={(event) => update({ fontWeight: event.currentTarget.valueAsNumber })}
          />
        </PropertyRow>
        <label className="text-editor-row">
          <span>Align</span>
          <select
            value={style.align}
            onChange={(event) =>
              update({ align: event.currentTarget.value as TextStyleV1['align'] })
            }
          >
            <option value="start">Start</option>
            <option value="center">Center</option>
            <option value="end">End</option>
          </select>
        </label>
        <label className="text-editor-row">
          <span>Direction</span>
          <select
            value={style.direction}
            onChange={(event) =>
              update({ direction: event.currentTarget.value as TextStyleV1['direction'] })
            }
          >
            <option value="auto">Auto</option>
            <option value="ltr">LTR</option>
            <option value="rtl">RTL</option>
          </select>
        </label>
        <details className="font-catalog-discovery">
          <summary>Optional font catalog discovery</summary>
          <p>
            JOY bundles the local catalog. A Google Fonts key can discover metadata only; it stays
            in this page session and is never saved or sent to JOY.
          </p>
          <label className="font-catalog-key-row">
            <span>Google Fonts key</span>
            <input
              type="password"
              value={fontCatalogKey}
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setFontCatalogKey(event.currentTarget.value)}
              placeholder="Optional"
            />
          </label>
          <div className="font-catalog-actions">
            <button
              type="button"
              onClick={() => void discoverFontCatalog()}
              disabled={fontCatalogBusy}
            >
              {fontCatalogBusy ? 'Discovering…' : 'Discover'}
            </button>
            <button type="button" onClick={clearFontCatalogKey} disabled={fontCatalogBusy}>
              Clear
            </button>
          </div>
          <span className="font-catalog-count">
            {bundledFontCount} bundled families
            {fontCatalogEntries.length > fontCatalogSession.localEntries.length
              ? ` · ${fontCatalogEntries.length - fontCatalogSession.localEntries.length} metadata results`
              : ''}
          </span>
          <span className="font-catalog-status" aria-live="polite">
            {fontCatalogStatus}
          </span>
          {discoveredFontEntries.length > 0 && (
            <div className="font-catalog-results" aria-label="Discovered font metadata">
              <span>Metadata preview (not installed)</span>
              <ul>
                {discoveredFontEntries.slice(0, 12).map((font) => (
                  <li key={font.family}>
                    <strong>{font.label}</strong>
                    <span>
                      {font.scripts} · {font.weights}
                    </span>
                  </li>
                ))}
              </ul>
              {discoveredFontEntries.length > 12 && (
                <small>{discoveredFontEntries.length - 12} more metadata families available.</small>
              )}
            </div>
          )}
        </details>
      </section>
      <section className="text-editor-section">
        <h4>Fill</h4>
        <div className="text-fill-mode" role="group" aria-label="Text fill type">
          <button
            type="button"
            className="text-inline-action"
            aria-pressed={fill.kind === 'solid'}
            onClick={() => update({ fill: { kind: 'solid', color: solidColor } })}
          >
            Solid
          </button>
          <button
            type="button"
            className="text-inline-action"
            aria-pressed={fill.kind === 'linear-gradient'}
            onClick={() =>
              update({
                fill: {
                  kind: 'linear-gradient',
                  angleDeg: 20,
                  stops: [
                    { offset: 0, color: solidColor },
                    { offset: 1, color: secondGradientColor },
                  ],
                },
              })
            }
          >
            Gradient
          </button>
        </div>
        <label className="text-color-row">
          <span>Start</span>
          <input
            type="color"
            value={solidColor}
            onChange={(event) =>
              update({
                fill:
                  fill.kind === 'solid'
                    ? { kind: 'solid', color: event.currentTarget.value }
                    : {
                        ...fill,
                        stops: [
                          { ...fill.stops[0]!, color: event.currentTarget.value },
                          ...fill.stops.slice(1),
                        ],
                      },
              })
            }
          />
        </label>
        {fill.kind === 'linear-gradient' && (
          <label className="text-color-row">
            <span>End</span>
            <input
              type="color"
              value={secondGradientColor}
              onChange={(event) =>
                update({
                  fill: {
                    ...fill,
                    stops: fill.stops.map((stop, index) =>
                      index === fill.stops.length - 1
                        ? { ...stop, color: event.currentTarget.value }
                        : stop,
                    ),
                  },
                })
              }
            />
          </label>
        )}
      </section>
      <section className="text-editor-section">
        <h4>Effects</h4>
        <label className="text-color-row">
          <span>Stroke</span>
          <input
            type="color"
            value={style.stroke?.color ?? '#f6c453'}
            onChange={(event) =>
              update({
                stroke: {
                  color: event.currentTarget.value,
                  widthPx: style.stroke?.widthPx ?? 2,
                  opacity: 1,
                },
              })
            }
          />
        </label>
        <PropertyRow label="Stroke width" value={`${style.stroke?.widthPx ?? 0}px`}>
          <input
            type="range"
            min={0}
            max={12}
            step={1}
            value={style.stroke?.widthPx ?? 0}
            onChange={(event) =>
              update({
                stroke: {
                  color: style.stroke?.color ?? '#f6c453',
                  widthPx: event.currentTarget.valueAsNumber,
                  opacity: 1,
                },
              })
            }
          />
        </PropertyRow>
        <label className="text-color-row">
          <span>Shadow</span>
          <input
            type="color"
            value={style.shadow?.color ?? '#000000'}
            onChange={(event) =>
              update({
                shadow: {
                  color: event.currentTarget.value,
                  offsetX: style.shadow?.offsetX ?? 4,
                  offsetY: style.shadow?.offsetY ?? 4,
                  blurPx: style.shadow?.blurPx ?? 8,
                  opacity: style.shadow?.opacity ?? 0.55,
                },
              })
            }
          />
        </label>
        <PropertyRow label="Shadow blur" value={`${style.shadow?.blurPx ?? 0}px`}>
          <input
            type="range"
            min={0}
            max={32}
            value={style.shadow?.blurPx ?? 0}
            onChange={(event) =>
              update({
                shadow: {
                  color: style.shadow?.color ?? '#000000',
                  offsetX: style.shadow?.offsetX ?? 4,
                  offsetY: style.shadow?.offsetY ?? 4,
                  blurPx: event.currentTarget.valueAsNumber,
                  opacity: style.shadow?.opacity ?? 0.55,
                },
              })
            }
          />
        </PropertyRow>
        <label className="text-color-row">
          <span>Glow</span>
          <input
            type="color"
            value={style.glow?.color ?? '#53d9ff'}
            onChange={(event) =>
              update({
                glow: {
                  color: event.currentTarget.value,
                  radiusPx: style.glow?.radiusPx ?? 18,
                  strength: style.glow?.strength ?? 0.8,
                },
              })
            }
          />
        </label>
        <PropertyRow label="Opacity" value={style.opacity.toFixed(2)}>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={style.opacity}
            onChange={(event) => update({ opacity: event.currentTarget.valueAsNumber })}
          />
        </PropertyRow>
        <label className="text-editor-row">
          <span>Blend</span>
          <select
            value={style.blendMode}
            onChange={(event) =>
              update({ blendMode: event.currentTarget.value as TextStyleV1['blendMode'] })
            }
          >
            <option value="normal">Normal</option>
            <option value="multiply">Multiply</option>
            <option value="screen">Screen</option>
            <option value="overlay">Overlay</option>
            <option value="soft-light">Soft light</option>
            <option value="hard-light">Hard light</option>
            <option value="difference">Difference</option>
          </select>
        </label>
      </section>
    </section>
  );
}

function resolveTextObjectId(
  project: JoyProjectV1,
  selectedIds: readonly string[],
): string | undefined {
  const bound = resolveObjectIdForSelection(project, selectedIds);
  if (bound !== undefined && project.visualObjects[bound]?.kind === 'text') return bound;
  return selectedIds.find((id) => project.visualObjects[id]?.kind === 'text');
}
