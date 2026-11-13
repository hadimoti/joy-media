import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CloseIcon } from './icons.js';
import type { MissingMediaEntry } from './missing-media.js';
import { RELINK_REFUSAL_MESSAGES } from './media-relink.js';
import type { MissingMediaHost } from './missing-media-host.js';

/**
 * Banners hidden with their close control. One host exists per editor session,
 * so a hidden banner stays hidden when the Assets panel remounts, and returns
 * only after the editor restarts.
 */
const hiddenForSession = new WeakSet<MissingMediaHost>();

function missingCountText(count: number): string {
  return `${count} ${count === 1 ? 'file is' : 'files are'} missing from this project`;
}

/**
 * Missing media in the Assets panel: one slim banner above the media list, and a
 * Review dialog with one row per file. A file that does not match the recorded
 * checksum is refused, with an explicit "Use different file" option that never
 * replaces the original.
 */
export function MissingMediaSection({
  host,
  revision,
  onChanged,
}: {
  readonly host: MissingMediaHost;
  /** Changes whenever the project changes, so the list reloads after edits and undo. */
  readonly revision: string;
  /** Lets the editor resync the timeline and menus after a project edit. */
  readonly onChanged?: (() => void) | undefined;
}) {
  const [entries, setEntries] = useState<readonly MissingMediaEntry[]>([]);
  const [warnings, setWarnings] = useState<Readonly<Record<string, string>>>({});
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [hidden, setHidden] = useState(() => hiddenForSession.has(host));
  const [reviewOpen, setReviewOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const reload = useCallback(async () => {
    setEntries(await host.list());
  }, [host]);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

  useEffect(() => {
    if (!reviewOpen) return;
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setReviewOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [reviewOpen]);

  const relinkOne = async (entry: MissingMediaEntry, file: File | undefined) => {
    if (file === undefined) return; // Cancelling the picker has no side effects.
    const verdict = await host.relink(entry, file);
    if (verdict.ok) {
      setWarnings((previous) => omit(previous, entry.assetId));
      setMessage(`Relinked ${entry.record.displayName}.`);
      await reload();
      onChanged?.();
      return;
    }
    setWarnings((previous) => ({
      ...previous,
      [entry.assetId]: `${RELINK_REFUSAL_MESSAGES[verdict.reason]} The original is unchanged.`,
    }));
  };

  const overrideWithFile = async (entry: MissingMediaEntry, file: File | undefined) => {
    if (file === undefined) return;
    const outcome = await host.useDifferentFile(entry, file);
    if (!outcome.ok) {
      setMessage('The chosen file is empty and was not used.');
      return;
    }
    setWarnings((previous) => omit(previous, entry.assetId));
    setMessage(
      `${file.name || 'The chosen file'} is now a separate asset; ${outcome.clipCount} clip(s) use it. The original is unchanged. Undo reverses this.`,
    );
    await reload();
    onChanged?.();
  };

  const matchMany = async (files: readonly File[]) => {
    if (files.length === 0) return;
    const result = await host.matchFiles(files.map((file) => ({ file, fileName: file.name })));
    let relinked = 0;
    for (const match of result.matches) {
      const entry = entries.find((candidate) => candidate.assetId === match.assetId);
      if (entry === undefined) continue;
      const verdict = await host.relink(entry, match.file);
      if (verdict.ok) relinked += 1;
    }
    const parts = [`Relinked ${relinked} of ${result.matches.length} matched file(s).`];
    if (result.unmatchedFileNames.length > 0)
      parts.push(`No missing media matches: ${result.unmatchedFileNames.join(', ')}.`);
    setMessage(parts.join(' '));
    await reload();
    if (relinked > 0) onChanged?.();
  };

  const showBanner = entries.length > 0 && !hidden;
  // While the dialog is open its own status line is shown; the banner shows the
  // status only when the dialog is closed.
  const showStatus = message !== undefined && !reviewOpen;
  const banner =
    showBanner || showStatus ? (
      <section className="missing-media" aria-label="Missing media">
        {showBanner && (
          <div className="missing-media-banner">
            <span className="missing-media-banner-text">{missingCountText(entries.length)}</span>
            <button
              type="button"
              className="missing-media-relink"
              onClick={() => setReviewOpen(true)}
            >
              Review
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Hide missing media for this session"
              title="Hide for this session"
              onClick={() => {
                hiddenForSession.add(host);
                setHidden(true);
              }}
            >
              <CloseIcon />
            </button>
          </div>
        )}
        {showStatus && (
          <p className="asset-library-empty missing-media-status" role="status">
            {message}
          </p>
        )}
      </section>
    ) : null;

  const dialog = reviewOpen
    ? createPortal(
        <div
          className="missing-media-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setReviewOpen(false);
          }}
        >
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="Missing media"
            tabIndex={-1}
            className="missing-media-dialog"
          >
            <div className="missing-media-dialog-head">
              <span className="missing-media-title">Missing media ({entries.length})</span>
              <div className="missing-media-dialog-actions">
                {entries.length > 1 && (
                  <label className="asset-import-btn">
                    Match files…
                    <input
                      type="file"
                      multiple
                      className="sr-only"
                      aria-label="Match files to missing media"
                      onChange={(event) => {
                        const files = Array.from(event.currentTarget.files ?? []);
                        event.currentTarget.value = '';
                        void matchMany(files);
                      }}
                    />
                  </label>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label="Close missing media"
                  title="Close"
                  onClick={() => setReviewOpen(false)}
                >
                  <CloseIcon />
                </button>
              </div>
            </div>
            {message !== undefined && (
              <p className="asset-library-empty missing-media-status" role="status">
                {message}
              </p>
            )}
            {entries.length === 0 ? (
              <p className="asset-library-empty">Nothing is missing from this project.</p>
            ) : (
              <ul className="missing-media-list" aria-label="Missing files">
                {entries.map((entry) => (
                  <li
                    key={entry.assetId}
                    className="missing-media-row"
                    data-missing-asset-id={entry.assetId}
                  >
                    <div className="missing-media-row-line">
                      <span className="missing-media-name" title={entry.record.displayName}>
                        {entry.record.displayName}
                      </span>
                      <span className="missing-media-kind">{entry.record.kind}</span>
                      <label className="missing-media-relink">
                        Relink
                        <input
                          type="file"
                          className="sr-only"
                          aria-label={`Relink ${entry.record.displayName}`}
                          onChange={(event) => {
                            const file = event.currentTarget.files?.[0];
                            event.currentTarget.value = '';
                            void relinkOne(entry, file);
                          }}
                        />
                      </label>
                    </div>
                    {warnings[entry.assetId] !== undefined && (
                      <div className="missing-media-warning" role="alert">
                        <span>{warnings[entry.assetId]}</span>
                        <label className="missing-media-relink">
                          Use different file
                          <input
                            type="file"
                            className="sr-only"
                            aria-label={`Use a different file for ${entry.record.displayName}`}
                            onChange={(event) => {
                              const file = event.currentTarget.files?.[0];
                              event.currentTarget.value = '';
                              void overrideWithFile(entry, file);
                            }}
                          />
                        </label>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>,
        document.body,
      )
    : null;

  if (banner === null && dialog === null) return null;
  return (
    <>
      {banner}
      {dialog}
    </>
  );
}

function omit(record: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const next = { ...record };
  delete next[key];
  return next;
}
