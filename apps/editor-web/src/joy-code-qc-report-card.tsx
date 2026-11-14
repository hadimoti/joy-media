/**
 * Joy Code's QC report card (card T-B07): one summary line, the findings grouped by type with timecodes that
 * move the playhead, the state before and after, what was sent to which model, the frames used against the
 * budget, and the evidence filmstrip under it. "Save report" writes a Markdown file and a JSON file through
 * the same browser text download the caption export uses.
 *
 * It renders only what `readQcReportView` verified, so a report that came from a tool or a saved file cannot
 * put a path, a link or raw text on screen.
 */
import { useState } from 'react';
import { AgentEvidenceFilmstrip } from './AgentEvidenceFilmstrip.js';
import { downloadBrowserTextFile } from './browser-text-download.js';
import {
  formatQcRange,
  qcReportFileNames,
  qcReportJson,
  qcReportMarkdown,
  qcSentLine,
  type QcReportView,
} from './joy-code-qc-report.js';
import './joy-code-qc-report-card.css';

export interface JoyCodeQcReportCardProps {
  readonly view: QcReportView;
  /** The check before the edit, when there was one: its finding count is the "before" state. */
  readonly before?: { readonly findingCount: number } | undefined;
  /** Moves the editor playhead to a time in the composition, microseconds. */
  readonly onSeek?: ((timeUs: number) => void) | undefined;
  /** Writes one text file. Defaults to the browser text download used by the caption export. */
  readonly saveFile?: ((fileName: string, text: string) => void) | undefined;
}

function SaveIcon() {
  return (
    <svg
      className="joy-code-qc-card__icon"
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M8 2v7m0 0L5 6m3 3 3-3M3 12.5h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function JoyCodeQcReportCard({
  view,
  before,
  onSeek,
  saveFile = downloadBrowserTextFile,
}: JoyCodeQcReportCardProps) {
  const lastFrameUs = view.frames.reduce((latest, frame) => Math.max(latest, frame.timeUs), 0);
  const spanUs = Math.max(view.durationUs ?? 0, lastFrameUs + 1);
  const [cursorUs, setCursorUs] = useState(0);

  const onSave = (): void => {
    const names = qcReportFileNames(view.reportId);
    saveFile(names.markdown, qcReportMarkdown(view, before));
    saveFile(names.json, qcReportJson(view));
  };

  return (
    <article className="joy-code-qc-card" role="region" aria-label="QC report">
      <header className="joy-code-qc-card__head">
        <strong className="joy-code-qc-card__title">QC report</strong>
        <button type="button" className="joy-code-qc-card__save" onClick={onSave}>
          <SaveIcon />
          Save report
        </button>
      </header>
      <p className="joy-code-qc-card__summary" data-qc-summary="true">
        {view.summary}
      </p>

      <dl className="joy-code-qc-card__facts">
        {before === undefined ? (
          <div data-qc-fact="findings">
            <dt>Findings</dt>
            <dd>{view.findingCount}</dd>
          </div>
        ) : (
          <>
            <div data-qc-fact="before">
              <dt>Before</dt>
              <dd>{before.findingCount}</dd>
            </div>
            <div data-qc-fact="after">
              <dt>After</dt>
              <dd>{view.findingCount}</dd>
            </div>
          </>
        )}
        <div data-qc-fact="sent">
          <dt>Model</dt>
          <dd>{qcSentLine(view)}</dd>
        </div>
        <div data-qc-fact="frames">
          <dt>Frames</dt>
          <dd>
            {view.framesSent} / {view.frameBudget}
          </dd>
        </div>
      </dl>

      {view.truncated.length > 0 && (
        <ul className="joy-code-qc-card__notes" aria-label="Report notes">
          {view.truncated.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}

      {view.groups.map((group) => (
        <section
          key={group.type}
          className="joy-code-qc-card__group"
          aria-label={group.name}
          data-qc-group={group.type}
        >
          <h4 className="joy-code-qc-card__group-name">
            {group.name}
            <span className="joy-code-qc-card__count">{group.findings.length}</span>
          </h4>
          <ul className="joy-code-qc-card__findings">
            {group.findings.map((finding) => {
              const time = formatQcRange(finding);
              return (
                <li key={finding.id}>
                  <button
                    type="button"
                    className={`joy-code-qc-card__finding is-${finding.severity}`}
                    data-qc-finding={finding.id}
                    data-qc-start-us={finding.startUs}
                    disabled={onSeek === undefined}
                    aria-label={`Go to ${time}. ${finding.label}`}
                    onClick={() => onSeek?.(finding.startUs)}
                  >
                    <time className="joy-code-qc-card__time" dir="ltr">
                      {time}
                    </time>
                    <span className="joy-code-qc-card__label">{finding.label}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {view.frames.length > 0 && (
        <AgentEvidenceFilmstrip
          evidence={view.frames.map((frame) => ({
            id: frame.id,
            timestampUs: frame.timeUs,
            coverage: 'sampled' as const,
          }))}
          reviewCursorRange={{ startUs: 0, endUs: spanUs }}
          reviewCursorUs={cursorUs}
          onReviewCursorChange={setCursorUs}
          narrow
        />
      )}
    </article>
  );
}
