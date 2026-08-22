import { useMemo, useState } from 'react';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import {
  listCatalogProjects,
  removeCatalogProject,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import { CheckIcon, CloseIcon, PlusIcon, TrashIcon } from './icons.js';

export function projectLibraryRemovalCopy(title: string): string {
  return `«${title}» فقط از فهرست پروژه‌ها حذف می‌شود. فایل‌های ذخیره‌شدهٔ پروژه پاک نمی‌شوند.`;
}

export function ProjectLibrary({
  storage,
  onOpen,
  onCreate,
}: {
  readonly storage: BrowserKeyValueStore;
  readonly onOpen: (entry: ProjectCatalogEntry) => void;
  readonly onCreate: (title: string) => void;
}) {
  const [tick, setTick] = useState(0);
  const [draftTitle, setDraftTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const projects = useMemo(() => listCatalogProjects(storage), [storage, tick]);

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
          <p lang="fa">یک پروژهٔ اخیر را باز کنید یا پروژهٔ تازه‌ای بسازید تا وارد Editor شوید.</p>
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
                placeholder="نام پروژه"
                lang="fa"
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

        <ul className="project-library-grid">
          {projects.map((entry) => (
            <li key={entry.id}>
              <button type="button" className="project-library-card" onClick={() => onOpen(entry)}>
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
