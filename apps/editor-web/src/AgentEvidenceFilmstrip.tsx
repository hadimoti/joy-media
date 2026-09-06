import { useId, type ChangeEvent, type KeyboardEvent } from 'react';
import './AgentEvidenceFilmstrip.css';

const MAX_MARKERS = 48;
const MAX_TIMESTAMP_US = 24 * 60 * 60 * 1_000_000;
const DEFAULT_CURSOR_STEP_US = 1_000;
const MAX_CURSOR_STEP_US = 60 * 1_000_000;
const SAFE_MARKER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type AgentEvidenceCoverage = 'sampled' | 'partial' | 'unknown';

/**
 * Metadata-only evidence marker. The filmstrip intentionally does not accept
 * media payloads, locations, or connection metadata.
 */
export interface AgentEvidenceFilmstripEvidence {
  readonly id: string;
  readonly timestampUs: number;
  readonly coverage: AgentEvidenceCoverage;
}

export interface AgentEvidenceTimeRange {
  readonly startUs: number;
  readonly endUs: number;
}

export interface AgentEvidenceFilmstripProps {
  readonly evidence: readonly AgentEvidenceFilmstripEvidence[];
  readonly reviewCursorRange: AgentEvidenceTimeRange;
  readonly reviewCursorUs: number;
  readonly onReviewCursorChange: (timestampUs: number) => void;
  readonly activeReadRange?: AgentEvidenceTimeRange;
  readonly proposedEditRange?: AgentEvidenceTimeRange;
  readonly reviewCursorStepUs?: number;
  readonly direction?: 'ltr' | 'rtl';
  readonly narrow?: boolean;
  readonly reducedMotion?: boolean;
}

const coverageLabels: Readonly<Record<AgentEvidenceCoverage, string>> = {
  sampled: 'Sampled coverage',
  partial: 'Partial coverage',
  unknown: 'Coverage unknown',
};

function isSafeTimestamp(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_TIMESTAMP_US
  );
}

function isTimeRange(value: unknown): value is AgentEvidenceTimeRange {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return isSafeTimestamp(candidate.startUs) && isSafeTimestamp(candidate.endUs);
}

function isCursorRange(value: unknown): value is AgentEvidenceTimeRange {
  return isTimeRange(value) && value.startUs < value.endUs;
}

function isCoverage(value: unknown): value is AgentEvidenceCoverage {
  return value === 'sampled' || value === 'partial' || value === 'unknown';
}

function isSafeMarker(value: unknown): value is AgentEvidenceFilmstripEvidence {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === 'string' &&
    SAFE_MARKER_ID.test(candidate.id) &&
    isSafeTimestamp(candidate.timestampUs) &&
    isCoverage(candidate.coverage)
  );
}

function isWithinRange(timestampUs: number, range: AgentEvidenceTimeRange): boolean {
  return timestampUs >= range.startUs && timestampUs <= range.endUs;
}

function clamp(timestampUs: number, range: AgentEvidenceTimeRange): number {
  return Math.min(range.endUs, Math.max(range.startUs, timestampUs));
}

function visibleRange(
  value: unknown,
  cursorRange: AgentEvidenceTimeRange,
): AgentEvidenceTimeRange | undefined {
  if (!isTimeRange(value)) return undefined;
  const startUs = Math.max(cursorRange.startUs, value.startUs);
  const endUs = Math.min(cursorRange.endUs, value.endUs);
  return startUs <= endUs ? { startUs, endUs } : undefined;
}

function safeMarkers(
  evidence: readonly AgentEvidenceFilmstripEvidence[],
  cursorRange: AgentEvidenceTimeRange,
): readonly AgentEvidenceFilmstripEvidence[] {
  if (!Array.isArray(evidence)) return [];
  const markerIds = new Set<string>();
  const markers: AgentEvidenceFilmstripEvidence[] = [];
  for (const candidate of evidence as readonly unknown[]) {
    if (!isSafeMarker(candidate) || !isWithinRange(candidate.timestampUs, cursorRange)) continue;
    if (markerIds.has(candidate.id)) continue;
    markerIds.add(candidate.id);
    markers.push(candidate);
    if (markers.length === MAX_MARKERS) break;
  }
  return markers.sort((left, right) => left.timestampUs - right.timestampUs);
}

function safeCursorStep(value: number | undefined): number {
  return isSafeTimestamp(value) && value > 0
    ? Math.min(value, MAX_CURSOR_STEP_US)
    : DEFAULT_CURSOR_STEP_US;
}

/** Formats a microsecond timestamp without accepting a date, URL, or media reference. */
export function formatAgentEvidenceTimestamp(timestampUs: number): string {
  if (!isSafeTimestamp(timestampUs)) return 'Unknown time';
  const milliseconds = Math.floor(timestampUs / 1_000);
  const hours = Math.floor(milliseconds / 3_600_000);
  const minutes = Math.floor((milliseconds % 3_600_000) / 60_000);
  const seconds = Math.floor((milliseconds % 60_000) / 1_000);
  const remainderMs = milliseconds % 1_000;
  const secondsText = seconds.toString().padStart(2, '0');
  const millisecondsText = remainderMs.toString().padStart(3, '0');
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, '0')}:${secondsText}.${millisecondsText}`
    : `${minutes}:${secondsText}.${millisecondsText}`;
}

export function agentEvidenceCoverageLabel(coverage: AgentEvidenceCoverage): string {
  return coverageLabels[coverage];
}

function rangeText(range: AgentEvidenceTimeRange): string {
  return `${formatAgentEvidenceTimestamp(range.startUs)}–${formatAgentEvidenceTimestamp(range.endUs)}`;
}

function keyboardCursorTarget(
  event: KeyboardEvent<HTMLInputElement>,
  cursorUs: number,
  cursorRange: AgentEvidenceTimeRange,
  stepUs: number,
): number | undefined {
  switch (event.key) {
    case 'ArrowRight':
    case 'ArrowUp':
      return clamp(cursorUs + stepUs, cursorRange);
    case 'ArrowLeft':
    case 'ArrowDown':
      return clamp(cursorUs - stepUs, cursorRange);
    case 'PageUp':
      return clamp(cursorUs + stepUs * 10, cursorRange);
    case 'PageDown':
      return clamp(cursorUs - stepUs * 10, cursorRange);
    case 'Home':
      return cursorRange.startUs;
    case 'End':
      return cursorRange.endUs;
    default:
      return undefined;
  }
}

/**
 * Controlled, metadata-only filmstrip. It receives no editor playhead,
 * selection, or history callbacks, so review navigation cannot mutate them.
 */
export function AgentEvidenceFilmstrip({
  evidence,
  reviewCursorRange,
  reviewCursorUs,
  onReviewCursorChange,
  activeReadRange,
  proposedEditRange,
  reviewCursorStepUs,
  direction = 'ltr',
  narrow = false,
  reducedMotion = false,
}: AgentEvidenceFilmstripProps) {
  const cursorHelpId = useId();
  if (!isCursorRange(reviewCursorRange)) return null;

  const cursorUs = isSafeTimestamp(reviewCursorUs)
    ? clamp(reviewCursorUs, reviewCursorRange)
    : reviewCursorRange.startUs;
  const stepUs = safeCursorStep(reviewCursorStepUs);
  const readRange = visibleRange(activeReadRange, reviewCursorRange);
  const editRange = visibleRange(proposedEditRange, reviewCursorRange);
  const markers = safeMarkers(evidence, reviewCursorRange);
  const className = [
    'agent-evidence-filmstrip',
    narrow ? 'is-narrow' : '',
    direction === 'rtl' ? 'is-rtl' : '',
    reducedMotion ? 'is-reduced-motion' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const onCursorChange = (event: ChangeEvent<HTMLInputElement>) => {
    const timestampUs = Number(event.currentTarget.value);
    if (!isSafeTimestamp(timestampUs)) return;
    onReviewCursorChange(clamp(timestampUs, reviewCursorRange));
  };

  const onCursorKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const target = keyboardCursorTarget(event, cursorUs, reviewCursorRange, stepUs);
    if (target === undefined || target === cursorUs) return;
    event.preventDefault();
    onReviewCursorChange(target);
  };

  return (
    <section
      className={className}
      data-agent-evidence-filmstrip="true"
      dir={direction}
      role="region"
      aria-label="Agent evidence review"
    >
      <div className="agent-evidence-filmstrip__header">
        <span className="agent-evidence-filmstrip__eyebrow">Evidence review</span>
        <span className="agent-evidence-filmstrip__count">{markers.length} safe markers</span>
      </div>

      {(readRange !== undefined || editRange !== undefined) && (
        <div className="agent-evidence-filmstrip__ranges" aria-label="Evidence ranges">
          {readRange !== undefined && (
            <p
              className="agent-evidence-filmstrip__range agent-evidence-filmstrip__range--read"
              data-evidence-range="active-read"
            >
              <strong>Active read range</strong>
              <span>{rangeText(readRange)}</span>
            </p>
          )}
          {editRange !== undefined && (
            <p
              className="agent-evidence-filmstrip__range agent-evidence-filmstrip__range--proposed"
              data-evidence-range="proposed-edit"
            >
              <strong>Proposed edit range</strong>
              <span>{rangeText(editRange)}</span>
            </p>
          )}
        </div>
      )}

      <ol className="agent-evidence-filmstrip__markers" aria-label="Evidence markers">
        {markers.map((marker) => {
          const inReadRange =
            readRange !== undefined && isWithinRange(marker.timestampUs, readRange);
          const inEditRange =
            editRange !== undefined && isWithinRange(marker.timestampUs, editRange);
          const markerClassName = [
            'agent-evidence-filmstrip__marker',
            inReadRange ? 'is-in-active-read' : '',
            inEditRange ? 'is-in-proposed-edit' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const timestamp = formatAgentEvidenceTimestamp(marker.timestampUs);
          const coverage = agentEvidenceCoverageLabel(marker.coverage);
          return (
            <li key={marker.id}>
              <button
                type="button"
                className={markerClassName}
                data-evidence-time-us={marker.timestampUs}
                aria-current={marker.timestampUs === cursorUs ? 'true' : undefined}
                aria-label={`Review evidence at ${timestamp}. ${coverage}.`}
                onClick={() => onReviewCursorChange(marker.timestampUs)}
              >
                <time className="agent-evidence-filmstrip__timestamp" dir="ltr">
                  {timestamp}
                </time>
                <span className="agent-evidence-filmstrip__coverage">{coverage}</span>
              </button>
            </li>
          );
        })}
      </ol>

      {markers.length === 0 && (
        <p className="agent-evidence-filmstrip__empty">No safe evidence markers are available.</p>
      )}

      <div className="agent-evidence-filmstrip__cursor-control">
        <label className="agent-evidence-filmstrip__cursor-label" htmlFor={cursorHelpId}>
          Review cursor
        </label>
        <input
          id={cursorHelpId}
          className="agent-evidence-filmstrip__cursor"
          type="range"
          min={reviewCursorRange.startUs}
          max={reviewCursorRange.endUs}
          step={1}
          value={cursorUs}
          dir="ltr"
          aria-label="Review cursor (does not change playback)"
          aria-describedby={`${cursorHelpId}-help`}
          aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End PageUp PageDown"
          aria-valuetext={formatAgentEvidenceTimestamp(cursorUs)}
          onChange={onCursorChange}
          onKeyDown={onCursorKeyDown}
        />
        <output className="agent-evidence-filmstrip__cursor-time" htmlFor={cursorHelpId} dir="ltr">
          {formatAgentEvidenceTimestamp(cursorUs)}
        </output>
        <p id={`${cursorHelpId}-help`} className="agent-evidence-filmstrip__cursor-help">
          Use arrow keys to move this review cursor independently of playback.
        </p>
      </div>
    </section>
  );
}
