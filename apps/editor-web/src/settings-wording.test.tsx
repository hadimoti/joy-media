// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import { JoyAgentSettingsDialog } from './JoyAgentSettingsDialog.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import type { ByokSessionStatus, JoyAgentMediaCapabilityReport } from './joy-agent/protocol.js';
import {
  SETTINGS_BUDGET,
  SETTINGS_DIALOG,
  SETTINGS_MEDIA_CHECK,
  SETTINGS_MODELS,
  SETTINGS_MODES,
  SETTINGS_PAGES,
  SETTINGS_PAGE_IDS,
  SETTINGS_STORAGE,
  SETTINGS_TOOLS,
} from './settings-wording.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * T-P07 — the wording of the Joy Code Settings dialog, in plain English.
 *
 * The card asks for three things this file holds:
 *
 * 1. The fixed points the owner named, so nobody can quietly change them
 *    again.
 * 2. A snapshot of every string, so a later change is seen in the diff
 *    instead of slipping in. There are two: one of every string in the
 *    wording file, and one of every word the pages show, in the states the
 *    pages can be in.
 * 3. The coverage of the table: every string of the wording file is listed
 *    in `docs/qa/v1.1.1/SETTINGS-WORDING.md`, and the dialog itself holds no
 *    copy of its own.
 *
 * The words themselves live in `settings-wording.ts`. The table that says
 * what each word was before is `docs/qa/v1.1.1/SETTINGS-WORDING.md`.
 */

/** The folder this test lives in. */
const here = dirname(fileURLToPath(import.meta.url));

/** The source of the dialog, and the wording file and the table beside it. */
const dialogSource = readFileSync(resolve(here, 'JoyAgentSettingsDialog.tsx'), 'utf8');
const table = readFileSync(resolve(here, '../../../docs/qa/v1.1.1/SETTINGS-WORDING.md'), 'utf8');

/** Every string of the wording file, with the placeholders left in. */
function wordingStrings(): readonly string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (typeof value === 'string') {
      found.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk({
    pages: SETTINGS_PAGES,
    modes: SETTINGS_MODES,
    budget: SETTINGS_BUDGET,
    storage: SETTINGS_STORAGE,
    media: SETTINGS_MEDIA_CHECK,
    tools: SETTINGS_TOOLS,
    models: SETTINGS_MODELS,
  });
  return found;
}

describe('the Joy Code Settings wording (T-P07)', () => {
  it('names the five pages the way the owner asked', () => {
    expect(SETTINGS_PAGE_IDS).toEqual([
      'models',
      'execution',
      'experience',
      'permissions',
      'diagnostics',
    ]);
    expect(SETTINGS_PAGE_IDS.map((id) => SETTINGS_PAGES[id].name)).toEqual([
      'AI models',
      'Safety and limits',
      'Live preview',
      'Tools and permissions',
      'Media support check',
    ]);
  });

  it('says which way of working is the default, and only that one', () => {
    const withDefault = Object.entries(SETTINGS_MODES).filter(([, mode]) =>
      mode.name.includes('(default)'),
    );

    expect(withDefault.map(([id]) => id)).toEqual(['preview-and-approve']);
    // The default of the app is the mode that is marked.
    expect(DEFAULT_AGENT_POLICY.executionMode).toBe('preview-and-approve');
  });

  it('gives every way of working one plain sentence', () => {
    for (const [id, mode] of Object.entries(SETTINGS_MODES)) {
      expect(mode.sentence.length, `${id} needs a sentence`).toBeGreaterThan(20);
      expect(mode.sentence.endsWith('.'), `${id} needs a whole sentence`).toBe(true);
      // One sentence: no full stop in the middle.
      expect(mode.sentence.split('.').filter((part) => part.trim().length > 0)).toHaveLength(1);
    }
  });

  it('says what the cost number really does, and nothing more', () => {
    // The number is the point at which JOY Media asks, not a cap on the run.
    expect(SETTINGS_BUDGET.hint).toContain(
      'Prices are estimates from the provider. JOY Media itself charges nothing.',
    );
    expect(SETTINGS_BUDGET.hint).toContain('asks for your approval');
    expect(SETTINGS_BUDGET.hint).toContain('It is not a limit on what a whole run may spend.');
    for (const claim of ['stops a run', 'maximum spend', 'per run', 'Max Cost']) {
      expect(
        `${SETTINGS_BUDGET.title} ${SETTINGS_BUDGET.tag} ${SETTINGS_BUDGET.field}`,
        `the cost wording may not say "${claim}"`,
      ).not.toContain(claim);
    }
  });

  it('says where the settings and the keys are kept', () => {
    expect(SETTINGS_STORAGE.footer).toBe(
      'Saved on this computer. Your keys are stored encrypted on this PC.',
    );
    expect(SETTINGS_STORAGE.keyNote).toBe('Your keys are stored encrypted on this PC.');
    expect(SETTINGS_STORAGE.savedNote).toBe('Saved on this computer');
  });

  it('names every permission in plain words', () => {
    for (const [capability, name] of Object.entries(SETTINGS_TOOLS.names)) {
      expect(name, `${capability} needs a name`).toBeTruthy();
      expect(name, `${capability} may not show its internal name`).not.toContain('.');
    }
  });

  it('has no "Professional AI Engine Workspace" anywhere', () => {
    expect(dialogSource).not.toContain('Professional AI Engine Workspace');
    expect(SETTINGS_DIALOG.subtitle).toBe('Settings for Joy Code');
  });

  it('keeps a snapshot of every string the dialog reads', () => {
    // Any later change to the wording shows up here, in the diff.
    expect({
      pages: SETTINGS_PAGES,
      modes: SETTINGS_MODES,
      budget: SETTINGS_BUDGET,
      storage: SETTINGS_STORAGE,
      tools: SETTINGS_TOOLS,
      models: SETTINGS_MODELS,
      media: SETTINGS_MEDIA_CHECK,
    }).toMatchSnapshot();
  });
});

describe('the coverage of the wording table (T-P07)', () => {
  it('lists every string of the wording file in the table', () => {
    const missing: string[] = [];
    for (const value of wordingStrings()) {
      // A string with a placeholder is listed as its parts, because the table
      // shows the filled example.
      const parts = value.split(/\{[a-zA-Z]+\}/).filter((part) => part.trim().length > 0);
      for (const part of parts) {
        if (!table.includes(part)) missing.push(`${value} -> ${part}`);
      }
    }
    expect(missing, 'every word of the dialog belongs in the table').toEqual([]);
  });

  it('gives the permissions a place of their own', () => {
    for (const name of Object.values(SETTINGS_TOOLS.names)) {
      expect(table, `${name} must be in the table`).toContain(name);
    }
    // The permissions table says where each name is shown.
    expect(table).toContain('Tools and permissions page, the first switch');
    expect(table).toContain('Tools and permissions page, the twelfth switch');
  });

  it('holds no copy of its own in the dialog', () => {
    // Every visible word of the dialog comes from the wording file, so the
    // dialog holds only class names, roles and the values of the code.
    const source = dialogSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
    const lines = source.split('\n');
    const copy: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (/^\s*(import|from)\b/.test(line)) continue;
      // A console message is for the developer, not for the screen.
      if (/console\.(warn|error|log|info)/.test(line)) continue;
      for (const match of line.matchAll(/'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g)) {
        const value = match[1] ?? match[2] ?? '';
        if (!value.includes(' ') || !/[A-Za-z]/.test(value)) continue;
        // A class name, a role or a code value has no spaces of its own.
        if (/^[a-z0-9-]+(\s+[a-z0-9-]+)*$/.test(value)) continue;
        copy.push(`${index + 1}: ${value}`);
      }
    }
    expect(copy, 'the dialog must read its words from the wording file').toEqual([]);
  });
});

describe('the words on the five pages (T-P07)', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  const engineClient = (overrides: Partial<JoyAgentEngineClient> = {}): JoyAgentEngineClient =>
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
      ...overrides,
    }) as unknown as JoyAgentEngineClient;

  const mediaReport: JoyAgentMediaCapabilityReport = {
    modelId: 'openrouter/verified-model',
    image: 'supported',
    audio: 'unavailable',
    video: 'supported',
    modalities: ['image', 'video'],
  };

  const connectedStatus: ByokSessionStatus = {
    provider: 'openrouter',
    modelId: 'openrouter/verified-model',
    capability: 'tool-loop',
  };

  /** One saved connection of every kind the list can show. */
  const savedProfiles = [
    {
      id: 'prof-1',
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      modelId: 'openrouter/verified-model',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      bound: true,
    },
    {
      id: 'prof-legacy',
      provider: 'openrouter',
      baseUrl: 'https://legacy.example/v1',
      modelId: 'openrouter/old-model',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      state: 'disabled-legacy',
    },
    {
      id: 'prof-unreadable',
      provider: 'openrouter',
      baseUrl: 'https://unreadable.example/v1',
      modelId: 'openrouter/other-model',
      createdAt: '2026-09-15T00:00:00.000Z',
      updatedAt: '2026-09-15T00:00:00.000Z',
      state: 'credential-unavailable',
    },
  ];

  /** The desktop bridge the dialog reads its saved connections and models from. */
  const desktopBridge = (models: readonly { id: string }[] = []): void => {
    window.joyDesktop = {
      channels: ['desktop.provider-profile.list', 'desktop.provider.models'],
      invoke: vi.fn(async (channel: string) => {
        if (channel === 'desktop.provider-profile.list') return savedProfiles;
        if (channel === 'desktop.provider.models') return models;
        return undefined;
      }),
    } as unknown as NonNullable<Window['joyDesktop']>;
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
    delete (window as { joyDesktop?: unknown }).joyDesktop;
  });

  /** Renders the dialog and lets its first read settle. */
  async function render(
    client: JoyAgentEngineClient,
    status?: ByokSessionStatus,
  ): Promise<HTMLElement> {
    await act(async () => {
      root?.render(
        <JoyAgentSettingsDialog
          policy={DEFAULT_AGENT_POLICY}
          onPolicyChange={vi.fn()}
          engineClient={client}
          {...(status === undefined ? {} : { status })}
          onClose={vi.fn()}
        />,
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    if (container === undefined) throw new Error('The dialog must be rendered');
    return container;
  }

  /** The words of the page, in the order they are shown. */
  function wordsOf(host: HTMLElement): readonly string[] {
    const words: string[] = [];
    const walk = (node: Node): void => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
          const text = (child.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (text.length > 0) words.push(text);
          continue;
        }
        if (child.nodeType === Node.ELEMENT_NODE) walk(child);
      }
    };
    walk(host);
    return words;
  }

  /** Clicks the button that says this. */
  async function clickButton(rendered: HTMLElement, text: string): Promise<void> {
    const button = [...rendered.querySelectorAll<HTMLButtonElement>('button')].find(
      (candidate) =>
        candidate.textContent?.trim() === text ||
        candidate.querySelector('strong')?.textContent?.trim() === text,
    );
    if (button === undefined) throw new Error(`Expected button "${text}"`);
    await act(async () => {
      button.click();
      await Promise.resolve();
    });
  }

  /** Opens every accordion that is closed, so the words inside them count too. */
  async function openEveryAccordion(rendered: HTMLElement): Promise<void> {
    for (const trigger of [
      ...rendered.querySelectorAll<HTMLButtonElement>('.joy-accordion-trigger'),
    ].filter((candidate) => candidate.getAttribute('aria-expanded') === 'false')) {
      await act(async () => {
        trigger.click();
        await Promise.resolve();
      });
    }
  }

  /** Chooses a provider in the first drop-down, as the owner does. */
  async function chooseProvider(rendered: HTMLElement, provider: string): Promise<void> {
    await act(async () => {
      const select = [...rendered.querySelectorAll<HTMLSelectElement>('select')].find((candidate) =>
        [...candidate.options].some((option) => option.value === 'openrouter'),
      );
      if (select === undefined) throw new Error('Expected provider select dropdown');
      select.value = provider;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });
  }

  /** Shows the page with this name and returns the words of its panel. */
  async function wordsOfPage(rendered: HTMLElement, page: string): Promise<readonly string[]> {
    const navItem = [
      ...rendered.querySelectorAll<HTMLButtonElement>('.joy-settings-nav-item'),
    ].find((candidate) => candidate.textContent?.trim() === page);
    if (navItem === undefined) throw new Error(`Expected the "${page}" page in the left list`);
    await act(async () => {
      navItem.click();
      await Promise.resolve();
    });
    await openEveryAccordion(rendered);
    const main = rendered.querySelector<HTMLElement>('.joy-agent-settings-main');
    if (main === null) throw new Error('The settings dialog must have a main panel');
    return wordsOf(main);
  }

  it('shows the same words on every page, and a snapshot of them', async () => {
    const rendered = await render(engineClient());

    const pages: { page: string; words: readonly string[] }[] = [];
    for (const id of SETTINGS_PAGE_IDS) {
      pages.push({
        page: SETTINGS_PAGES[id].name,
        words: await wordsOfPage(rendered, SETTINGS_PAGES[id].name),
      });
    }

    expect(pages).toMatchSnapshot();
  });

  it('shows the model list, the saved connections and the connected banner', async () => {
    desktopBridge([
      { id: 'openrouter/auto' },
      { id: 'anthropic/claude-sonnet' },
      { id: 'openai/gpt-4o' },
    ]);
    const rendered = await render(engineClient(), connectedStatus);
    await chooseProvider(rendered, 'openrouter');
    await clickButton(rendered, SETTINGS_MODELS.findModels);
    await act(async () => {
      await Promise.resolve();
    });

    const models = await wordsOfPage(rendered, SETTINGS_PAGES.models.name);
    const saved = await wordsOfPage(rendered, SETTINGS_PAGES.models.name);

    expect({ models, saved }).toMatchSnapshot();
  });

  it('shows the media support check after it has run', async () => {
    const client = engineClient({
      probeMediaCapabilities: vi.fn().mockResolvedValue(mediaReport),
    });
    const rendered = await render(client, connectedStatus);
    await clickButton(rendered, SETTINGS_MEDIA_CHECK.check);
    await act(async () => {
      await Promise.resolve();
    });

    const models = await wordsOfPage(rendered, SETTINGS_PAGES.models.name);
    const diagnostics = await wordsOfPage(rendered, SETTINGS_PAGES.diagnostics.name);

    expect({ models, diagnostics }).toMatchSnapshot();
  });

  it('shows the live preview switch as it is', async () => {
    const rendered = await render(engineClient());
    const page = await wordsOfPage(rendered, SETTINGS_PAGES.experience.name);
    const switchBox = rendered.querySelector<HTMLInputElement>(
      '.joy-settings-cap-item input[type="checkbox"]',
    );

    expect({ page, livePreview: switchBox?.checked }).toMatchSnapshot();
  });

  it('shows the refusals the dialog can answer with', async () => {
    desktopBridge();
    const rendered = await render(engineClient());
    // No provider is chosen, so the dialog refuses to look for models.
    await clickButton(rendered, SETTINGS_MODELS.findModels);
    await act(async () => {
      await Promise.resolve();
    });
    await clickButton(rendered, SETTINGS_MODELS.connect);
    await act(async () => {
      await Promise.resolve();
    });

    const models = await wordsOfPage(rendered, SETTINGS_PAGES.models.name);

    expect({ models }).toMatchSnapshot();
  });
});
