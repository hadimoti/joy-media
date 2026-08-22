import { useState } from 'react';
import {
  BUILT_IN_SPECIALISTS,
  combineProposals,
  commitCombinedChangeSet,
  runSpecialists,
  RevisionConflictError,
} from '@joy-media/agent-tools';
import type { ChangeSetProposal, CombinedChangeSet } from '@joy-media/agent-tools';
import type { JoyProjectV1, SpikeProject } from '@joy-media/project-schema';
import type { ArtifactTransaction, CommandTransaction } from '@joy-media/commands';
import { planChangeSet } from './apply-change-set.js';

export interface SpecialistReviewPanelProps {
  readonly timeline: SpikeProject;
  readonly creative: JoyProjectV1;
  readonly compositionId: string;
  readonly selectedClipIds: readonly string[];
  readonly projectId: string;
  readonly revisionId: () => string;
  /**
   * Applies the document change, any timeline commands, and the change-set
   * record as one undo step.
   */
  readonly onApplyChangeSet: (
    label: string,
    document: JoyProjectV1,
    artifacts: ArtifactTransaction,
    timeline: CommandTransaction | undefined,
  ) => void;
}

interface ReviewState {
  readonly proposals: readonly ChangeSetProposal[];
  readonly combined: CombinedChangeSet;
  readonly denied: readonly { readonly roleId: string; readonly reason: string }[];
  readonly failed: readonly { readonly roleId: string; readonly error: string }[];
  /** Captured when the review ran, so approval commits against what was seen. */
  readonly baseRevision: string;
}

/**
 * Runs the specialists and lets the user approve their combined result.
 *
 * The panel deliberately shows findings, warnings, and proposed edits — never
 * reasoning traces (§8.4). Approval is per specialist, and committing requires
 * every contributing role to be approved, so "approve" can never quietly
 * include a result the user did not look at.
 */
export function SpecialistReviewPanel({
  timeline,
  creative,
  compositionId,
  selectedClipIds,
  projectId,
  revisionId,
  onApplyChangeSet,
}: SpecialistReviewPanelProps) {
  const [state, setState] = useState<ReviewState | undefined>(undefined);
  const [approved, setApproved] = useState<readonly string[]>([]);
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [unapplied, setUnapplied] = useState<
    readonly { readonly targetId: string; readonly reason: string }[]
  >([]);

  const runReview = async () => {
    setRunning(true);
    setStatus(undefined);
    try {
      const baseRevision = revisionId();
      const result = await runSpecialists(
        BUILT_IN_SPECIALISTS,
        {
          timeline,
          creative,
          scope: { compositionId, clipIds: [...selectedClipIds] },
        },
        // Least privilege: review is analysis, so it gets read authority only.
        { allowedCapabilities: ['timeline.read'] },
      );
      setState({
        proposals: result.proposals,
        combined: combineProposals(result.proposals),
        denied: result.denied,
        failed: result.failed,
        baseRevision,
      });
      setApproved([]);
    } finally {
      setRunning(false);
    }
  };

  const toggleApproval = (roleId: string) => {
    setApproved((current) =>
      current.includes(roleId)
        ? current.filter((candidate) => candidate !== roleId)
        : [...current, roleId],
    );
  };

  const applyApproved = () => {
    if (state === undefined) return;
    const now = new Date().toISOString();
    try {
      const result = commitCombinedChangeSet(state.combined, {
        actor: { type: 'human', id: 'editor' },
        projectId,
        baseRevision: state.baseRevision,
        currentRevision: revisionId,
        approval: { approvedRoleIds: approved, approvedAt: now },
        // Each specialist's result becomes an inspectable change-set artifact,
        // and the approved plan is committed to the document/timeline in the
        // same undoable step so the record matches what actually changed.
        build: (combined): ArtifactTransaction => {
          // Only specialists that both contributed an edit and were approved
          // become change sets; a review that found nothing records nothing.
          const contributing = combined.proposals.filter(
            (proposal) => proposal.edits.length > 0 && approved.includes(proposal.roleId),
          );
          return {
            label: `Apply ${contributing.length} specialist change set(s)`,
            commands: contributing.map((proposal) => ({
              type: 'artifact.create' as const,
              payload: {
                artifact: {
                  id: `changeset-${proposal.roleId}-${Date.now()}`,
                  kind: 'changeSet' as const,
                  schemaVersion: 1,
                  revision: 0,
                  label: proposal.title,
                  contentRef: {
                    type: 'inline' as const,
                    value: JSON.stringify({ findings: proposal.findings, edits: proposal.edits }),
                  },
                  binding: { type: 'none' as const },
                  provenance: {
                    sourceArtifactIds: [],
                    inputHashes: [],
                    createdBy: { type: 'agent' as const, id: proposal.roleId },
                  },
                  createdAt: now,
                  updatedAt: now,
                },
              },
            })),
          };
        },
        commit: (transaction) => {
          const contributing = state.combined.proposals.filter(
            (proposal) => proposal.edits.length > 0 && approved.includes(proposal.roleId),
          );
          const outcome = planChangeSet(creative, timeline, contributing);
          if (outcome.applied.length === 0 && outcome.unapplied.length > 0) {
            return { success: false, error: outcome.unapplied[0]!.reason };
          }
          // Document, timeline, and record land as one history step, so undoing
          // cannot leave a change set describing a change that is gone.
          onApplyChangeSet(transaction.label, outcome.document, transaction, outcome.timeline);
          setUnapplied(outcome.unapplied);
          return { success: true };
        },
      });
      setStatus(
        result.committed
          ? `${approved.length} Change set در یک تراکنش واحد اعمال شد.`
          : result.errors[0],
      );
      if (result.committed) setState(undefined);
    } catch (error) {
      setStatus(
        error instanceof RevisionConflictError
          ? 'از زمان اجرای این Review، پروژه تغییر کرده است. دوباره آن را اجرا کنید.'
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
  };

  return (
    <section className="specialist-review" aria-label="Specialist review">
      <div className="dual-lens-section-heading">
        <div>
          <strong>Specialists</strong>
          <span>
            {selectedClipIds.length === 0
              ? 'Whole sequence'
              : `${selectedClipIds.length} selected clip(s)`}
          </span>
        </div>
        <button
          type="button"
          className="dual-lens-disclosure"
          disabled={running}
          onClick={() => void runReview()}
        >
          {running ? 'Reviewing…' : 'Run review'}
        </button>
      </div>

      {status !== undefined && (
        <p className="specialist-status" role="status">
          {status}
        </p>
      )}

      {unapplied.map((entry) => (
        <p key={entry.targetId} className="specialist-denied">
          {entry.targetId} not applied — {entry.reason}
        </p>
      ))}

      {state === undefined ? (
        <p className="specialist-empty" lang="fa">
          متخصص‌های Caption، Audio، Color، و Pacing به‌صورت موازی بررسی می‌کنند و پیشنهاد می‌دهند.
          تا زمانی که شما تأیید نکنید چیزی اعمال نمی‌شود.
        </p>
      ) : (
        <>
          {state.combined.conflicts.length > 0 && (
            <p className="specialist-conflict" role="alert" lang="fa">
              {state.combined.conflicts.length} تعارض وجود دارد: متخصص‌ها دربارهٔ{' '}
              {state.combined.conflicts.map((conflict) => conflict.targetId).join('، ')} اختلاف
              دارند. پیش از اعمال، آن را حل کنید.
            </p>
          )}

          <ul className="specialist-list">
            {state.proposals.map((proposal) => (
              <li key={proposal.roleId} className="specialist-card">
                <label className="specialist-card-head">
                  <input
                    type="checkbox"
                    checked={approved.includes(proposal.roleId)}
                    onChange={() => toggleApproval(proposal.roleId)}
                  />
                  <strong>{proposal.title}</strong>
                  <span>{proposal.edits.length} proposed</span>
                </label>
                <ul className="specialist-findings">
                  {proposal.findings.map((finding) => (
                    <li key={finding}>{finding}</li>
                  ))}
                  {proposal.warnings.map((warning) => (
                    <li key={warning} className="is-warning">
                      {warning}
                    </li>
                  ))}
                </ul>
                {proposal.edits.length > 0 && (
                  <ul className="specialist-edits">
                    {proposal.edits.map((edit, index) => (
                      <li key={`${edit.targetId}-${index}`}>
                        <code>{edit.targetId}</code> {edit.summary}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>

          {state.denied.map((entry) => (
            <p key={entry.roleId} className="specialist-denied" lang="fa">
              {entry.roleId} نادیده گرفته شد — {entry.reason}
            </p>
          ))}
          {state.failed.map((entry) => (
            <p key={entry.roleId} className="specialist-denied" lang="fa">
              {entry.roleId} ناموفق بود — {entry.error}
            </p>
          ))}

          <button
            type="button"
            className="specialist-apply"
            disabled={approved.length === 0 || state.combined.conflicts.length > 0}
            onClick={applyApproved}
          >
            Apply {approved.length} approved change set(s) as one transaction
          </button>
        </>
      )}
    </section>
  );
}
