import { useState } from 'react';
import type { ProjectFolderAnswer, ProjectFolderAsk } from './project-folder-client.js';
import { ANSWER_HELP, askCopy } from './project-folder-messages.js';

/**
 * The owner's question about a folder project that the desktop could not settle by itself. The question is a choice
 * with no default: neither answer is focused or pre-selected, and "Not now" leaves the folder as it was. An
 * entry-missing ask is the restore prompt instead: the owner gives a title, and nothing else is written. A refused
 * answer stays on screen as `notice`, so the owner can choose again without reopening the folder.
 */
export function ProjectFolderAskDialog({
  folderName,
  ask,
  busy,
  notice,
  onAnswer,
  onRestore,
  onClose,
}: {
  readonly folderName: string;
  readonly ask: ProjectFolderAsk;
  readonly busy: boolean;
  readonly notice?: string | undefined;
  readonly onAnswer: (answer: ProjectFolderAnswer) => void;
  readonly onRestore: (title: string) => void;
  readonly onClose: () => void;
}) {
  const [title, setTitle] = useState('');
  const copy = askCopy(ask);
  const restoring = ask.reason === 'entry-missing';
  const titleId = 'project-folder-ask-title';
  return (
    <div className="project-library-modal-backdrop" onMouseDown={onClose}>
      <div
        className="project-library-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') onClose();
        }}
      >
        <h2 id={titleId}>{copy.title}</h2>
        <p className="project-folder-name">
          <bdi>{folderName}</bdi>
        </p>
        {copy.paragraphs.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
        {copy.siblings !== '' && <p className="project-folder-siblings">{copy.siblings}</p>}
        {notice !== undefined && (
          <p className="empty-hint" role="alert">
            {notice}
          </p>
        )}
        {restoring ? (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const clean = title.trim();
              if (clean !== '' && !busy) onRestore(clean);
            }}
          >
            <label>
              <span>Project title</span>
              <input
                value={title}
                maxLength={200}
                onChange={(event) => setTitle(event.currentTarget.value)}
              />
            </label>
            <p className="empty-hint">{ANSWER_HELP.restore}</p>
            <div className="project-library-modal-actions">
              <button type="button" onClick={onClose}>
                Not now
              </button>
              <button type="submit" className="is-primary" disabled={busy || title.trim() === ''}>
                Restore project
              </button>
            </div>
          </form>
        ) : (
          <>
            <div className="project-folder-answers">
              <div>
                <button type="button" disabled={busy} onClick={() => onAnswer('original')}>
                  This is the original
                </button>
                <p className="empty-hint">{ANSWER_HELP.original}</p>
              </div>
              {copy.offersCopy && (
                <div>
                  <button type="button" disabled={busy} onClick={() => onAnswer('copy')}>
                    This is a copy
                  </button>
                  <p className="empty-hint">{ANSWER_HELP.copy}</p>
                </div>
              )}
            </div>
            <div className="project-library-modal-actions">
              <button type="button" onClick={onClose}>
                Not now
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
