import type { GenerationKind } from '@joy-media/provider-sdk';
import { generationCostLine } from './generation-cost-estimates.js';

const KIND_NAME: Readonly<Record<GenerationKind, string>> = {
  image: 'Picture',
  video: 'Video',
};

export interface GenerationCostCardProps {
  readonly kind: GenerationKind;
  /** The provider's display name, for example "MiniMax". */
  readonly providerName: string;
  /** Allow is the only way a provider request starts (T-C04). */
  readonly onAllow: () => void;
  readonly onDecline: () => void;
}

/**
 * The cost card shown before every generated picture or video (T-C07). It is presentational: the price comes from
 * `generation-cost-estimates.ts`, and the host wires Allow and Decline to the approval of `generate_media`.
 */
export function GenerationCostCard({
  kind,
  providerName,
  onAllow,
  onDecline,
}: GenerationCostCardProps) {
  return (
    <div
      className="joy-code-connect-card joy-generation-cost-card"
      role="group"
      aria-label="Generation cost"
    >
      <p className="joy-code-connect-card-message">
        {providerName} · {KIND_NAME[kind]}
      </p>
      <p className="joy-code-connect-card-message">{generationCostLine(kind)}</p>
      <div>
        <button type="button" className="button-primary" onClick={onAllow}>
          Allow
        </button>{' '}
        <button type="button" className="button-secondary" onClick={onDecline}>
          Decline
        </button>
      </div>
    </div>
  );
}
