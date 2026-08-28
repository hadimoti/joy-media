import { useMemo, useState } from 'react';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import {
  listCatalogProjects,
  getCatalogProject,
  loadActiveProjectId,
  removeCatalogProject,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import { CheckIcon, CloseIcon, PlusIcon, TrashIcon } from './icons.js';

export function projectLibraryRemovalCopy(title: string): string {
  return `Remove “${title}” from the project library? Saved project files are not deleted.`;
}

export function ProjectLibrary({
  storage,
  onOpen,
  onCreate,
  onImportMedia,
  onStartFromTemplate,
}: {
  readonly storage: BrowserKeyValueStore;
  readonly onOpen: (entry: ProjectCatalogEntry) => void;
  readonly onCreate: (title: string) => void;
  /** Optional entry points used by the empty library actions. */
  readonly onImportMedia?: () => void;
  readonly onStartFromTemplate?: () => void;
}) {
  const [tick, setTick] = useState(0);
  const [draftTitle, setDraftTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const projects = useMemo(() => listCatalogProjects(storage), [storage, tick]);
  const lastProject = useMemo(() => {
    const activeId = loadActiveProjectId(storage);
    return activeId === null ? undefined : getCatalogProject(storage, activeId);
  }, [storage, tick]);

  const submitCreate = () => {
    const title = draftTitle.trim() || `Untitled project ${projects.length + 1}`;
    onCreate(title);
    setDraftTitle('');
    setCreating(false);
  };

  return (
    <div className="project-library">
      <header className="project-library-header">
        <div className="project-library-brand app-brand">
          <img
            className="app-brand-logo"
            src="/assets/JoyCodeNew_32x32.png"
            alt=""
            width={26}
            height={26}
            decoding="async"
          />
          <strong>JOY Studio</strong>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="New project"
          data-guide="New project"
          onClick={() => setCreating(true)}
        >
          <PlusIcon />
        </button>
      </header>

      <main className="project-library-main">
        <div className="project-library-intro">
          <h1>Projects</h1>
          <p>Open a recent project or create one to enter the editor.</p>
          {lastProject !== undefined && (
            <button
              type="button"
              className="project-library-last-project"
              onClick={() => onOpen(lastProject)}
            >
              Open last project: <bdi dir="auto">{lastProject.title}</bdi>
            </button>
          )}
        </div>

        {creating && (
          <form
            className="project-library-create"
            onSubmit={(event) => {
              event.preventDefault();
              submitCreate();
            }}
          >
            <label>
              <span className="sr-only">Project title</span>
              <input
                autoFocus
                value={draftTitle}
                placeholder="Project name"
                onChange={(event) => setDraftTitle(event.currentTarget.value)}
              />
            </label>
            <button
              type="submit"
              className="icon-button"
              aria-label="Create project"
              data-guide="Create"
            >
              <CheckIcon />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Cancel"
              data-guide="Cancel"
              onClick={() => {
                setCreating(false);
                setDraftTitle('');
              }}
            >
              <CloseIcon />
            </button>
          </form>
        )}

        {projects.length === 0 ? (
          <section className="project-library-empty" aria-labelledby="project-library-empty-title">
            <div className="project-library-empty-copy">
              <h2 id="project-library-empty-title">Your project library is empty</h2>
              <p>Create a project, bring in media, or start with a template.</p>
            </div>
            <div className="project-library-empty-actions">
              <button
                type="button"
                className="project-library-primary-action"
                onClick={() => setCreating(true)}
              >
                New project
              </button>
              <button
                type="button"
                className="project-library-secondary-action"
                disabled={onImportMedia === undefined}
                onClick={() => onImportMedia?.()}
                title={onImportMedia === undefined ? 'Import media is unavailable here' : undefined}
              >
                Import media
              </button>
              <button
                type="button"
                className="project-library-secondary-action"
                disabled={onStartFromTemplate === undefined}
                onClick={() => onStartFromTemplate?.()}
                title={
                  onStartFromTemplate === undefined ? 'Templates are unavailable here' : undefined
                }
              >
                Start from template
              </button>
            </div>
          </section>
        ) : (
          <ul className="project-library-grid">
            {projects.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  className="project-library-card"
                  onClick={() => onOpen(entry)}
                >
                  <span className="project-library-card-thumb" aria-hidden="true" />
                  <span className="project-library-card-body">
                    <strong dir="auto">{entry.title}</strong>
                    <span>
                      Last updated: <bdi>{formatUpdated(entry.updatedAt)}</bdi>
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-button project-library-delete"
                  aria-label={`Remove ${entry.title} from library`}
                  title="Remove from library"
                  onClick={() => {
                    if (!window.confirm(projectLibraryRemovalCopy(entry.title))) return;
                    removeCatalogProject(storage, entry.id);
                    setTick((value) => value + 1);
                  }}
                >
                  <TrashIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function formatUpdated(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
