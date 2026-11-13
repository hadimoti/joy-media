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
import {
  SETTINGS_BUDGET,
  SETTINGS_DIALOG,
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
 * The card asks for two things this file holds: the fixed points the owner
 * named, so nobody can quietly change them again, and a snapshot of every
 * string, so a later change is seen in the diff instead of slipping in.
 *
 * The words themselves live in `settings-wording.ts`. The table that says
 * what each word was before is `docs/qa/v1.1.1/SETTINGS-WORDING.md`.
 */

/** The source of the dialog, read from the folder this test lives in. */
const dialogSource = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), 'JoyAgentSettingsDialog.tsx'),
  'utf8',
);

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

  it('explains the cost limit and says that JOY Media itself charges nothing', () => {
    expect(SETTINGS_BUDGET.hint).toContain(
      'Prices are estimates from the provider. JOY Media itself charges nothing.',
    );
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
    }).toMatchSnapshot();
  });
});

describe('the words on the five pages (T-P07)', () => {
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

  it('shows the same words on every page, and a snapshot of them', async () => {
    await act(async () => {
      root?.render(
        <JoyAgentSettingsDialog
          policy={DEFAULT_AGENT_POLICY}
          onPolicyChange={vi.fn()}
          engineClient={engineClient()}
          onClose={vi.fn()}
        />,
      );
    });

    const pages: { page: string; words: readonly string[] }[] = [];
    for (const id of SETTINGS_PAGE_IDS) {
      const navItem = [
        ...(container?.querySelectorAll<HTMLButtonElement>('.joy-settings-nav-item') ?? []),
      ].find((candidate) => candidate.textContent?.trim() === SETTINGS_PAGES[id].name);
      if (navItem === undefined) throw new Error(`Expected the "${id}" page in the left list`);
      await act(async () => {
        navItem.click();
        await Promise.resolve();
      });

      // Open every accordion that is closed on the page, so the words inside
      // them count too. The ones already open are left alone.
      for (const trigger of [
        ...(container?.querySelectorAll<HTMLButtonElement>('.joy-accordion-trigger') ?? []),
      ].filter((candidate) => candidate.getAttribute('aria-expanded') === 'false')) {
        await act(async () => {
          trigger.click();
          await Promise.resolve();
        });
      }

      const main = container?.querySelector<HTMLElement>('.joy-agent-settings-main');
      if (main === undefined || main === null)
        throw new Error('The settings dialog must have a main panel');
      pages.push({ page: SETTINGS_PAGES[id].name, words: wordsOf(main) });
    }

    expect(pages).toMatchSnapshot();
  });
});
