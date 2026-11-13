// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import {
  frameConsentLine,
  frameDestinationOf,
  QualityCheckConsentCard,
  qualityCheckConsentInput,
  type QualityCheckConsentInput,
} from './QualityCheckConsentCard.js';
import { SETTINGS_FRAME_CONSENT, SETTINGS_MODELS } from './settings-wording.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A connected OpenRouter session with the defaults of the quality check. */
const connected: QualityCheckConsentInput = {
  provider: 'openrouter',
  modelId: 'openrouter/auto',
  framesPerCheck: 12,
  framesPerRun: 16,
  neverSendFramesToRemoteModel: false,
  localOnly: false,
};

describe('the quality check consent card (T-B05)', () => {
  it('says how many pictures go to which provider and model', () => {
    expect(frameConsentLine(connected)).toBe(
      'Up to 12 pictures a check and 16 a run go to OpenRouter, model openrouter/auto.',
    );
    expect(frameDestinationOf(connected)).toBe('remote');
  });

  it('names a custom endpoint as your own endpoint, not by its code name', () => {
    const line = frameConsentLine({
      ...connected,
      provider: 'openai-compatible',
      modelId: 'local/model',
    });
    expect(line).toContain(`${SETTINGS_MODELS.yourOwnEndpoint}, model local/model.`);
    expect(line).not.toContain('openai-compatible');
  });

  it('follows the budgets the user has set', () => {
    const line = frameConsentLine({ ...connected, framesPerCheck: 4, framesPerRun: 40 });
    expect(line).toBe(
      'Up to 4 pictures a check and 40 a run go to OpenRouter, model openrouter/auto.',
    );
  });

  it('sends nothing anywhere when no model is connected', () => {
    expect(frameConsentLine({ ...connected, modelId: undefined })).toBe(
      SETTINGS_FRAME_CONSENT.noModel,
    );
    expect(frameConsentLine({ ...connected, modelId: '  ' })).toBe(SETTINGS_FRAME_CONSENT.noModel);
    expect(frameDestinationOf({ ...connected, provider: undefined, modelId: undefined })).toBe(
      'no-model',
    );
  });

  it('keeps pictures on this PC when the switch is on', () => {
    const input = { ...connected, neverSendFramesToRemoteModel: true };
    expect(frameDestinationOf(input)).toBe('kept-on-pc');
    expect(frameConsentLine(input)).toBe(SETTINGS_FRAME_CONSENT.neverRemote);
  });

  it('keeps pictures on this PC in local-only mode', () => {
    const input = { ...connected, localOnly: true };
    expect(frameDestinationOf(input)).toBe('kept-on-pc');
    expect(frameConsentLine(input)).toBe(SETTINGS_FRAME_CONSENT.localOnly);
  });

  it('reads the saved policy and the connected session', () => {
    const policy = {
      ...DEFAULT_AGENT_POLICY,
      privacyMode: 'local-only' as const,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, framesPerRun: 24 },
    };
    const input = qualityCheckConsentInput(policy, {
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

    async function renderCard(input: QualityCheckConsentInput): Promise<HTMLElement> {
      await act(async () => {
        root?.render(<QualityCheckConsentCard {...input} />);
      });
      const section = container?.querySelector<HTMLElement>('.quality-check-consent');
      if (section === null || section === undefined) throw new Error('The card must render');
      return section;
    }

    it('states the destination and asks first when pictures may be sent', async () => {
      const section = await renderCard(connected);

      expect(section.getAttribute('data-frame-destination')).toBe('remote');
      expect(section.getAttribute('aria-label')).toBe(SETTINGS_FRAME_CONSENT.title);
      expect(section.textContent).toContain(SETTINGS_FRAME_CONSENT.askFirst);
      expect(section.textContent).toContain(
        'Up to 12 pictures a check and 16 a run go to OpenRouter, model openrouter/auto.',
      );
    });

    it('does not promise a review when no picture can leave the PC', async () => {
      const section = await renderCard({ ...connected, neverSendFramesToRemoteModel: true });

      expect(section.getAttribute('data-frame-destination')).toBe('kept-on-pc');
      expect(section.textContent).toContain(SETTINGS_FRAME_CONSENT.neverRemote);
      expect(section.textContent).not.toContain(SETTINGS_FRAME_CONSENT.askFirst);
    });
  });
});
