/**
 * Creative Brief Display - WP-37 S4-B
 *
 * Presentational, read-only component for displaying a CreativeBriefV1.
 * Does NOT: create snapshots, call models, call adapters, mutate state, persist data,
 * or create plans/commands/jobs.
 */

import type { CreativeBriefV1 } from '@joy-media/agent-tools';

export interface CreativeBriefDisplayProps {
  /** The complete creative brief to display. */
  readonly brief: CreativeBriefV1;
}

/**
 * Risk level labels for display.
 */
const RISK_LABEL: Record<
  'none' | 'reversible-local' | 'destructive' | 'remote-egress' | 'spend',
  string
> = {
  none: 'No risk',
  'reversible-local': 'Reversible',
  destructive: 'Destructive',
  'remote-egress': 'Network required',
  spend: 'Costs apply',
};

/**
 * Confidence level labels for display.
 */
const CONFIDENCE_LABEL: Record<'low' | 'medium' | 'high', string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

/**
 * Severity level labels for display.
 */
const SEVERITY_LABEL: Record<'info' | 'suggestion' | 'warning' | 'error', string> = {
  info: 'Info',
  suggestion: 'Suggestion',
  warning: 'Warning',
  error: 'Error',
};

/**
 * Format evidence references for display.
 */
function formatEvidence(
  evidence: readonly {
    readonly startUs?: number;
    readonly endUs?: number;
    readonly elementIds?: readonly string[];
    readonly sceneIds?: readonly string[];
    readonly detail?: string;
  }[],
): string {
  if (evidence.length === 0) return 'No evidence';

  const parts: string[] = [];
  for (const e of evidence) {
    if (e.sceneIds && e.sceneIds.length > 0) {
      parts.push(`scenes: ${e.sceneIds.join(', ')}`);
    }
    if (e.elementIds && e.elementIds.length > 0) {
      parts.push(`elements: ${e.elementIds.join(', ')}`);
    }
    if (e.startUs !== undefined && e.endUs !== undefined) {
      parts.push(`range: ${formatDuration(e.startUs)}–${formatDuration(e.startUs + e.endUs)}`);
    }
    if (e.detail) {
      parts.push(e.detail);
    }
  }
  return parts.length > 0 ? parts.join('; ') : 'Evidence available';
}

/**
 * Format microseconds as a human-readable duration.
 */
function formatDuration(us: number): string {
  const seconds = Math.floor(us / 1_000_000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes > 0) {
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }
  return `${seconds}" Event: ${remainingSeconds}"`;
}

/**
 * Creative Brief Display Component.
 *
 * Renders a read-only view of a CreativeBriefV1 with:
 * - Original request and interpreted goal
 * - Facts clearly separated from model inferences
 * - Recommendations with confidence, risk, rationale, expected benefit, evidence
 * - Blockers, human decisions, and warnings when present
 */
export function CreativeBriefDisplay({ brief }: CreativeBriefDisplayProps) {
  const { facts, inferences } = brief.distinction;

  return (
    <article className="creative-brief" aria-label="Creative brief">
      {/* Request and Goal */}
      <section className="creative-brief-section" aria-label="Request and goal">
        <h3 className="creative-brief-heading">Request</h3>
        <p className="creative-brief-request">{brief.request}</p>

        <h3 className="creative-brief-heading">Interpreted Goal</h3>
        <div className="creative-brief-goal">
          <p>
            <strong>User intent:</strong> {brief.interpretedGoal.userIntent}
          </p>
          <p>
            <strong>Inferred goal:</strong> {brief.interpretedGoal.inferredGoal}
          </p>
          <p>
            <strong>Resolved goal:</strong> {brief.interpretedGoal.resolvedGoal}
          </p>
          <p>
            <small>Confidence: {CONFIDENCE_LABEL[brief.interpretedGoal.confidence]}</small>
          </p>
        </div>
      </section>

      {/* Facts vs Inferences */}
      <section className="creative-brief-section" aria-label="Facts and inferences">
        <h3 className="creative-brief-heading">Factual Findings</h3>
        {facts.length > 0 ? (
          <ul className="creative-brief-list">
            {facts.map((fact) => (
              <li key={fact.id} className="creative-brief-fact">
                <span className="creative-brief-statement">{fact.statement}</span>
                {fact.evidence.length > 0 && (
                  <span className="creative-brief-evidence">
                    {' '}
                    ({formatEvidence(fact.evidence)})
                  </span>
                )}
                <span className="creative-brief-source"> [{fact.source}]</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="creative-brief-empty">No factual findings</p>
        )}

        <h3 className="creative-brief-heading">Model Inferences</h3>
        {inferences.length > 0 ? (
          <ul className="creative-brief-list">
            {inferences.map((inference) => (
              <li key={inference.id} className="creative-brief-inference">
                <span className="creative-brief-statement">{inference.statement}</span>
                <span className="creative-brief-confidence">
                  {' '}
                  (Confidence: {CONFIDENCE_LABEL[inference.confidence]})
                </span>
                {inference.rationale && (
                  <div className="creative-brief-rationale">Rationale: {inference.rationale}</div>
                )}
                {inference.evidence.length > 0 && (
                  <span className="creative-brief-evidence">
                    {' '}
                    Evidence: {formatEvidence(inference.evidence)}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="creative-brief-empty">No model inferences</p>
        )}
      </section>

      {/* Assumptions */}
      {brief.assumptions.length > 0 && (
        <section className="creative-brief-section" aria-label="Assumptions">
          <h3 className="creative-brief-heading">Assumptions</h3>
          <ul className="creative-brief-list">
            {brief.assumptions.map((assumption) => (
              <li key={assumption.id} className="creative-brief-assumption">
                <span className="creative-brief-statement">{assumption.statement}</span>
                <span className="creative-brief-verified">
                  {' '}
                  {assumption.verified ? '[Verified]' : '[Unverified]'}
                </span>
                <span className="creative-brief-confidence">
                  {' '}
                  (Confidence: {CONFIDENCE_LABEL[assumption.confidence]})
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Recommendations */}
      <section className="creative-brief-section" aria-label="Recommendations">
        <h3 className="creative-brief-heading">Recommendations</h3>
        {brief.recommendations.length > 0 ? (
          <ul className="creative-brief-list">
            {brief.recommendations.map((rec) => (
              <li key={rec.id} className="creative-brief-recommendation">
                <div className="creative-brief-rec-header">
                  <span className="creative-brief-rec-kind">{rec.kind}</span>
                  <span className="creative-brief-rec-risk"> Risk: {RISK_LABEL[rec.risk]}</span>
                  <span className="creative-brief-rec-confidence">
                    {' '}
                    Confidence: {CONFIDENCE_LABEL[rec.confidence]}
                  </span>
                </div>
                <p className="creative-brief-rec-rationale">{rec.rationale}</p>
                <p className="creative-brief-rec-benefit">
                  <strong>Expected benefit:</strong> {rec.expectedBenefit}
                </p>
                {rec.proposedIntent && (
                  <p className="creative-brief-rec-intent">
                    <small>Suggested intent: {rec.proposedIntent}</small>
                  </p>
                )}
                {rec.evidence.length > 0 && (
                  <p className="creative-brief-rec-evidence">
                    <small>Evidence: {formatEvidence(rec.evidence)}</small>
                  </p>
                )}
                {rec.scope && (
                  <p className="creative-brief-rec-scope">
                    <small>
                      Scope: {rec.scope.sceneIds?.join(', ') ?? ''}{' '}
                      {rec.scope.elementIds?.join(', ') ?? ''}
                    </small>
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="creative-brief-empty">No recommendations</p>
        )}
      </section>

      {/* Blockers */}
      {brief.blockedBy.length > 0 && (
        <section className="creative-brief-section" aria-label="Blockers">
          <h3 className="creative-brief-heading">Blocked By</h3>
          <ul className="creative-brief-list">
            {brief.blockedBy.map((blocker) => (
              <li key={blocker.id} className="creative-brief-blocker">
                <span className="creative-brief-capability">{blocker.capability}</span>
                <span className="creative-brief-status"> [{blocker.status}]</span>
                <p>{blocker.message}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Human Decisions */}
      {brief.requiresHumanDecision.length > 0 && (
        <section className="creative-brief-section" aria-label="Human decisions required">
          <h3 className="creative-brief-heading">Requires Human Decision</h3>
          <ul className="creative-brief-list">
            {brief.requiresHumanDecision.map((decision) => (
              <li key={decision.id} className="creative-brief-decision">
                <p>
                  <strong>Question:</strong> {decision.question}
                </p>
                <p>
                  <strong>Context:</strong> {decision.context}
                </p>
                <p>
                  <small>Options: {decision.options.join(', ')}</small>
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Warnings */}
      {brief.warnings.length > 0 && (
        <section className="creative-brief-section" aria-label="Warnings">
          <h3 className="creative-brief-heading">Warnings</h3>
          <ul className="creative-brief-list">
            {brief.warnings.map((warning, index) => (
              <li
                key={index}
                className={`creative-brief-warning creative-brief-warning-${warning.severity}`}
              >
                <span className="creative-brief-warning-label">
                  [{SEVERITY_LABEL[warning.severity]}]
                </span>
                <span> {warning.message}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Metadata */}
      <section className="creative-brief-section creative-brief-meta" aria-label="Brief metadata">
        <p>
          <small>Snapshot revision: {brief.snapshotRevisionId}</small>
        </p>
        <p>
          <small>Project: {brief.projectId}</small>
        </p>
        <p>
          <small>
            Generated: {brief.meta.generatedAt} | Adapter: {brief.meta.modelAdapter} | Processing:{' '}
            {brief.meta.processingTimeMs}ms
          </small>
        </p>
      </section>
    </article>
  );
}
