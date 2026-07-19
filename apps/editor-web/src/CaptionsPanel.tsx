import { useState } from 'react';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import {
  captionSlots,
  DEFAULT_CONFIDENCE_WARNING_THRESHOLD,
  resolveCaptionDirection,
  searchCaptionSegments,
  segmentDisplayText,
  segmentMinConfidence,
  segmentSourceText,
  segmentTimelineRange,
} from '@joy-media/captions-core';
import type { CaptionSlot } from '@joy-media/captions-core';
import type { VisualObjectTransaction } from '@joy-media/property-system';

/**
 * Transcript-first caption editing (WP-03.2). Every durable change goes through
 * the shared v1 command history; text edits write display overrides only, so
 * transcription source tokens stay recoverable.
 */
export function CaptionsPanel({
  project,
  playheadUs,
  onSeek,
  onDispatch,
}: {
  readonly project: JoyProjectV1;
  readonly playheadUs: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}) {
  const [query, setQuery] = useState('');
  const composition = project.compositions[project.rootCompositionId];
  if (composition === undefined) throw new Error('captions root composition is unavailable');
  const slots = captionSlots(composition, project.captionDocuments);
  if (slots.length === 0) {
    return (
      <article className="captions-panel">
        <p>No caption tracks yet. Add a caption track to start a transcript.</p>
      </article>
    );
  }
  return (
    <article className="captions-panel">
      <input
        aria-label="Search transcript"
        type="search"
        placeholder="Search transcript"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {slots.map((slot) => (
        <CaptionSlotEditor
          key={`${slot.trackId}:${slot.clip.id}`}
          slot={slot}
          query={query}
          playheadUs={playheadUs}
          onSeek={onSeek}
          onDispatch={onDispatch}
        />
      ))}
    </article>
  );
}

function CaptionSlotEditor({
  slot,
  query,
  playheadUs,
  onSeek,
  onDispatch,
}: {
  readonly slot: CaptionSlot;
  readonly query: string;
  readonly playheadUs: number;
  readonly onSeek: (timeUs: number) => void;
  readonly onDispatch: (transaction: VisualObjectTransaction) => void;
}) {
  const { clip, document } = slot;
  const direction = resolveCaptionDirection(document);
  const matches =
    query.trim().length === 0
      ? undefined
      : new Set(searchCaptionSegments(document, query).map((match) => match.segment.id));
  const segments = document.segments.filter(
    (segment) => matches === undefined || matches.has(segment.id),
  );
  const addSegment = () => {
    const startUs = Math.max(0, playheadUs - clip.startUs);
    onDispatch({
      label: 'Add caption',
      commands: [
        {
          type: 'caption.addSegment',
          payload: {
            documentId: document.id,
            segment: {
              id: crypto.randomUUID(),
              startUs,
              endUs: startUs + 2_000_000,
              wordIds: [],
              textOverride: 'New caption',
            },
          },
        },
      ],
    });
  };
  return (
    <section aria-label={`Captions ${document.language}`}>
      <header className="captions-slot-header">
        <strong>
          {document.language} · {direction.toUpperCase()}
        </strong>
        <button onClick={addSegment}>Add caption</button>
      </header>
      {segments.length === 0 && <p>No matching captions.</p>}
      <ol className="captions-list">
        {segments.map((segment) => {
          const range = segmentTimelineRange(clip, segment);
          const active =
            range !== undefined &&
            playheadUs >= range.startUs &&
            playheadUs < range.startUs + range.durationUs;
          const display = segmentDisplayText(document, segment);
          const source = segmentSourceText(document, segment);
          const confidence = segmentMinConfidence(document, segment);
          const lowConfidence =
            confidence !== undefined && confidence < DEFAULT_CONFIDENCE_WARNING_THRESHOLD;
          const commitText = (value: string) => {
            if (value === display) return;
            onDispatch({
              label: 'Edit caption text',
              commands: [
                {
                  type: 'caption.setSegmentText',
                  payload: {
                    documentId: document.id,
                    segmentId: segment.id,
                    // Typing the source text back reverts to the source tokens.
                    textOverride: value === source ? undefined : value,
                  },
                },
              ],
            });
          };
          const commitTiming = (startSeconds: number, endSeconds: number) => {
            const startUs = Math.round(startSeconds * 1_000_000);
            const endUs = Math.round(endSeconds * 1_000_000);
            if (startUs === segment.startUs && endUs === segment.endUs) return;
            if (startUs < 0 || endUs <= startUs) return;
            onDispatch({
              label: 'Retime caption',
              commands: [
                {
                  type: 'caption.setSegmentTiming',
                  payload: { documentId: document.id, segmentId: segment.id, startUs, endUs },
                },
              ],
            });
          };
          return (
            <li key={segment.id} className={active ? 'caption-row active' : 'caption-row'}>
              <button
                aria-label={`Seek to caption ${segment.id}`}
                onClick={() => range !== undefined && onSeek(range.startUs)}
              >
                {(segment.startUs / 1_000_000).toFixed(2)}s
              </button>
              <TimingField
                label="Start (s)"
                value={segment.startUs / 1_000_000}
                onCommit={(value) => commitTiming(value, segment.endUs / 1_000_000)}
              />
              <TimingField
                label="End (s)"
                value={segment.endUs / 1_000_000}
                onCommit={(value) => commitTiming(segment.startUs / 1_000_000, value)}
              />
              <input
                key={`${segment.id}:${display}`}
                aria-label={`Caption text ${segment.id}`}
                dir={direction}
                defaultValue={display}
                title={segment.textOverride === undefined ? undefined : `Source: ${source}`}
                onBlur={(event) => commitText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              {lowConfidence && (
                <span className="caption-warning" title="Low transcription confidence">
                  ⚠ {Math.round(confidence * 100)}%
                </span>
              )}
              {segment.textOverride !== undefined && (
                <button
                  title={`Revert to source: ${source}`}
                  onClick={() =>
                    onDispatch({
                      label: 'Revert caption text',
                      commands: [
                        {
                          type: 'caption.setSegmentText',
                          payload: {
                            documentId: document.id,
                            segmentId: segment.id,
                            textOverride: undefined,
                          },
                        },
                      ],
                    })
                  }
                >
                  Revert
                </button>
              )}
              <button
                aria-label={`Delete caption ${segment.id}`}
                onClick={() =>
                  onDispatch({
                    label: 'Delete caption',
                    commands: [
                      {
                        type: 'caption.removeSegment',
                        payload: { documentId: document.id, segmentId: segment.id },
                      },
                    ],
                  })
                }
              >
                Delete
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function TimingField({
  label,
  value,
  onCommit,
}: {
  readonly label: string;
  readonly value: number;
  readonly onCommit: (value: number) => void;
}) {
  return (
    <input
      key={value}
      aria-label={label}
      type="number"
      step={0.05}
      min={0}
      defaultValue={value.toFixed(2)}
      onBlur={(event) => {
        const next = event.currentTarget.valueAsNumber;
        if (Number.isFinite(next)) onCommit(next);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur();
      }}
    />
  );
}
