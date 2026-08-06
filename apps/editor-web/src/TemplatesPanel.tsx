import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { iconUrl } from './icon-assets.js';
import { CONTENT_TEMPLATES, contentTemplateById } from './content-template-catalog.js';
import {
  listTemplates,
  removeTemplate,
  type TemplateCatalogEntry,
} from './template-catalog.js';
import type { SeededContentTemplate, ContentTemplateV1, FirstPartySceneId } from './content-template-types.js';
import type { EditorSession } from './editor-session.js';
import { getFirstPartySceneThumbUrl } from './html-scene-thumbs.js';
import { createScenePreviewHost, defaultVariablesForScene, type ScenePreviewHost } from '@joy-media/html-scene-runtime/browser';
import { findFirstPartyScene, type FirstPartyScenePackage } from '@joy-media/html-scene-runtime/first-party';

interface TemplatesPanelProps {
  readonly session: EditorSession;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly onApplyTemplate: (seeded: SeededContentTemplate) => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
}

type TemplateView = 'library' | 'mine' | 'Titles' | 'Lower Thirds' | 'Utility' | 'Effects' | 'Social';

const SIDEBAR_VIEWS: readonly { readonly id: TemplateView; readonly iconUrl: string }[] = [
  { id: 'library', iconUrl: iconUrl('24_library.png') },
  { id: 'mine', iconUrl: iconUrl('24_my-media.png') },
  { id: 'Titles', iconUrl: iconUrl('24_titles.png') },
  { id: 'Lower Thirds', iconUrl: iconUrl('24_lowerthird.png') },
  { id: 'Social', iconUrl: iconUrl('24_socials.png') },
  { id: 'Utility', iconUrl: iconUrl('24_utility.png') },
  { id: 'Effects', iconUrl: iconUrl('ui/motion_24x24.png') },
];

export function TemplatesPanel({
  session,
  selectedClipIds: _selectedClipIds,
  playheadUs,
  onApplyTemplate,
  showToast,
}: TemplatesPanelProps) {
  const [view, setView] = useState<TemplateView>('library');

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

  const filteredTemplates = useMemo(() => {
    if (view === 'library') return CONTENT_TEMPLATES;
    if (view === 'mine') return listTemplates(window.localStorage);
    return CONTENT_TEMPLATES.filter((tpl) => tpl.category === view);
  }, [view]);

  const isMine = view === 'mine';

  const body = useMemo(() => {
    if (filteredTemplates.length === 0) {
      return (
        <p className="empty-hint">
          {isMine ? 'No saved templates yet.' : 'No templates found.'}
        </p>
      );
    }
    return (
      <div className="templates-grid">
        {filteredTemplates.map((tpl: typeof CONTENT_TEMPLATES[number] | TemplateCatalogEntry) => (
          <div
            key={tpl.id}
            className="template-card"
            title={'description' in tpl ? tpl.description : undefined}
          >
            <TemplatePreviewThumb template={tpl} />
            <span className="template-card-name">{tpl.label}</span>
            <span className="template-card-category">{tpl.category}</span>
            <button
              type="button"
              className="icon-button template-card-apply"
              aria-label={`Apply ${tpl.label}`}
              onClick={(e) => {
                e.stopPropagation();
                if (isMine) {
                  handleApplyCatalogTemplate(tpl as TemplateCatalogEntry);
                } else {
                  handleApplyLibraryTemplate(tpl.id);
                }
              }}
            >
              Apply
            </button>
            {isMine && (
              <button
                type="button"
                className="icon-button template-card-delete"
                aria-label={`Delete ${tpl.label}`}
                title="Delete template"
                onClick={(e) => {
                  e.stopPropagation();
                  handleDeleteTemplate(tpl.id);
                }}
              >
                Delete
              </button>
            )}
          </div>
        ))}
      </div>
    );
  }, [filteredTemplates, isMine, handleApplyLibraryTemplate, handleApplyCatalogTemplate, handleDeleteTemplate]);

  return (
    <PanelShell
      title="Templates"
      iconUrl={panelTabIconUrl('templates')}
      className="templates-panel"
    >
      <div className="templates-content">
        <aside className="templates-sidebar" aria-label="Template views">
          <div className="templates-sidebar-tabs" role="tablist" aria-label="Template views">
            {SIDEBAR_VIEWS.map((item) => (
              <button
                key={item.id}
                type="button"
                role="tab"
                className="templates-sidebar-tab"
                aria-label={item.id === 'library' ? 'Library' : item.id === 'mine' ? 'My Templates' : item.id}
                title={item.id === 'library' ? 'Library' : item.id === 'mine' ? 'My Templates' : item.id}
                aria-selected={view === item.id}
                onClick={() => setView(item.id)}
              >
                <span
                  className="templates-sidebar-tab-icon"
                  style={{
                    maskImage: `url(${item.iconUrl})`,
                    WebkitMaskImage: `url(${item.iconUrl})`,
                  }}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </aside>
        <div className="templates-main">
          {body}
        </div>
      </div>
    </PanelShell>
  );
}

function TemplatePreviewThumb({ template }: { readonly template: ContentTemplateV1 | TemplateCatalogEntry }) {
  const firstSceneId = 'actions' in template
    ? (template.actions.find((a) => a.kind === 'html-scene') as { readonly kind: 'html-scene'; readonly sceneId: FirstPartySceneId } | undefined)?.sceneId
    : undefined;
  const scene: FirstPartyScenePackage | undefined = firstSceneId ? findFirstPartyScene(firstSceneId) : undefined;
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [hovering, setHovering] = useState(false);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<ScenePreviewHost | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!firstSceneId) return;
    let cancelled = false;
    void getFirstPartySceneThumbUrl(firstSceneId, 120).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => { cancelled = true; };
  }, [firstSceneId]);

  useEffect(() => {
    if (!hovering || !scene || !mountRef.current) return;
    const mount = mountRef.current;
    let cancelled = false;
    const variables = defaultVariablesForScene(scene.id);
    const durationUs = scene.manifest.durationUs;

    const host = createScenePreviewHost({
      instanceId: `template-live-${scene.id}-${Date.now()}`,
      scene,
      parent: mount,
      placement: 'inline',
    });
    host.iframe.style.width = '100%';
    host.iframe.style.height = '100%';
    host.iframe.style.border = 'none';
    host.iframe.style.pointerEvents = 'none';
    host.iframe.setAttribute('tabindex', '-1');
    host.iframe.setAttribute('aria-hidden', 'true');

    let start = performance.now();
    const loop = () => {
      if (cancelled) return;
      const elapsed = performance.now() - start;
      const t = (elapsed % 3200) / 3200;
      const timeUs = Math.floor(t * durationUs);
      host.update(timeUs, variables);
      rafRef.current = requestAnimationFrame(loop);
    };

    void host.ready.then(() => {
      if (cancelled) { host.destroy(); return; }
      hostRef.current = host;
      start = performance.now();
      rafRef.current = requestAnimationFrame(loop);
    });

    return () => {
      cancelled = true;
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
      host.destroy();
      hostRef.current = undefined;
    };
  }, [hovering, scene]);

  const showLive = hovering && scene !== undefined;

  return (
    <div
      className="template-card-preview"
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
    >
      {showLive ? (
        <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      ) : url !== undefined ? (
        <img src={url} alt="" draggable={false} className="template-card-preview-img" />
      ) : null}
    </div>
  );
}
