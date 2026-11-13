import type { AgentPolicyPreferences } from './agent-policy-settings.js';
import { providerLabel } from './provider-labels.js';
import {
  framePrivacyNoticeWithModel,
  SETTINGS_FRAME_PRIVACY_NOTICE,
  SETTINGS_MODELS,
} from './settings-wording.js';
import './QualityCheckPrivacyNotice.css';

/** The destination described by saved preferences for a future quality check. */
export type FrameDestination = 'no-model' | 'kept-on-pc' | 'remote';

export interface QualityCheckPrivacyNoticeInput {
  /** The provider of the connected session, as the session reports it. */
  readonly provider?: string | undefined;
  /** The model of the connected session. Empty or missing means no model is connected. */
  readonly modelId?: string | undefined;
  readonly framesPerCheck: number;
  readonly framesPerRun: number;
  readonly neverSendFramesToRemoteModel: boolean;
  readonly localOnly: boolean;
}

/** Builds the privacy-notice input from saved preferences and the connected session. */
export function qualityCheckPrivacyNoticeInput(
  policy: AgentPolicyPreferences,
  session: { readonly provider?: string | undefined; readonly modelId?: string | undefined },
): QualityCheckPrivacyNoticeInput {
  return {
    provider: session.provider,
    modelId: session.modelId,
    framesPerCheck: policy.qualityCheck.framesPerCheck,
    framesPerRun: policy.qualityCheck.framesPerRun,
    neverSendFramesToRemoteModel: policy.qualityCheck.neverSendFramesToRemoteModel,
    localOnly: policy.privacyMode === 'local-only',
  };
}

export function frameDestinationOf(input: QualityCheckPrivacyNoticeInput): FrameDestination {
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

/** The one line that summarizes saved picture settings, in plain words. */
export function framePrivacyNoticeLine(input: QualityCheckPrivacyNoticeInput): string {
  const destination = frameDestinationOf(input);
  if (destination === 'no-model') return SETTINGS_FRAME_PRIVACY_NOTICE.noModel;
  if (destination === 'kept-on-pc') {
    return input.neverSendFramesToRemoteModel
      ? SETTINGS_FRAME_PRIVACY_NOTICE.neverRemote
      : SETTINGS_FRAME_PRIVACY_NOTICE.localOnly;
  }
  return framePrivacyNoticeWithModel(
    input.framesPerCheck,
    input.framesPerRun,
    providerNameOf(input.provider),
    (input.modelId ?? '').trim(),
  );
}

/** A settings notice about the saved quality-check limits and privacy choice. */
export function QualityCheckPrivacyNotice(input: QualityCheckPrivacyNoticeInput) {
  const destination = frameDestinationOf(input);
  return (
    <section
      className="quality-check-privacy-notice"
      data-frame-destination={destination}
      aria-label={SETTINGS_FRAME_PRIVACY_NOTICE.title}
    >
      <p className="quality-check-privacy-notice__title">{SETTINGS_FRAME_PRIVACY_NOTICE.title}</p>
      <p className="quality-check-privacy-notice__line">{framePrivacyNoticeLine(input)}</p>
      {destination === 'remote' && (
        <p className="quality-check-privacy-notice__pending">
          {SETTINGS_FRAME_PRIVACY_NOTICE.approvalUnavailable}
        </p>
      )}
    </section>
  );
}
