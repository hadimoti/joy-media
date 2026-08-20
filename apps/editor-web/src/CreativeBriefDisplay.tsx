/**
 * Read-only Creative Brief presentation.
 *
 * This component deliberately renders only validated brief data. It does not
 * create snapshots, call providers, mutate project state, or expose actions.
 */

import type { CreativeBriefV1 } from '@joy-media/agent-tools';
import {
  createCreativeBriefMetrics,
  formatBriefEvidence,
  type CreativeBriefEvidence,
} from './creative-brief-presentation.js';

export interface CreativeBriefDisplayProps {
  readonly brief: CreativeBriefV1;
}

const RISK_LABEL: Record<CreativeBriefV1['recommendations'][number]['risk'], string> = {
  none: 'No risk',
  'reversible-local': 'Reversible',
  destructive: 'Destructive',
  'remote-egress': 'Network required',
  spend: 'Costs apply',
};

const CONFIDENCE_LABEL: Record<'low' | 'medium' | 'high', string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
};

const SEVERITY_LABEL: Record<'info' | 'suggestion' | 'warning' | 'error', string> = {
  info: 'Info',
  suggestion: 'Suggestion',
  warning: 'Warning',
  error: 'Error',
};

function evidenceText(evidence: readonly CreativeBriefEvidence[]): string {
  return formatBriefEvidence(evidence);
}

function Badge({
  children,
  tone = 'neutral',
}: {
  readonly children: string;
  readonly tone?: string;
}) {
  return <span className={`creative-brief-badge creative-brief-badge-${tone}`}>{children}</span>;
}

function FindingsList({ brief }: { readonly brief: CreativeBriefV1 }) {
  const { facts, inferences } = brief.distinction;
  return (
    <div className="creative-brief-findings">
      <section className="creative-brief-section" aria-label="Factual findings">
        <div className="creative-brief-section-heading">
          <span className="creative-brief-eyebrow">Verified from project data</span>
          <h3 className="creative-brief-heading">Factual findings</h3>
        </div>
        {facts.length > 0 ? (
          <ul className="creative-brief-list">
            {facts.map((fact) => (
              <li key={fact.id} className="creative-brief-fact">
                <p className="creative-brief-statement" dir="auto">
                  {fact.statement}
                </p>
                <div className="creative-brief-item-meta">
                  <Badge tone="source">Source: {fact.source}</Badge>
                  {fact.evidence.length > 0 && (
                    <span className="creative-brief-evidence" dir="auto">
                      {evidenceText(fact.evidence)}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="creative-brief-empty" dir="auto">
            No factual findings.
          </p>
        )}
      </section>

      <section className="creative-brief-section" aria-label="Model inferences">
        <div className="creative-brief-section-heading">
          <span className="creative-brief-eyebrow">Reasoned interpretation</span>
          <h3 className="creative-brief-heading">Model inferences</h3>
        </div>
        {inferences.length > 0 ? (
          <ul className="creative-brief-list">
            {inferences.map((inference) => (
              <li key={inference.id} className="creative-brief-inference">
                <div className="creative-brief-item-heading">
                  <p className="creative-brief-statement" dir="auto">
                    {inference.statement}
                  </p>
                  <Badge tone="confidence">
                    Confidence: {CONFIDENCE_LABEL[inference.confidence]}
                  </Badge>
                </div>
                {inference.rationale && (
                  <p className="creative-brief-rationale" dir="auto">
                    {inference.rationale}
                  </p>
                )}
                {inference.evidence.length > 0 && (
                  <p className="creative-brief-evidence" dir="auto">
                    Evidence: {evidenceText(inference.evidence)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="creative-brief-empty" dir="auto">
            No model inferences.
          </p>
        )}
      </section>
    </div>
  );
}

function CreativeBriefRecommendations({ brief }: { readonly brief: CreativeBriefV1 }) {
  return (
    <section
      className="creative-brief-section creative-brief-recommendations"
      aria-label="Recommendations"
    >
      <div className="creative-brief-section-heading">
        <span className="creative-brief-eyebrow">Next best steps</span>
        <h3 className="creative-brief-heading">Recommendations</h3>
      </div>
      {brief.recommendations.length > 0 ? (
        <ol className="creative-brief-list">
          {brief.recommendations.map((recommendation) => (
            <li key={recommendation.id} className="creative-brief-recommendation">
              <div className="creative-brief-item-heading">
                <span className="creative-brief-rec-kind">{recommendation.kind}</span>
                <div className="creative-brief-badges" aria-label="Recommendation metadata">
                  <Badge tone="risk">{RISK_LABEL[recommendation.risk]}</Badge>
                  <Badge tone="confidence">
                    Confidence: {CONFIDENCE_LABEL[recommendation.confidence]}
                  </Badge>
                </div>
              </div>
              <p className="creative-brief-rec-rationale" dir="auto">
                {recommendation.rationale}
              </p>
              <p className="creative-brief-rec-benefit" dir="auto">
                <strong>Expected benefit:</strong> {recommendation.expectedBenefit}
              </p>
              {recommendation.proposedIntent && (
                <p className="creative-brief-rec-intent" dir="auto">
                  Suggested intent: {recommendation.proposedIntent}
                </p>
              )}
              {recommendation.evidence.length > 0 && (
                <p className="creative-brief-rec-evidence" dir="auto">
                  Evidence: {evidenceText(recommendation.evidence)}
                </p>
              )}
            </li>
          ))}
        </ol>
      ) : (
        <p className="creative-brief-empty" dir="auto">
          No recommendations.
        </p>
      )}
    </section>
  );
}

function CreativeBriefAttention({ brief }: { readonly brief: CreativeBriefV1 }) {
  const hasAttention =
    brief.warnings.length > 0 ||
    brief.blockedBy.length > 0 ||
    brief.requiresHumanDecision.length > 0;
  if (!hasAttention) return null;

  return (
    <section className="creative-brief-section" aria-label="Needs attention">
      <div className="creative-brief-section-heading">
        <span className="creative-brief-eyebrow">Review before acting</span>
        <h3 className="creative-brief-heading">Needs attention</h3>
      </div>
      <div className="creative-brief-attention-list">
        {brief.warnings.map((warning, index) => (
          <div
            key={`warning-${index}`}
            className={`creative-brief-attention creative-brief-warning-${warning.severity}`}
          >
            <Badge tone="status">{SEVERITY_LABEL[warning.severity]}</Badge>
            <span dir="auto">{warning.message}</span>
          </div>
        ))}
        {brief.blockedBy.map((blocker) => (
          <div key={blocker.id} className="creative-brief-attention">
            <Badge tone="status">Blocked: {blocker.status}</Badge>
            <span dir="auto">{blocker.message}</span>
          </div>
        ))}
        {brief.requiresHumanDecision.map((decision) => (
          <div key={decision.id} className="creative-brief-attention creative-brief-decision">
            <Badge tone="status">Decision needed</Badge>
            <div>
              <p dir="auto">
                <strong dir="auto">{decision.question}</strong>
              </p>
              <p dir="auto">{decision.context}</p>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function CreativeBriefAssumptions({ brief }: { readonly brief: CreativeBriefV1 }) {
  if (brief.assumptions.length === 0) return null;
  return (
    <section className="creative-brief-section" aria-label="Assumptions">
      <div className="creative-brief-section-heading">
        <span className="creative-brief-eyebrow">Context to verify</span>
        <h3 className="creative-brief-heading">Assumptions</h3>
      </div>
      <ul className="creative-brief-list">
        {brief.assumptions.map((assumption) => (
          <li key={assumption.id} className="creative-brief-assumption">
            <div className="creative-brief-item-heading">
              <span className="creative-brief-statement" dir="auto">
                {assumption.statement}
              </span>
              <div className="creative-brief-badges">
                <Badge tone={assumption.verified ? 'verified' : 'status'}>
                  {assumption.verified ? 'Verified' : 'Unverified'}
                </Badge>
                <Badge tone="confidence">
                  Confidence: {CONFIDENCE_LABEL[assumption.confidence]}
                </Badge>
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function CreativeBriefDisplay({ brief }: CreativeBriefDisplayProps) {
  const metrics = createCreativeBriefMetrics(brief);
  return (
    <article className="creative-brief" aria-label="Creative brief">
      <section
        className="creative-brief-section creative-brief-overview"
        aria-label="Creative direction"
      >
        <div className="creative-brief-section-heading">
          <span className="creative-brief-eyebrow">Overview</span>
          <h3 className="creative-brief-heading">Creative direction</h3>
        </div>
        <div className="creative-brief-goal">
          <div className="creative-brief-item-heading">
            <p className="creative-brief-goal-text" dir="auto">
              {brief.interpretedGoal.resolvedGoal}
            </p>
            <Badge tone="confidence">
              Confidence: {CONFIDENCE_LABEL[brief.interpretedGoal.confidence]}
            </Badge>
          </div>
          <p className="creative-brief-request" dir="auto">
            {brief.request}
          </p>
        </div>
        {metrics.length > 0 && (
          <dl className="creative-brief-metrics" aria-label="Project overview metrics">
            {metrics.map((metric) => (
              <div key={metric.id} className="creative-brief-metric">
                <dt>{metric.label}</dt>
                <dd dir="auto">{metric.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </section>

      <CreativeBriefRecommendations brief={brief} />
      <FindingsList brief={brief} />
      <CreativeBriefAttention brief={brief} />
      <CreativeBriefAssumptions brief={brief} />

      <section className="creative-brief-section creative-brief-technical">
        <details>
          <summary>Technical details</summary>
          <dl className="creative-brief-meta" aria-label="Brief metadata">
            <div>
              <dt>Snapshot revision</dt>
              <dd>{brief.snapshotRevisionId}</dd>
            </div>
            <div>
              <dt>Project</dt>
              <dd>{brief.projectId}</dd>
            </div>
            <div>
              <dt>Generated</dt>
              <dd>{brief.meta.generatedAt}</dd>
            </div>
            <div>
              <dt>Adapter</dt>
              <dd>{brief.meta.modelAdapter}</dd>
            </div>
            <div>
              <dt>Processing</dt>
              <dd>{brief.meta.processingTimeMs}ms</dd>
            </div>
          </dl>
        </details>
      </section>
    </article>
  );
}
