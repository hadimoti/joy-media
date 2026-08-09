import { useCallback, useEffect, useRef, useState } from 'react';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import {
  listCatalogProjects,
  listTrashedCatalogProjects,
  type ProjectCatalogEntry,
} from './project-catalog.js';
import {
  CheckIcon,
  CloseIcon,
  DuplicateIcon,
  EditIcon,
  MoreVerticalIcon,
  PlusIcon,
  TrashIcon,
} from './icons.js';

type ProjectOperationResult = void | ProjectCatalogEntry;
type ProjectAction = 'rename' | 'duplicate' | 'trash' | 'restore' | 'purge';
type DialogState =
  | {
      readonly kind: 'rename' | 'duplicate';
      readonly entry: ProjectCatalogEntry;
      readonly title: string;
    }
  | { readonly kind: 'trash' | 'purge'; readonly entry: ProjectCatalogEntry };

export function ProjectLibrary({
  storage,
  onOpen,
  onCreate,
  onRename,
  onDuplicate,
  onTrash,
  onRestore,
  onPurge,
}: {
  readonly storage: BrowserKeyValueStore;
  readonly onOpen: (entry: ProjectCatalogEntry) => void;
  readonly onCreate: (title: string) => void;
  readonly onRename: (
    entry: ProjectCatalogEntry,
    title: string,
  ) => ProjectOperationResult | Promise<ProjectOperationResult>;
  readonly onDuplicate: (
    entry: ProjectCatalogEntry,
    title: string,
  ) => ProjectOperationResult | Promise<ProjectOperationResult>;
  readonly onTrash: (entry: ProjectCatalogEntry) => void | Promise<void>;
  readonly onRestore: (entry: ProjectCatalogEntry) => void | Promise<void>;
  readonly onPurge: (entry: ProjectCatalogEntry) => void | Promise<void>;
}) {
  const [, setTick] = useState(0);
  const [draftTitle, setDraftTitle] = useState('');
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | undefined>(undefined);
  const [showTrash, setShowTrash] = useState(false);
  const [menuProjectId, setMenuProjectId] = useState<string | null>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0 });
  const [dialog, setDialog] = useState<DialogState | undefined>(undefined);
  const [busyProjectId, setBusyProjectId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: 'success' | 'error'; text: string }>();
  const [highlightProjectId, setHighlightProjectId] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const projects = showTrash ? listTrashedCatalogProjects(storage) : listCatalogProjects(storage);
  const trashedCount = listTrashedCatalogProjects(storage).length;

  const closeMenu = useCallback(
    (restoreFocus: boolean) => {
      const projectId = menuProjectId;
      setMenuProjectId(null);
      if (restoreFocus && projectId !== null) {
        window.setTimeout(() => triggerRefs.current.get(projectId)?.focus(), 0);
      }
    },
    [menuProjectId],
  );

  useEffect(() => {
    if (menuProjectId === null) return;
    const trigger = triggerRefs.current.get(menuProjectId);
    if (trigger === undefined) return;
    const menuWidth = 184;
    const menuHeight = showTrash ? 96 : 144;
    const rect = trigger.getBoundingClientRect();
    setMenuPosition({
      left: Math.max(8, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - 8)),
      top: Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - menuHeight - 8)),
    });
    const reposition = () => {
      const next = trigger.getBoundingClientRect();
      setMenuPosition({
        left: Math.max(8, Math.min(next.right - menuWidth, window.innerWidth - menuWidth - 8)),
        top: Math.max(8, Math.min(next.bottom + 4, window.innerHeight - menuHeight - 8)),
      });
    };
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [menuProjectId, showTrash]);

  useEffect(() => {
    if (menuProjectId === null) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('button');
    first?.focus();
    const closeOnOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      const trigger = triggerRefs.current.get(menuProjectId);
      if (menuRef.current?.contains(target) || trigger?.contains(target)) return;
      closeMenu(false);
    };
    const handleKeys = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
      if (buttons.length === 0) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      buttons[(current + delta + buttons.length) % buttons.length]?.focus();
    };
    document.addEventListener('pointerdown', closeOnOutside);
    document.addEventListener('keydown', handleKeys);
    return () => {
      document.removeEventListener('pointerdown', closeOnOutside);
      document.removeEventListener('keydown', handleKeys);
    };
  }, [closeMenu, menuProjectId]);

  const runOperation = async (
    entry: ProjectCatalogEntry,
    action: ProjectAction,
    operation: () => ProjectOperationResult | Promise<ProjectOperationResult>,
  ): Promise<ProjectOperationResult | undefined> => {
    setBusyProjectId(entry.id);
    setNotice(undefined);
    try {
      const result = await operation();
      setTick((value) => value + 1);
      if (
        action === 'duplicate' &&
        result !== undefined &&
        typeof result === 'object' &&
        'id' in result
      ) {
        setHighlightProjectId(result.id);
        window.setTimeout(() => setHighlightProjectId(null), 1800);
      }
      const labels: Record<ProjectAction, string> = {
        rename: 'Project renamed.',
        duplicate: 'Project duplicated.',
        trash: 'Project moved to Trash.',
        restore: 'Project restored.',
        purge: 'Project permanently deleted.',
      };
      setNotice({ kind: 'success', text: labels[action] });
      return result;
    } catch (error) {
      setNotice({
        kind: 'error',
        text: error instanceof Error ? error.message : 'Project action failed. Try again.',
      });
      return undefined;
    } finally {
      setBusyProjectId(null);
    }
  };

  const submitCreate = () => {
    const title = draftTitle.trim();
    if (title.length === 0) {
      setCreateError('Enter a project name before creating it.');
      return;
    }
    onCreate(title);
    setDraftTitle('');
    setCreateError(undefined);
    setCreating(false);
  };

  const openMenu = (entry: ProjectCatalogEntry, trigger: HTMLButtonElement) => {
    triggerRefs.current.set(entry.id, trigger);
    setMenuProjectId(entry.id);
  };

  const menuEntry =
    menuProjectId === null ? undefined : projects.find(({ id }) => id === menuProjectId);

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
        <div className="project-library-header-actions">
          <button
            type="button"
            className={`project-library-trash-toggle ${showTrash ? 'is-active' : ''}`}
            aria-pressed={showTrash}
            onClick={() => {
              setShowTrash((value) => !value);
              setMenuProjectId(null);
              setNotice(undefined);
            }}
          >
            <TrashIcon />
            Trash{trashedCount > 0 ? ` (${trashedCount})` : ''}
          </button>
          {!showTrash && (
            <button
              type="button"
              className="icon-button"
              aria-label="New project"
              data-guide="New project"
              onClick={() => {
                setCreateError(undefined);
                setCreating(true);
              }}
            >
              <PlusIcon />
            </button>
          )}
        </div>
      </header>

      <main className="project-library-main">
        <div className="project-library-intro">
          <h1>{showTrash ? 'Trash' : 'Projects'}</h1>
          <p>
            {showTrash
              ? 'Restore a project or permanently remove it from this account.'
              : 'Open a recent project or create a new one to enter the editor.'}
          </p>
        </div>

        {notice !== undefined && (
          <p className={`project-library-notice is-${notice.kind}`} role="status">
            {notice.text}
          </p>
        )}

        {!showTrash && creating && (
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
                aria-invalid={createError !== undefined}
                aria-describedby={createError !== undefined ? 'project-create-error' : undefined}
                onChange={(event) => {
                  setDraftTitle(event.currentTarget.value);
                  if (createError !== undefined) setCreateError(undefined);
                }}
              />
            </label>
            {createError !== undefined && (
              <p id="project-create-error" className="empty-hint" role="alert">
                {createError}
              </p>
            )}
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
                setCreateError(undefined);
              }}
            >
              <CloseIcon />
            </button>
          </form>
        )}

        {projects.length === 0 ? (
          <div className="project-library-empty" role="status">
            <strong>{showTrash ? 'Trash is empty' : 'No projects yet'}</strong>
            <span>
              {showTrash
                ? 'Deleted projects will stay here until you remove them permanently.'
                : 'Create a project to get started.'}
            </span>
          </div>
        ) : (
          <ul className="project-library-grid">
            {projects.map((entry) => {
              const busy = busyProjectId === entry.id;
              return (
                <li
                  key={entry.id}
                  className={highlightProjectId === entry.id ? 'is-highlighted' : undefined}
                >
                  <button
                    type="button"
                    className="project-library-card"
                    disabled={busy}
                    onClick={() => {
                      if (!showTrash) onOpen(entry);
                    }}
                  >
                    <span className="project-library-card-thumb" aria-hidden="true" />
                    <span className="project-library-card-body">
                      <strong dir="auto">{entry.title}</strong>
                      <span>
                        {showTrash && entry.trashedAt !== undefined
                          ? `Moved to Trash: ${formatUpdated(entry.trashedAt)}`
                          : `Last updated: ${formatUpdated(entry.updatedAt)}`}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="project-library-actions-trigger"
                    aria-label={`Project actions for ${entry.title}`}
                    aria-haspopup="menu"
                    aria-expanded={menuProjectId === entry.id}
                    disabled={busy}
                    ref={(element) => {
                      if (element === null) triggerRefs.current.delete(entry.id);
                      else triggerRefs.current.set(entry.id, element);
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (menuProjectId === entry.id) closeMenu(true);
                      else openMenu(entry, event.currentTarget);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'ArrowDown' && event.key !== 'Enter' && event.key !== ' ')
                        return;
                      event.preventDefault();
                      openMenu(entry, event.currentTarget);
                    }}
                  >
                    {busy ? (
                      <span className="project-library-spinner" aria-hidden="true" />
                    ) : (
                      <MoreVerticalIcon />
                    )}
                  </button>
                  {menuEntry?.id === entry.id && (
                    <div
                      ref={menuRef}
                      className="project-library-action-menu"
                      role="menu"
                      aria-label={`Actions for ${entry.title}`}
                      style={{ top: menuPosition.top, left: menuPosition.left }}
                    >
                      {showTrash ? (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              closeMenu(true);
                              void runOperation(entry, 'restore', () => onRestore(entry));
                            }}
                          >
                            <CheckIcon /> Restore
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="is-destructive"
                            onClick={() => {
                              closeMenu(true);
                              setDialog({ kind: 'purge', entry });
                            }}
                          >
                            <TrashIcon /> Delete permanently
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              closeMenu(true);
                              setDialog({ kind: 'rename', entry, title: entry.title });
                            }}
                          >
                            <EditIcon /> Rename
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            onClick={() => {
                              closeMenu(true);
                              setDialog({
                                kind: 'duplicate',
                                entry,
                                title: uniqueCopyTitle(entry.title, listCatalogProjects(storage)),
                              });
                            }}
                          >
                            <DuplicateIcon /> Duplicate
                          </button>
                          <button
                            type="button"
                            role="menuitem"
                            className="is-destructive"
                            onClick={() => {
                              closeMenu(true);
                              setDialog({ kind: 'trash', entry });
                            }}
                          >
                            <TrashIcon /> Move to Trash
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {dialog?.kind === 'rename' || dialog?.kind === 'duplicate' ? (
        <ProjectNameDialog
          kind={dialog.kind}
          initialTitle={dialog.title}
          onCancel={() => setDialog(undefined)}
          onSubmit={async (title) => {
            setDialog(undefined);
            await runOperation(dialog.entry, dialog.kind, () =>
              dialog.kind === 'rename'
                ? onRename(dialog.entry, title)
                : onDuplicate(dialog.entry, title),
            );
          }}
        />
      ) : dialog?.kind === 'trash' ? (
        <ProjectConfirmDialog
          title={`Move “${dialog.entry.title}” to Trash?`}
          body="Active jobs will be cancelled. You can restore this project from Trash later."
          actionLabel="Move to Trash"
          destructive
          onCancel={() => setDialog(undefined)}
          onConfirm={async () => {
            setDialog(undefined);
            await runOperation(dialog.entry, 'trash', () => onTrash(dialog.entry));
          }}
        />
      ) : dialog?.kind === 'purge' ? (
        <ProjectConfirmDialog
          title={`Delete “${dialog.entry.title}” permanently?`}
          body="This removes the project’s local documents and server records. Type the project name to continue."
          actionLabel="Delete permanently"
          requiredText={dialog.entry.title}
          destructive
          onCancel={() => setDialog(undefined)}
          onConfirm={async () => {
            setDialog(undefined);
            await runOperation(dialog.entry, 'purge', () => onPurge(dialog.entry));
          }}
        />
      ) : null}
    </div>
  );
}

function ProjectNameDialog({
  kind,
  initialTitle,
  onCancel,
  onSubmit,
}: {
  readonly kind: 'rename' | 'duplicate';
  readonly initialTitle: string;
  readonly onCancel: () => void;
  readonly onSubmit: (title: string) => void | Promise<void>;
}) {
  const [title, setTitle] = useState(initialTitle);
  const [error, setError] = useState<string>();
  const titleId = `project-${kind}-title`;
  return (
    <div className="project-library-modal-backdrop" onMouseDown={onCancel}>
      <div
        className="project-library-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id={titleId}>{kind === 'rename' ? 'Rename project' : 'Duplicate project'}</h2>
        <label>
          <span>Project name</span>
          <input
            autoFocus
            value={title}
            aria-invalid={error !== undefined}
            aria-describedby={error !== undefined ? `${titleId}-error` : undefined}
            onChange={(event) => {
              setTitle(event.currentTarget.value);
              setError(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape') onCancel();
            }}
          />
        </label>
        {error !== undefined && (
          <p id={`${titleId}-error`} role="alert" className="empty-hint">
            {error}
          </p>
        )}
        <div className="project-library-modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="is-primary"
            onClick={() => {
              const clean = title.trim();
              if (!clean) {
                setError('Enter a project name.');
                return;
              }
              void onSubmit(clean);
            }}
          >
            {kind === 'rename' ? 'Rename' : 'Duplicate'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProjectConfirmDialog({
  title,
  body,
  actionLabel,
  requiredText,
  destructive = false,
  onCancel,
  onConfirm,
}: {
  readonly title: string;
  readonly body: string;
  readonly actionLabel: string;
  readonly requiredText?: string;
  readonly destructive?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void | Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const ready = requiredText === undefined || typed === requiredText;
  return (
    <div className="project-library-modal-backdrop" onMouseDown={onCancel}>
      <div
        className="project-library-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-confirm-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <h2 id="project-confirm-title">{title}</h2>
        <p>{body}</p>
        {requiredText !== undefined && (
          <label>
            <span>
              Type <bdi>{requiredText}</bdi> to confirm
            </span>
            <input
              autoFocus
              value={typed}
              onChange={(event) => setTyped(event.currentTarget.value)}
            />
          </label>
        )}
        <div className="project-library-modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className={destructive ? 'is-destructive' : 'is-primary'}
            disabled={!ready}
            onClick={() => void onConfirm()}
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function uniqueCopyTitle(title: string, projects: readonly ProjectCatalogEntry[]): string {
  const existing = new Set(projects.map((entry) => entry.title.trim().toLocaleLowerCase()));
  const base = `${title.trim()} copy`;
  if (!existing.has(base.toLocaleLowerCase())) return base;
  let index = 2;
  while (existing.has(`${base} ${index}`.toLocaleLowerCase())) index += 1;
  return `${base} ${index}`;
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
