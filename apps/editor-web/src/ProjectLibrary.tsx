import { useMemo, useState } from 'react';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import {
  listCatalogProjects,
  removeCatalogProject,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import { PlusIcon, ProjectsIcon, TrashIcon } from './icons.js';

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
        <div className="project-library-brand">
          <ProjectsIcon />
          <strong>JOY Media</strong>
        </div>
        <button
          type="button"
          className="icon-button icon-button-labeled"
          onClick={() => setCreating(true)}
        >
          <PlusIcon />
          New project
        </button>
      </header>

      <main className="project-library-main">
        <div className="project-library-intro">
          <h1>Projects</h1>
          <p>Open a recent project or create a new one to enter the editor.</p>
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
                placeholder="Project title"
                onChange={(event) => setDraftTitle(event.currentTarget.value)}
              />
            </label>
            <button type="submit" className="icon-button icon-button-labeled">
              Create
            </button>
            <button
              type="button"
              className="icon-button icon-button-labeled"
              onClick={() => {
                setCreating(false);
                setDraftTitle('');
              }}
            >
              Cancel
            </button>
          </form>
        )}

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
                  <span>Updated {formatUpdated(entry.updatedAt)}</span>
                </span>
              </button>
              <button
                type="button"
                className="icon-button project-library-delete"
                aria-label={`Delete ${entry.title}`}
                title="Remove from library"
                onClick={() => {
                  if (!window.confirm(`Remove “${entry.title}” from the library?`)) return;
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
