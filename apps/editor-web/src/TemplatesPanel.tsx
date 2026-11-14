import {
  useState,
  useMemo,
  useCallback,
  useRef,
  useEffect,
  useId,
  type ComponentType,
} from 'react';
import { confirmDialog, promptDialog } from './app-dialogs.js';
import { PanelShell } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import {
  EnhanceIcon,
  LibraryIcon,
  LowerThirdIcon,
  SocialIcon,
  StarIcon,
  TextTabIcon,
  ToolsIcon,
  UserIcon,
} from './icons.js';
import { CONTENT_TEMPLATES, contentTemplateById } from './content-template-catalog.js';
import { listTemplates, type TemplateCatalogEntry } from './template-catalog.js';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import { authorTemplateCopy, deleteTemplateWithConfirmation } from './template-catalog-ui.js';
import { TemplateCatalogCardActions } from './TemplateCatalogCardActions.js';
import { LibraryCard } from './LibraryCard.js';
import { LibraryRail, libraryTabPanelProps, type LibraryRailItem } from './LibraryRail.js';
import { readTemplateFavorites, toggleTemplateFavorite } from './template-favorites.js';
import type {
  SeededContentTemplate,
  ContentTemplateV1,
  FirstPartySceneId,
} from './content-template-types.js';
import { getFirstPartySceneThumbUrl } from './html-scene-thumbs.js';
import {
  createScenePreviewHost,
  defaultVariablesForScene,
  type ScenePreviewHost,
} from '@joy-media/html-scene-runtime/browser';
import {
  findFirstPartyScene,
  type FirstPartyScenePackage,
} from '@joy-media/html-scene-runtime/first-party';
import './library-panels.css';

interface TemplatesPanelProps {
  readonly onApplyTemplate: (seeded: SeededContentTemplate) => void;
  readonly showToast: (message: string, kind: 'info' | 'success' | 'error') => void;
  /** Supplied by LibraryPanel from the root project-writer gate. */
  readonly storage: BrowserKeyValueStore;
}

type TemplateView =
  'library' | 'mine' | 'favorites' | 'Titles' | 'Lower Thirds' | 'Utility' | 'Effects' | 'Social';

const SIDEBAR_VIEWS: readonly {
  readonly id: TemplateView;
  readonly label: string;
  readonly icon: ComponentType;
}[] = [
  { id: 'library', label: 'Library', icon: LibraryIcon },
  { id: 'mine', label: 'My Templates', icon: UserIcon },
  { id: 'favorites', label: 'Favorites', icon: StarIcon },
  { id: 'Titles', label: 'Titles', icon: TextTabIcon },
  { id: 'Lower Thirds', label: 'Lower Thirds', icon: LowerThirdIcon },
  { id: 'Social', label: 'Social', icon: SocialIcon },
  { id: 'Utility', label: 'Utility', icon: ToolsIcon },
  { id: 'Effects', label: 'Effects', icon: EnhanceIcon },
];

export function TemplatesPanel({ onApplyTemplate, showToast, storage }: TemplatesPanelProps) {
  const railPanelId = useId();
  const [view, setView] = useState<TemplateView>('library');
  const [catalogRevision, setCatalogRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [favorites, setFavorites] = useState<Set<string>>(() => readTemplateFavorites(storage));
  const catalogStorage = storage;

  useEffect(() => {
    setFavorites(readTemplateFavorites(catalogStorage));
  }, [catalogStorage]);

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
        actions: entry.actions as unknown as Parameters<
          typeof onApplyTemplate
        >[0]['template']['actions'],
      };
      onApplyTemplate({ template, seed, scopeLabel: entry.category });
      showToast(`Template "${entry.label}" applied`, 'success');
    },
    [onApplyTemplate, showToast],
  );

  const handleDeleteTemplate = useCallback(
    async (entry: TemplateCatalogEntry) => {
      const confirmed = await deleteTemplateWithConfirmation(catalogStorage, entry, (message) =>
        confirmDialog({ message, confirmLabel: 'Delete', tone: 'danger' }),
      );
      if (!confirmed) return;
      setCatalogRevision((revision) => revision + 1);
      showToast('Template deleted', 'info');
    },
    [catalogStorage, showToast],
  );

  const handleAuthorTemplate = useCallback(
    async (template: ContentTemplateV1) => {
      const requestedName = await promptDialog({
        message: `Save “${template.label}” to My Templates`,
        defaultValue: `${template.label} Copy`,
        confirmLabel: 'Save',
      });
      if (requestedName === null) return;
      try {
        const entry = authorTemplateCopy(catalogStorage, template, requestedName);
        setCatalogRevision((revision) => revision + 1);
        setView('mine');
        showToast(`Template "${entry.label}" saved`, 'success');
      } catch (error) {
        showToast(error instanceof Error ? error.message : 'Could not save template', 'error');
      }
    },
    [catalogStorage, showToast],
  );

  void catalogRevision;
  const builtInTemplates = CONTENT_TEMPLATES.map((template) => ({ template, isMine: false }));
  const savedTemplates = listTemplates(catalogStorage).map((template) => ({
    template,
    isMine: true,
  }));
  const allTemplates = [...builtInTemplates, ...savedTemplates];
  const needle = query.trim().toLowerCase();
  const inView =
    view === 'favorites'
      ? allTemplates.filter(({ template }) => favorites.has(template.id))
      : needle.length > 0
        ? allTemplates
        : view === 'library'
          ? builtInTemplates
          : view === 'mine'
            ? savedTemplates
            : builtInTemplates.filter(({ template }) => template.category === view);
  const filteredTemplates = inView.filter(({ template }) =>
    needle.length === 0
      ? true
      : [template.id, template.label, template.description, template.category].some((value) =>
          value.toLowerCase().includes(needle),
        ),
  );

  const toggleFavorite = useCallback(
    (templateId: string) => {
      setFavorites((current) => toggleTemplateFavorite(catalogStorage, current, templateId));
    },
    [catalogStorage],
  );

  const railItems: readonly LibraryRailItem[] = SIDEBAR_VIEWS.map((item) => {
    const ViewIcon = item.icon;
    return { id: item.id, label: item.label, icon: <ViewIcon /> };
  });

  const body = useMemo(() => {
    if (filteredTemplates.length === 0) {
      return (
        <p className="empty-hint">
          {view === 'mine' ? 'No saved templates yet.' : 'No templates found.'}
        </p>
      );
    }
    return (
      <div className="templates-grid library-card-grid">
        {filteredTemplates.map(({ template, isMine }) => (
          <LibraryCard
            key={template.id}
            id={template.id}
            name={template.label}
            description={template.description ?? template.category}
            preview={<TemplatePreviewThumb template={template} />}
            isFavorite={favorites.has(template.id)}
            onToggleFavorite={() => toggleFavorite(template.id)}
            onAdd={() => {
              if (isMine) handleApplyCatalogTemplate(template as TemplateCatalogEntry);
              else handleApplyLibraryTemplate(template.id);
            }}
            addAriaLabel={`Add ${template.label}`}
            className="template-card"
            title={template.description}
            badges={
              <span className="library-card-badge library-card-category-badge">
                {template.category}
              </span>
            }
            extraActions={
              <TemplateCatalogCardActions
                label={template.label}
                isMine={isMine}
                hideApply={true}
                onApply={() => undefined}
                onSave={() => handleAuthorTemplate(template as ContentTemplateV1)}
                onDelete={() => handleDeleteTemplate(template as TemplateCatalogEntry)}
              />
            }
          />
        ))}
      </div>
    );
  }, [
    filteredTemplates,
    view,
    favorites,
    toggleFavorite,
    handleApplyLibraryTemplate,
    handleApplyCatalogTemplate,
    handleDeleteTemplate,
    handleAuthorTemplate,
  ]);

  return (
    <PanelShell
      title="Templates"
      iconUrl={panelTabIconUrl('templates')}
      className="templates-panel library-panel"
      search={{ value: query, onChange: setQuery, placeholder: 'Search templates…' }}
    >
      <div className="templates-content library-browser">
        <LibraryRail
          label="Template categories"
          panelId={railPanelId}
          selectedId={view}
          onSelect={(id) => setView(id as TemplateView)}
          items={railItems}
        />
        <div
          className="templates-main library-browser-main"
          {...libraryTabPanelProps(railPanelId, view)}
        >
          {body}
        </div>
      </div>
    </PanelShell>
  );
}

/**
 * The thumbnail is requested 240 px high so it stays sharp on dense screens;
 * it was 120 px before (T-D15).
 */
export const TEMPLATE_THUMB_PX = 240;

function TemplatePreviewThumb({
  template,
}: {
  readonly template: ContentTemplateV1 | TemplateCatalogEntry;
}) {
  const firstSceneId =
    'actions' in template
      ? (
          template.actions.find((a) => a.kind === 'html-scene') as
            { readonly kind: 'html-scene'; readonly sceneId: FirstPartySceneId } | undefined
        )?.sceneId
      : undefined;
  const scene: FirstPartyScenePackage | undefined = firstSceneId
    ? findFirstPartyScene(firstSceneId)
    : undefined;
  const [url, setUrl] = useState<string | undefined>(undefined);
  const [hovering, setHovering] = useState(false);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<ScenePreviewHost | undefined>(undefined);
  const rafRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!firstSceneId) return;
    let cancelled = false;
    void getFirstPartySceneThumbUrl(firstSceneId, TEMPLATE_THUMB_PX).then((next) => {
      if (!cancelled) setUrl(next);
    });
    return () => {
      cancelled = true;
    };
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

    void host.ready.then(
      () => {
        if (cancelled) {
          host.destroy();
          return;
        }
        hostRef.current = host;
        start = performance.now();
        rafRef.current = requestAnimationFrame(loop);
      },
      () => {
        // The effect cleanup destroys the host, which rejects `ready`. That is
        // an expected teardown, so swallow it here rather than let the derived
        // promise surface as an unhandled rejection.
      },
    );

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
