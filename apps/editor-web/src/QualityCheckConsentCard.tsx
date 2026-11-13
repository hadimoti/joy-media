import type { AgentPolicyPreferences } from './agent-policy-settings.js';
import { providerLabel } from './provider-labels.js';
import {
  frameConsentWithModel,
  SETTINGS_FRAME_CONSENT,
  SETTINGS_MODELS,
} from './settings-wording.js';
import './QualityCheckConsentCard.css';

/**
 * Where a quality check's pictures go:
 * - `no-model`: no model is connected, so no picture goes anywhere;
 * - `kept-on-pc`: the switch or local-only mode keeps every picture on this PC;
 * - `remote`: pictures go to the connected provider and model.
 */
export type FrameDestination = 'no-model' | 'kept-on-pc' | 'remote';

export interface QualityCheckConsentInput {
  /** The provider of the connected session, as the session reports it. */
  readonly provider?: string | undefined;
  /** The model of the connected session. Empty or missing means no model is connected. */
  readonly modelId?: string | undefined;
  readonly framesPerCheck: number;
  readonly framesPerRun: number;
  readonly neverSendFramesToRemoteModel: boolean;
  readonly localOnly: boolean;
}

/** Builds the consent input from the saved policy and the connected session. */
export function qualityCheckConsentInput(
  policy: AgentPolicyPreferences,
  session: { readonly provider?: string | undefined; readonly modelId?: string | undefined },
): QualityCheckConsentInput {
  return {
    provider: session.provider,
    modelId: session.modelId,
    framesPerCheck: policy.qualityCheck.framesPerCheck,
    framesPerRun: policy.qualityCheck.framesPerRun,
    neverSendFramesToRemoteModel: policy.qualityCheck.neverSendFramesToRemoteModel,
    localOnly: policy.privacyMode === 'local-only',
  };
}

export function frameDestinationOf(input: QualityCheckConsentInput): FrameDestination {
  if (input.modelId === undefined || input.modelId.trim() === '') return 'no-model';
  if (input.neverSendFramesToRemoteModel || input.localOnly) return 'kept-on-pc';
  return 'remote';
}

/** The provider's name in plain words. A custom endpoint is named as one. */
function providerNameOf(provider: string | undefined): string {
  if (provider === undefined || provider.trim() === '') return SETTINGS_MODELS.providerTagNone;
  if (provider === 'openai-compatible' || provider === 'custom') {
    return SETTINGS_MODELS.yourOwnEndpoint;
  }
  return providerLabel(provider);
}

/** The one line that says where pictures go, in plain words. */
export function frameConsentLine(input: QualityCheckConsentInput): string {
  const destination = frameDestinationOf(input);
  if (destination === 'no-model') return SETTINGS_FRAME_CONSENT.noModel;
  if (destination === 'kept-on-pc') {
    return input.neverSendFramesToRemoteModel
      ? SETTINGS_FRAME_CONSENT.neverRemote
      : SETTINGS_FRAME_CONSENT.localOnly;
  }
  return frameConsentWithModel(
    input.framesPerCheck,
    input.framesPerRun,
    providerNameOf(input.provider),
    (input.modelId ?? '').trim(),
  );
}

/** The card in Joy Code settings that states how many pictures go to which provider and model. */
export function QualityCheckConsentCard(input: QualityCheckConsentInput) {
  const destination = frameDestinationOf(input);
  return (
    <section
      className="quality-check-consent"
      data-frame-destination={destination}
      aria-label={SETTINGS_FRAME_CONSENT.title}
    >
      <p className="quality-check-consent__title">{SETTINGS_FRAME_CONSENT.title}</p>
      <p className="quality-check-consent__line">{frameConsentLine(input)}</p>
      {destination === 'remote' && (
        <p className="quality-check-consent__ask">{SETTINGS_FRAME_CONSENT.askFirst}</p>
      )}
    </section>
  );
}
