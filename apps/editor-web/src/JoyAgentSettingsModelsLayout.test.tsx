// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import { JoyAgentSettingsDialog } from './JoyAgentSettingsDialog.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import {
  SETTINGS_AGENT_SLOTS,
  SETTINGS_MEDIA_CHECK,
  SETTINGS_MODELS,
  removeProfileLabel,
} from './settings-wording.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The AI models page is one column of sections in the order a person works in, and every
 * saved connection is a row of one list. These tests pin that structure, so a later change
 * cannot quietly scatter the page again.
 */

const profiles = [
  {
    id: 'profile-one',
    name: 'Studio OpenRouter',
    provider: 'openrouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    modelId: 'openrouter/auto',
    bound: true,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  },
  {
    id: 'profile-two',
    name: 'Local Whisper',
    provider: 'custom',
    baseUrl: 'http://127.0.0.1:8080/v1',
    modelId: 'whisper-1',
    bound: true,
    createdAt: '2026-11-14T00:00:00.000Z',
    updatedAt: '2026-11-14T00:00:00.000Z',
  },
];

const slot = (id: string, label: string) => ({
  id,
  label,
  profileId: null,
  profileName: null,
  profileProvider: null,
  model: null,
  instructions: '',
  settings: {},
  ready: false,
});

describe('the AI models page layout', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  const engineClient = (): JoyAgentEngineClient =>
    ({
      configure: vi.fn().mockResolvedValue(undefined),
      testConnection: vi.fn().mockResolvedValue(undefined),
      probeMediaCapabilities: vi.fn().mockResolvedValue(undefined),
      startRun: vi.fn(),
      cancel: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn(),
      dispose: vi.fn(),
      getStatus: vi.fn(() => undefined),
      getMediaCapabilities: vi.fn(() => undefined),
    }) as unknown as JoyAgentEngineClient;

  beforeEach(() => {
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.agent-slots.list'],
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'desktop.provider-profile.list') return profiles;
        if (channel === 'desktop.agent-slots.list') {
          return [slot('workhorse', 'Workhorse'), slot('creative', 'Creative Brain')];
        }
        return undefined;
      }),
    } as unknown as NonNullable<Window['joyDesktop']>;
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    delete (window as { joyDesktop?: unknown }).joyDesktop;
  });

  async function render(): Promise<HTMLElement> {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <JoyAgentSettingsDialog
          policy={DEFAULT_AGENT_POLICY}
          onPolicyChange={vi.fn()}
          engineClient={engineClient()}
          onOpenModelDrawer={vi.fn()}
          onClose={vi.fn()}
        />,
      );
    });
    // The profiles and the slots are read after the first paint.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    return container;
  }

  it('shows the sections in the order a person works in', async () => {
    const rendered = await render();
    const page = rendered.querySelector<HTMLElement>('.joy-settings-page');
    expect(page, 'the AI models page is one column').not.toBeNull();

    const marks: readonly (readonly [string, (element: Element) => string])[] = [
      ['.joy-settings-active-banner', () => 'status'],
      ['.agent-slot-card', (card) => card.querySelector('h4')?.textContent ?? ''],
      ['.joy-connections-card', () => 'connections'],
      ['.agent-slot-account', () => 'account'],
      ['.joy-settings-vault-profiles', () => 'saved'],
      [
        '.joy-connections-card > .joy-accordion-item > .joy-accordion-trigger',
        (row) => row.textContent ?? '',
      ],
      [
        '.joy-settings-page > .joy-accordion-item > .joy-accordion-trigger',
        (row) => row.textContent ?? '',
      ],
    ];
    const selector = marks.map(([css]) => css).join(', ');
    const order = [...(page?.querySelectorAll(selector) ?? [])].map((element) => {
      const mark = marks.find(([css]) => element.matches(css));
      return mark === undefined ? '' : mark[1](element);
    });

    expect(order.slice(0, 6)).toEqual([
      'status',
      'Workhorse',
      'Creative Brain',
      'connections',
      'account',
      'saved',
    ]);
    // The connection and sign-in row, then the models found, then the media check last.
    expect(order[6]).toContain(SETTINGS_MODELS.connectionTitle);
    expect(order[7]).toContain(SETTINGS_MODELS.modelsTitle);
    expect(order[8]).toContain(SETTINGS_MEDIA_CHECK.modelsTitle);
    expect(order).toHaveLength(9);

    // The Connections card carries its name at the left and the browse button at the right.
    const head = page?.querySelector('.joy-connections-card > .joy-card-head');
    expect(head?.firstElementChild?.textContent).toBe(SETTINGS_MODELS.connectionsTitle);
    expect(head?.lastElementChild?.getAttribute('aria-label')).toBe(SETTINGS_MODELS.browseButton);
  });

  it('gives the two profile cards one identical grid and a footer with the primary action right-most', async () => {
    const rendered = await render();
    const cards = [...rendered.querySelectorAll<HTMLElement>('.agent-slot-card')];
    expect(cards).toHaveLength(2);

    for (const card of cards) {
      const label = card.querySelector('h4')?.textContent ?? '';
      const fields = [...card.querySelectorAll('.joy-card-grid [aria-label]')].map((control) =>
        control.getAttribute('aria-label'),
      );
      // Profile, model, then the effort level (beside Refresh models), then instructions.
      expect(fields).toEqual([
        `${label} profile`,
        `${label} model`,
        `${label} effort level`,
        `${label} instructions`,
      ]);

      // The model has its own line; Refresh models stands beside the effort level on the next line.
      const modelRow = card.querySelector('.agent-slot-model-row');
      expect(modelRow?.querySelector(`[aria-label="${label} model"]`)).not.toBeNull();
      const effortRow = card.querySelector('.agent-slot-effort-row');
      expect(effortRow?.querySelector(`[aria-label="${label} effort level"]`)).not.toBeNull();
      expect(effortRow?.textContent).toContain(SETTINGS_AGENT_SLOTS.refreshModels);

      // The slot's name has a small icon at its left.
      expect(card.querySelector('h4 svg')).not.toBeNull();

      // The footer row holds the actions; the primary one is last.
      const footerButtons = [...card.querySelectorAll('.joy-card-footer button')];
      expect(footerButtons.map((button) => button.textContent)).toEqual([
        SETTINGS_AGENT_SLOTS.saveSlot.replace('{label}', label),
        SETTINGS_AGENT_SLOTS.useForAgent,
      ]);
      expect(footerButtons.at(-1)?.className).toContain('button-primary');
    }
  });

  it('lists the saved connections as rows: name at the left, Use and Remove at the right', async () => {
    const rendered = await render();
    const list = rendered.querySelector('.joy-settings-vault-profiles-grid');
    const rows = [...(list?.children ?? [])] as HTMLElement[];

    expect(rows.map((row) => row.querySelector('strong')?.textContent)).toEqual([
      'Studio OpenRouter',
      'Local Whisper',
    ]);

    for (const row of rows) {
      expect(row.classList.contains('joy-settings-provider-card')).toBe(true);
      // The name and the muted model id at the left, the actions at the right.
      expect([...row.children].map((child) => child.className)).toEqual([
        'joy-settings-provider-meta',
        'joy-settings-provider-actions',
      ]);
      expect(row.querySelector('.joy-settings-provider-meta')?.firstElementChild?.tagName).toBe(
        'STRONG',
      );
      const actions = [...row.querySelectorAll('.joy-settings-provider-actions button')];
      expect(actions.map((button) => button.textContent?.trim())).toEqual([
        SETTINGS_MODELS.useButton,
        '✕',
      ]);
      expect(actions.at(-1)?.getAttribute('aria-label')).toBe(
        removeProfileLabel(row.querySelector('strong')?.textContent ?? ''),
      );
    }
  });
});
