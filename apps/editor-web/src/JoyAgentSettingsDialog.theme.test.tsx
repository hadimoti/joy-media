// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { act, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AGENT_POLICY } from './agent-policy-settings.js';
import { JoyAgentSettingsDialog } from './JoyAgentSettingsDialog.js';
import type { JoyAgentEngineClient } from './joy-agent/engine-client.js';
import { hasStandardButtonClass, STANDARD_BUTTON_CLASSES } from './standard-button-classes.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sourceOf = (name: string): string =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8');

/** The two stylesheets that style the app's dialogs. */
const DIALOG_STYLESHEETS = ['./JoyAgentSettingsDialog.css', './AppDialogs.css'] as const;

/** The dialog's own source, and the two panels it renders inside it. */
const DIALOG_SOURCES = [
  './JoyAgentSettingsDialog.tsx',
  './AgentSlotsSection.tsx',
  './ProviderSignInPanel.tsx',
] as const;

/**
 * The characters Unicode marks as emoji: the pictograph blocks, the symbol
 * blocks, and the dingbats that carry an emoji presentation. The plain
 * multiplication sign and the plain check mark are not emoji — they are
 * ordinary typography — so they are left out on purpose.
 */
const EMOJI_PATTERN =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{26FF}\u{2B00}-\u{2BFF}\u{2705}\u{2708}\u{2709}\u{270A}\u{270B}\u{270C}\u{270D}\u{270F}\u{2712}\u{2714}\u{2716}\u{271D}\u{2721}\u{2728}\u{2733}\u{2734}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2795}-\u{2797}\u{27B0}\u{27BF}]/u;

/** The two invisible marks that turn a plain sign into an emoji. */
const EMOJI_JOINER_PATTERN = /[\u{FE0F}\u{200D}]/u;

/**
 * The ordinary typography the dialog is allowed to keep: a middle dot, an
 * ellipsis, a bullet mask, a section sign in a comment, dashes, the plain
 * multiplication sign and the plain check mark.
 */
const ALLOWED_TYPOGRAPHY = new Set(['·', '…', '•', '§', '—', '–', '✕', '✓', '′', '″']);

/** The stylesheet without its comments: a comment names no colour. */
const withoutComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '');

describe('the Joy Code Settings dialog stylesheet (T-P06)', () => {
  it('holds no hex colour and no rgba() outside a token definition', () => {
    for (const stylesheet of DIALOG_STYLESHEETS) {
      const lines = withoutComments(sourceOf(stylesheet)).split('\n');
      const offenders: string[] = [];
      lines.forEach((line, index) => {
        // A token definition may name the colour it stands for.
        if (/^\s*--[\w-]+\s*:/.test(line)) return;
        if (/#[0-9a-fA-F]{3,8}\b/.test(line) || /rgba?\s*\(/.test(line)) {
          offenders.push(`${stylesheet}:${index + 1}: ${line.trim()}`);
        }
      });
      expect(offenders, `${stylesheet} must be built on the --joy-* tokens`).toEqual([]);
    }
  });

  it('names no navy and no blue', () => {
    for (const stylesheet of DIALOG_STYLESHEETS) {
      const source = withoutComments(sourceOf(stylesheet)).toLowerCase();
      expect(source, `${stylesheet} must not name a navy or blue fill`).not.toMatch(
        /navy|blue|rgba?\(\s*59\s*,\s*130\s*,\s*246/,
      );
    }
  });

  it('uses the app tokens rather than colours of its own', () => {
    const source = sourceOf('./JoyAgentSettingsDialog.css');
    expect(source).toContain('var(--joy-');
    expect(source).toContain('var(--joy-accent)');
  });
});

describe('the Joy Code Settings dialog source (T-P06)', () => {
  it('holds no emoji character', () => {
    for (const source of DIALOG_SOURCES) {
      const text = sourceOf(source);
      const found: string[] = [];
      for (const character of text) {
        if (EMOJI_PATTERN.test(character) || EMOJI_JOINER_PATTERN.test(character))
          found.push(`${character} (U+${character.codePointAt(0)?.toString(16).toUpperCase()})`);
      }
      expect(found, `${source} must not hold an emoji`).toEqual([]);
    }
  });

  it('keeps only ordinary typography besides ASCII', () => {
    for (const source of DIALOG_SOURCES) {
      const text = sourceOf(source);
      const found = new Set<string>();
      for (const character of text) {
        if (character.codePointAt(0)! > 127 && !ALLOWED_TYPOGRAPHY.has(character)) {
          found.add(character);
        }
      }
      expect([...found], `${source} must not hold an unexpected character`).toEqual([]);
    }
  });

  it('no longer shows the v2.0 badge', () => {
    expect(sourceOf('./JoyAgentSettingsDialog.tsx')).not.toContain('v2.0');
  });

  it('shows an outline icon where the money bag used to be', () => {
    const source = sourceOf('./JoyAgentSettingsDialog.tsx');
    expect(source).toContain('CoinIcon');
    expect(source).not.toContain('💰');
  });
});

describe('every control in the Joy Code Settings dialog (T-P06)', () => {
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

  async function render(): Promise<HTMLElement> {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <Fragment>
          <JoyAgentSettingsDialog
            policy={DEFAULT_AGENT_POLICY}
            onPolicyChange={vi.fn()}
            engineClient={engineClient()}
            onClose={vi.fn()}
          />
        </Fragment>,
      );
    });
    return container;
  }

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
    vi.unstubAllGlobals();
  });

  it('gives every button on every page one of the standard button classes', async () => {
    const rendered = await render();
    const pages = [
      'AI Models & APIs',
      'Execution & Safety',
      'Live Experience',
      'Tools & Perms',
      'Media Diagnostics',
    ];
    const offenders: string[] = [];
    let checked = 0;

    for (const page of pages) {
      const navItem = [
        ...rendered.querySelectorAll<HTMLButtonElement>('.joy-settings-nav-item'),
      ].find((candidate) => candidate.textContent?.trim() === page);
      if (navItem === undefined) throw new Error(`Expected the "${page}" page in the left list`);
      await act(async () => {
        navItem.click();
        await Promise.resolve();
      });

      // Open every accordion on the page, so the controls inside them count.
      const triggers = [...rendered.querySelectorAll<HTMLButtonElement>('.joy-accordion-trigger')];
      for (const trigger of triggers) {
        await act(async () => {
          trigger.click();
          await Promise.resolve();
        });
      }

      for (const button of rendered.querySelectorAll<HTMLButtonElement>('button')) {
        checked += 1;
        if (!hasStandardButtonClass(button.className)) {
          offenders.push(
            `${page}: <button class="${button.className}"> "${button.textContent?.trim() ?? ''}"`,
          );
        }
      }
    }

    expect(checked, 'the five pages must show buttons to check').toBeGreaterThan(45);
    expect(offenders).toEqual([]);
  });

  it('shows the standard vocabulary the app declares', () => {
    expect(STANDARD_BUTTON_CLASSES).toContain('button-primary');
    expect(STANDARD_BUTTON_CLASSES).toContain('button-secondary');
    expect(hasStandardButtonClass('button-primary button-sm')).toBe(true);
    expect(hasStandardButtonClass('joy-btn-secondary')).toBe(false);
    expect(hasStandardButtonClass(undefined)).toBe(false);
  });
});
