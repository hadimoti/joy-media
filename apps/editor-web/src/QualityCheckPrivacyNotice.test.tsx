// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import {
  framePrivacyNoticeLine,
  frameDestinationOf,
  QualityCheckPrivacyNotice,
  qualityCheckPrivacyNoticeInput,
  type QualityCheckPrivacyNoticeInput,
} from './QualityCheckPrivacyNotice.js';
import { SETTINGS_FRAME_PRIVACY_NOTICE, SETTINGS_MODELS } from './settings-wording.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A connected OpenRouter session with the defaults of the quality check. */
const connected: QualityCheckPrivacyNoticeInput = {
  provider: 'openrouter',
  modelId: 'openrouter/auto',
  framesPerCheck: 12,
  framesPerRun: 16,
  neverSendFramesToRemoteModel: false,
  localOnly: false,
};

describe('the quality check privacy notice (T-B05)', () => {
  it('shows saved limits and the model for a future quality check', () => {
    expect(framePrivacyNoticeLine(connected)).toBe(
      'For a future quality check, the saved limits are 12 pictures per check and 16 across the run, with OpenRouter, model openrouter/auto.',
    );
    expect(frameDestinationOf(connected)).toBe('remote');
  });

  it('names a custom endpoint as your own endpoint, not by its code name', () => {
    const line = framePrivacyNoticeLine({
      ...connected,
      provider: 'openai-compatible',
      modelId: 'local/model',
    });
    expect(line).toContain(`${SETTINGS_MODELS.yourOwnEndpoint}, model local/model.`);
    expect(line).not.toContain('openai-compatible');
  });

  it('follows the budgets the user has set', () => {
    const line = framePrivacyNoticeLine({ ...connected, framesPerCheck: 4, framesPerRun: 40 });
    expect(line).toBe(
      'For a future quality check, the saved limits are 4 pictures per check and 40 across the run, with OpenRouter, model openrouter/auto.',
    );
  });

  it('shows the saved no-model state when no model is connected', () => {
    expect(framePrivacyNoticeLine({ ...connected, modelId: undefined })).toBe(
      SETTINGS_FRAME_PRIVACY_NOTICE.noModel,
    );
    expect(framePrivacyNoticeLine({ ...connected, modelId: '  ' })).toBe(
      SETTINGS_FRAME_PRIVACY_NOTICE.noModel,
    );
    expect(frameDestinationOf({ ...connected, provider: undefined, modelId: undefined })).toBe(
      'no-model',
    );
  });

  it('describes the saved local preference when the switch is on', () => {
    const input = { ...connected, neverSendFramesToRemoteModel: true };
    expect(frameDestinationOf(input)).toBe('kept-on-pc');
    expect(framePrivacyNoticeLine(input)).toBe(SETTINGS_FRAME_PRIVACY_NOTICE.neverRemote);
  });

  it('describes the saved local-only preference', () => {
    const input = { ...connected, localOnly: true };
    expect(frameDestinationOf(input)).toBe('kept-on-pc');
    expect(framePrivacyNoticeLine(input)).toBe(SETTINGS_FRAME_PRIVACY_NOTICE.localOnly);
  });

  it('reads the saved policy and the connected session', () => {
    const policy = {
      ...DEFAULT_AGENT_POLICY,
      privacyMode: 'local-only' as const,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, framesPerRun: 24 },
    };
    const input = qualityCheckPrivacyNoticeInput(policy, {
      provider: 'openrouter',
      modelId: 'openrouter/auto',
    });
    expect(input).toEqual({
      provider: 'openrouter',
      modelId: 'openrouter/auto',
      framesPerCheck: 12,
      framesPerRun: 24,
      neverSendFramesToRemoteModel: false,
      localOnly: true,
    });
  });

  describe('when rendered', () => {
    let root: Root | undefined;
    let container: HTMLDivElement | undefined;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
    });

    afterEach(async () => {
      await act(async () => root?.unmount());
      container?.remove();
      root = undefined;
      container = undefined;
    });

    async function renderCard(input: QualityCheckPrivacyNoticeInput): Promise<HTMLElement> {
      await act(async () => {
        root?.render(<QualityCheckPrivacyNotice {...input} />);
      });
      const section = container?.querySelector<HTMLElement>('.quality-check-privacy-notice');
      if (section === null || section === undefined) throw new Error('The card must render');
      return section;
    }

    it('shows saved remote settings and says picture approval is not available yet', async () => {
      const section = await renderCard(connected);

      expect(section.getAttribute('data-frame-destination')).toBe('remote');
      expect(section.getAttribute('aria-label')).toBe(SETTINGS_FRAME_PRIVACY_NOTICE.title);
      expect(section.textContent).toContain(SETTINGS_FRAME_PRIVACY_NOTICE.approvalUnavailable);
      expect(section.textContent).toContain(
        'For a future quality check, the saved limits are 12 pictures per check and 16 across the run, with OpenRouter, model openrouter/auto.',
      );
    });

    it('does not show picture approval as available when it is not available yet', async () => {
      const section = await renderCard({ ...connected, neverSendFramesToRemoteModel: true });

      expect(section.getAttribute('data-frame-destination')).toBe('kept-on-pc');
      expect(section.textContent).toContain(SETTINGS_FRAME_PRIVACY_NOTICE.neverRemote);
      expect(section.textContent).not.toContain(SETTINGS_FRAME_PRIVACY_NOTICE.approvalUnavailable);
    });
  });
});
