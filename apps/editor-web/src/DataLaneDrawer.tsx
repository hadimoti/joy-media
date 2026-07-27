import { useState } from 'react';
import type { ArtifactStore, ArtifactTransaction } from '@joy-media/commands';
import type { DataLane, DataLaneItem } from './data-lanes.js';

export interface DataLaneDrawerProps {
  readonly lanes: readonly DataLane[];
  readonly artifacts: ArtifactStore;
  /** Pixels per microsecond mapping, shared with the tracks above. */
  readonly timeToPixel: (timeUs: number) => number;
  readonly laneWidthPx: number;
  /** New data is bound here, so it lands where the user is looking. */
  readonly playheadUs: number;
  readonly onDispatchArtifacts: (transaction: ArtifactTransaction) => void;
  readonly onSeek: (timeUs: number) => void;
}

/** Kinds a person authors directly. The rest arrive from workflows and agents. */
const AUTHORABLE = [
  { kind: 'script' as const, label: 'Script' },
  { kind: 'prompt' as const, label: 'Prompt' },
  { kind: 'analysis' as const, label: 'Note' },
];

const DEFAULT_SPAN_US = 5_000_000;

/**
 * The expanded half of the Data Lanes drawer.
 *
 * Rendered inside the timeline's own scroll area and positioned with the same
 * `timeToPixel` the clips use, so a prompt bound to 00:12–00:28 sits under the
 * footage it describes instead of near it. Anything unplaced is shown as a chip
 * at the left rather than hidden, because an artifact with no binding is a real
 * state a user has to be able to see and fix.
 */
export function DataLaneDrawer({
  lanes,
  artifacts,
  timeToPixel,
  laneWidthPx,
  playheadUs,
  onDispatchArtifacts,
  onSeek,
}: DataLaneDrawerProps) {
  const [openArtifactId, setOpenArtifactId] = useState<string | undefined>(undefined);

  const addArtifact = (kind: (typeof AUTHORABLE)[number]['kind'], label: string) => {
    const now = new Date().toISOString();
    const id = `${kind}-${Date.now().toString(36)}`;
    onDispatchArtifacts({
      label: `Add ${label.toLowerCase()}`,
      commands: [
        {
          type: 'artifact.create',
          payload: {
            artifact: {
              id,
              kind,
              schemaVersion: 1,
              revision: 0,
              label: `${label} at ${(playheadUs / 1_000_000).toFixed(1)}s`,
              contentRef: { type: 'inline', value: '' },
              binding: { type: 'range', startUs: playheadUs, durationUs: DEFAULT_SPAN_US },
              provenance: {
                sourceArtifactIds: [],
                inputHashes: [],
                createdBy: { type: 'human', id: 'editor' },
              },
              createdAt: now,
              updatedAt: now,
            },
          },
        },
      ],
    });
  };

  const versions = openArtifactId === undefined ? [] : (artifacts.versions[openArtifactId] ?? []);
  const openArtifact = openArtifactId === undefined ? undefined : artifacts.artifacts[openArtifactId];

  const promote = (versionId: string) => {
    if (openArtifact === undefined) return;
    const now = new Date().toISOString();
    onDispatchArtifacts({
      label: `Promote version of ${openArtifact.label}`,
      commands: [
        {
          type: 'artifact.promoteVersion',
          payload: {
            artifactId: openArtifact.id,
            versionId,
            updatedAt: now,
            versionIdForCurrent: `v-${openArtifact.revision + 1}-${now}`,
          },
        },
      ],
    });
  };

  const setPinned = (versionId: string, pinned: boolean) => {
    if (openArtifact === undefined) return;
    onDispatchArtifacts({
      label: `${pinned ? 'Pin' : 'Unpin'} version of ${openArtifact.label}`,
      commands: [
        { type: 'artifact.pinVersion', payload: { artifactId: openArtifact.id, versionId, pinned } },
      ],
    });
  };

  return (
    <div className="data-lanes">
      <div className="data-lane-actions">
        <span className="data-lane-label">Add</span>
        <span className="data-lane-action-group">
          {AUTHORABLE.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              className="data-lane-add"
              title={`Add a ${label.toLowerCase()} bound to 5s from the playhead`}
              onClick={() => addArtifact(kind, label)}
            >
              + {label}
            </button>
          ))}
        </span>
      </div>

      {lanes.map((lane) => (
        <div className="data-lane" key={lane.id}>
          <span className="data-lane-label">{lane.label}</span>
          <span className="data-lane-track" style={{ minWidth: `${laneWidthPx}px` }}>
            {lane.items.map((item) => (
              <DataLaneChip
                key={item.id}
                item={item}
                timeToPixel={timeToPixel}
                onOpenVersions={setOpenArtifactId}
                onSeek={onSeek}
              />
            ))}
          </span>
        </div>
      ))}

      {openArtifact !== undefined && (
        <div className="version-tray" role="dialog" aria-label={`Versions of ${openArtifact.label}`}>
          <div className="version-tray-head">
            <strong>{openArtifact.label}</strong>
            <span>
              revision {openArtifact.revision} · {versions.length} retained
            </span>
            <button type="button" onClick={() => setOpenArtifactId(undefined)}>
              Close
            </button>
          </div>
          {versions.length === 0 ? (
            <p className="version-tray-empty">
              No earlier versions yet. Editing this artifact&apos;s content keeps the previous one
              here.
            </p>
          ) : (
            <ul className="version-list">
              {[...versions].reverse().map((version) => (
                <li key={version.id}>
                  <span className="version-revision">rev {version.revision}</span>
                  <span className="version-summary">{summarize(version.contentRef)}</span>
                  {version.pinned === true && <span className="version-pin">pinned</span>}
                  <button type="button" onClick={() => setPinned(version.id, version.pinned !== true)}>
                    {version.pinned === true ? 'Unpin' : 'Pin'}
                  </button>
                  <button type="button" onClick={() => promote(version.id)}>
                    Promote
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function DataLaneChip({
  item,
  timeToPixel,
  onOpenVersions,
  onSeek,
}: {
  readonly item: DataLaneItem;
  readonly timeToPixel: (timeUs: number) => number;
  readonly onOpenVersions: (artifactId: string) => void;
  readonly onSeek: (timeUs: number) => void;
}) {
  const placed = item.startUs !== undefined;
  const classes = ['data-lane-item', `is-${item.kind}`];
  if (!placed) classes.push('is-unplaced');
  if (item.stale) classes.push('is-stale');
  if (item.pinned) classes.push('is-pinned');

  const style = placed
    ? {
        left: `${timeToPixel(item.startUs ?? 0)}px`,
        // A point binding has no width; give it a hairline so it stays clickable.
        width: `${Math.max(3, timeToPixel(item.durationUs ?? 0))}px`,
      }
    : undefined;

  return (
    <button
      type="button"
      className={classes.join(' ')}
      style={style}
      title={`${item.label} — ${item.detail}${item.stale ? ' · stale' : ''}${placed ? '' : ' · not placed on the timeline'}`}
      onClick={() => {
        if (item.artifactId !== undefined) onOpenVersions(item.artifactId);
        else if (item.startUs !== undefined) onSeek(item.startUs);
      }}
      onDoubleClick={() => {
        if (item.startUs !== undefined) onSeek(item.startUs);
      }}
    >
      <span className="data-lane-item-label">{item.label}</span>
      {item.stale && <span className="data-lane-badge">stale</span>}
      {item.pinned && <span className="data-lane-badge is-pin">pinned</span>}
      {item.versionCount > 0 && <span className="data-lane-badge">v{item.versionCount}</span>}
    </button>
  );
}

function summarize(contentRef: { readonly type: string } & Record<string, unknown>): string {
  if (contentRef.type === 'inline' && typeof contentRef['value'] === 'string') {
    const value = contentRef['value'];
    return value.length > 60 ? `${value.slice(0, 59)}…` : value;
  }
  if (contentRef.type === 'asset') return `asset ${String(contentRef['assetId'])}`;
  if (contentRef.type === 'document') return `document ${String(contentRef['documentId'])}`;
  if (contentRef.type === 'external') return String(contentRef['uri']);
  return contentRef.type;
}
