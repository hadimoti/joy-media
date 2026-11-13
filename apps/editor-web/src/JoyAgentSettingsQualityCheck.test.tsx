// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_POLICY, type AgentPolicyPreferences } from './agent-policy-settings.js';
import { JoyAgentSettingsDialog } from './JoyAgentSettingsDialog.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type { ByokSessionStatus } from './joy-agent/protocol.js';
import {
  qualityCheckTag,
  SETTINGS_FRAME_PRIVACY_NOTICE,
  SETTINGS_QUALITY_CHECK,
} from './settings-wording.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * T-B05 — the Quality check section of Joy Code settings, on the "Safety and limits" page.
 * It shows the ADR defaults, writes each budget through the policy with its bounds applied, and
 * states where a check's pictures go.
 */
describe('the Quality check section of Joy Code settings (T-B05)', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  const engineClient = (): JoyAgentEngineClient =>
    ({
      configure: vi.fn().mockResolvedValue(undefined),
      testConnection: vi.fn().mockResolvedValue(undefined),
      probeMediaCapabilities: vi.fn().mockResolvedValue(undefined),
      startRun: vi.fn(),
      cancelRun: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      dispose: vi.fn(),
      getStatus: vi.fn(() => undefined),
      getMediaCapabilities: vi.fn(() => undefined),
    }) as unknown as JoyAgentEngineClient;

  const connectedStatus: ByokSessionStatus = {
    provider: 'openrouter',
    modelId: 'openrouter/auto',
    capability: 'tool-loop',
  };

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

  async function render(
    policy: AgentPolicyPreferences,
    onPolicyChange: (next: AgentPolicyPreferences) => void,
    status?: ByokSessionStatus,
  ): Promise<HTMLElement> {
    await act(async () => {
      root?.render(
        <JoyAgentSettingsDialog
          policy={policy}
          onPolicyChange={onPolicyChange}
          engineClient={engineClient()}
          {...(status === undefined ? {} : { status })}
          onClose={vi.fn()}
          initialTab="execution"
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
    });
    if (container === undefined) throw new Error('The dialog must be rendered');
    return container;
  }

  /** Opens the Quality check section, as the owner does. */
  async function openQualityCheck(rendered: HTMLElement): Promise<void> {
    const trigger = [
      ...rendered.querySelectorAll<HTMLButtonElement>('.joy-accordion-trigger'),
    ].find((candidate) => candidate.textContent?.includes(SETTINGS_QUALITY_CHECK.title));
    if (trigger === undefined) throw new Error('Expected the Quality check section');
    await act(async () => {
      trigger.click();
      await Promise.resolve();
    });
  }

  /** The field that has this label, as the owner sees it. */
  function fieldLabelled(rendered: HTMLElement, label: string): HTMLInputElement {
    const field = [...rendered.querySelectorAll<HTMLLabelElement>('label')].find(
      (candidate) => candidate.querySelector('span')?.textContent === label,
    );
    const input = field?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error(`Expected a field labelled "${label}"`);
    return input;
  }

  /** Types a value into a number field the way the browser does. */
  async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
  }

  it('shows the ADR defaults and the tag of the section', async () => {
    const rendered = await render(DEFAULT_AGENT_POLICY, vi.fn());
    const trigger = [
      ...rendered.querySelectorAll<HTMLButtonElement>('.joy-accordion-trigger'),
    ].find((candidate) => candidate.textContent?.includes(SETTINGS_QUALITY_CHECK.title));

    expect(trigger?.textContent).toContain(qualityCheckTag(12, 3));
    await openQualityCheck(rendered);

    expect(fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.framesPerCheckLabel).value).toBe('12');
    expect(fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.framesPerRunLabel).value).toBe('16');
    expect(fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.fixRoundsLabel).value).toBe('3');
    const neverSend = fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.neverRemoteLabel);
    expect(neverSend.type).toBe('checkbox');
    expect(neverSend.checked).toBe(false);
  });

  it('uses singular words for a one-frame, one-round limit', () => {
    expect(qualityCheckTag(1, 1)).toBe('1 frame a check, 1 fix round');
  });

  it('keeps a multi-digit run budget while typing and commits it on blur', async () => {
    const onPolicyChange = vi.fn();
    const rendered = await render(DEFAULT_AGENT_POLICY, onPolicyChange);
    await openQualityCheck(rendered);

    const framesPerRun = fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.framesPerRunLabel);
    await act(async () => framesPerRun.focus());
    await typeInto(framesPerRun, '2');
    expect(framesPerRun.value).toBe('2');
    expect(onPolicyChange).not.toHaveBeenCalled();

    await typeInto(framesPerRun, '20');
    expect(framesPerRun.value).toBe('20');
    expect(onPolicyChange).not.toHaveBeenCalled();

    await act(async () => framesPerRun.blur());
    expect(onPolicyChange).toHaveBeenLastCalledWith({
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, framesPerRun: 20 },
    });
  });

  it('clamps a run budget on Enter and keeps the check budget within it', async () => {
    const onPolicyChange = vi.fn();
    const policy = {
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, framesPerCheck: 16 },
    };
    const rendered = await render(policy, onPolicyChange);
    await openQualityCheck(rendered);

    const framesPerRun = fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.framesPerRunLabel);
    await act(async () => framesPerRun.focus());
    await typeInto(framesPerRun, '5');
    expect(framesPerRun.value).toBe('5');
    expect(onPolicyChange).not.toHaveBeenCalled();
    await act(async () => {
      framesPerRun.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onPolicyChange).toHaveBeenLastCalledWith({
      ...policy,
      qualityCheck: { ...policy.qualityCheck, framesPerCheck: 12, framesPerRun: 12 },
    });
  });

  it('clamps the check and round budgets when they are committed', async () => {
    const onPolicyChange = vi.fn();
    const rendered = await render(DEFAULT_AGENT_POLICY, onPolicyChange);
    await openQualityCheck(rendered);

    const framesPerCheck = fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.framesPerCheckLabel);
    await act(async () => framesPerCheck.focus());
    await typeInto(framesPerCheck, '40');
    expect(framesPerCheck.value).toBe('40');
    await act(async () => framesPerCheck.blur());
    expect(onPolicyChange).toHaveBeenLastCalledWith({
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, framesPerCheck: 16 },
    });

    const fixRounds = fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.fixRoundsLabel);
    await act(async () => fixRounds.focus());
    await typeInto(fixRounds, '0');
    expect(fixRounds.value).toBe('0');
    await act(async () => fixRounds.blur());
    expect(onPolicyChange).toHaveBeenLastCalledWith({
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, fixRounds: 1 },
    });
  });

  it('keeps a changed check budget at or below the saved run budget', async () => {
    const onPolicyChange = vi.fn();
    const policy = {
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, framesPerRun: 12 },
    };
    const rendered = await render(policy, onPolicyChange);
    await openQualityCheck(rendered);

    const framesPerCheck = fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.framesPerCheckLabel);
    await act(async () => framesPerCheck.focus());
    await typeInto(framesPerCheck, '16');
    expect(framesPerCheck.value).toBe('16');
    await act(async () => framesPerCheck.blur());

    expect(onPolicyChange).toHaveBeenLastCalledWith({
      ...policy,
      qualityCheck: { ...policy.qualityCheck, framesPerCheck: 12 },
    });
  });

  it('turns the never-send switch on through the policy', async () => {
    const onPolicyChange = vi.fn();
    const rendered = await render(DEFAULT_AGENT_POLICY, onPolicyChange);
    await openQualityCheck(rendered);

    const neverSend = fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.neverRemoteLabel);
    await act(async () => {
      neverSend.click();
    });

    expect(onPolicyChange).toHaveBeenLastCalledWith({
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, neverSendFramesToRemoteModel: true },
    });
  });

  it('shows saved limits and model settings for the future quality check', async () => {
    const rendered = await render(DEFAULT_AGENT_POLICY, vi.fn(), connectedStatus);
    await openQualityCheck(rendered);

    const card = rendered.querySelector<HTMLElement>('.quality-check-privacy-notice');
    expect(card?.getAttribute('data-frame-destination')).toBe('remote');
    expect(card?.textContent).toContain(
      'For a future quality check, the saved limits are 12 pictures per check and 16 across the run, with OpenRouter, model openrouter/auto.',
    );
    expect(card?.textContent).toContain(SETTINGS_FRAME_PRIVACY_NOTICE.approvalUnavailable);
  });

  it('shows that no model is connected without claiming a quality check is running', async () => {
    const rendered = await render(DEFAULT_AGENT_POLICY, vi.fn());
    await openQualityCheck(rendered);

    const card = rendered.querySelector<HTMLElement>('.quality-check-privacy-notice');
    expect(card?.getAttribute('data-frame-destination')).toBe('no-model');
    expect(card?.textContent).toContain(SETTINGS_FRAME_PRIVACY_NOTICE.noModel);
  });

  it('shows the saved local privacy choice when the switch is on', async () => {
    const policy: AgentPolicyPreferences = {
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, neverSendFramesToRemoteModel: true },
    };
    const rendered = await render(policy, vi.fn(), connectedStatus);
    await openQualityCheck(rendered);

    const card = rendered.querySelector<HTMLElement>('.quality-check-privacy-notice');
    expect(card?.getAttribute('data-frame-destination')).toBe('kept-on-pc');
    expect(card?.textContent).toContain(SETTINGS_FRAME_PRIVACY_NOTICE.neverRemote);
    expect(card?.textContent).not.toContain(SETTINGS_FRAME_PRIVACY_NOTICE.approvalUnavailable);
  });
});
