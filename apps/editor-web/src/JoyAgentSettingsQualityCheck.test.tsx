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
  SETTINGS_FRAME_CONSENT,
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

  it('writes a typed budget through the policy, held inside its bounds', async () => {
    const onPolicyChange = vi.fn();
    const rendered = await render(DEFAULT_AGENT_POLICY, onPolicyChange);
    await openQualityCheck(rendered);

    await typeInto(fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.framesPerCheckLabel), '40');
    expect(onPolicyChange).toHaveBeenLastCalledWith({
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, framesPerCheck: 16 },
    });

    await typeInto(fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.framesPerRunLabel), '5');
    expect(onPolicyChange).toHaveBeenLastCalledWith({
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, framesPerRun: 12 },
    });

    await typeInto(fieldLabelled(rendered, SETTINGS_QUALITY_CHECK.fixRoundsLabel), '0');
    expect(onPolicyChange).toHaveBeenLastCalledWith({
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, fixRounds: 1 },
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

  it('says where the pictures go for the connected model', async () => {
    const rendered = await render(DEFAULT_AGENT_POLICY, vi.fn(), connectedStatus);
    await openQualityCheck(rendered);

    const card = rendered.querySelector<HTMLElement>('.quality-check-consent');
    expect(card?.getAttribute('data-frame-destination')).toBe('remote');
    expect(card?.textContent).toContain(
      'Up to 12 pictures a check and 16 a run go to OpenRouter, model openrouter/auto.',
    );
    expect(card?.textContent).toContain(SETTINGS_FRAME_CONSENT.askFirst);
  });

  it('says that no picture is sent when no model is connected', async () => {
    const rendered = await render(DEFAULT_AGENT_POLICY, vi.fn());
    await openQualityCheck(rendered);

    const card = rendered.querySelector<HTMLElement>('.quality-check-consent');
    expect(card?.getAttribute('data-frame-destination')).toBe('no-model');
    expect(card?.textContent).toContain(SETTINGS_FRAME_CONSENT.noModel);
  });

  it('keeps the card to the words of this card when the switch is on', async () => {
    const policy: AgentPolicyPreferences = {
      ...DEFAULT_AGENT_POLICY,
      qualityCheck: { ...DEFAULT_AGENT_POLICY.qualityCheck, neverSendFramesToRemoteModel: true },
    };
    const rendered = await render(policy, vi.fn(), connectedStatus);
    await openQualityCheck(rendered);

    const card = rendered.querySelector<HTMLElement>('.quality-check-consent');
    expect(card?.getAttribute('data-frame-destination')).toBe('kept-on-pc');
    expect(card?.textContent).toContain(SETTINGS_FRAME_CONSENT.neverRemote);
    expect(card?.textContent).not.toContain(SETTINGS_FRAME_CONSENT.askFirst);
  });
});
