import { useCallback, useEffect, useState } from 'react';
import type { MissingMediaEntry } from './missing-media.js';
import { RELINK_REFUSAL_MESSAGES } from './media-relink.js';
import type { MissingMediaHost } from './missing-media-host.js';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lists project media whose original is not in this profile, and lets the user
 * relink it. A file that does not match the recorded checksum is refused, with
 * an explicit "Use different file" option that never replaces the original.
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

  const reload = useCallback(async () => {
    setEntries(await host.list());
  }, [host]);

  useEffect(() => {
    void reload();
  }, [reload, revision]);

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

  if (entries.length === 0 && message === undefined) return null;

  return (
    <section className="asset-import-drawer missing-media" aria-label="Missing media">
      <div className="missing-media-head">
        <span className="missing-media-title">Missing media ({entries.length})</span>
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
      </div>
      {message !== undefined && (
        <p className="asset-library-empty" role="status">
          {message}
        </p>
      )}
      {entries.map((entry) => (
        <div
          key={entry.assetId}
          className="missing-media-card"
          data-missing-asset-id={entry.assetId}
        >
          <div className="missing-media-card-body">
            <span className="missing-media-name" title={entry.record.displayName}>
              {entry.record.displayName}
            </span>
            <span className="asset-library-empty">
              {entry.record.kind} · {formatBytes(entry.record.bytes ?? 0)}
            </span>
          </div>
          <label className="asset-import-btn">
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
          {warnings[entry.assetId] !== undefined && (
            <div className="missing-media-warning" role="alert">
              <span>{warnings[entry.assetId]}</span>
              <label className="icon-button">
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
        </div>
      ))}
    </section>
  );
}

function omit(record: Readonly<Record<string, string>>, key: string): Record<string, string> {
  const next = { ...record };
  delete next[key];
  return next;
}
