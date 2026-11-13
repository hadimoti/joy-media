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

/**
 * The shared dialog look also lives in app.css: the frame every app dialog
 * sits in, and the standard buttons. Those rules are part of this dialog's
 * own look, so they are checked here too.
 */
const APP_STYLESHEET = './app.css';

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

/* ────────────────────────────────────────────────────────────────────────────
   A small CSS reader.

   A stylesheet is not a list of lines: a value may run over several of them,
   and a rule may sit inside a media query. So the reader below splits a
   stylesheet into rules and reads each declaration's value on its own, which
   is what a colour check needs to see.
   ──────────────────────────────────────────────────────────────────────────── */

interface CssDeclaration {
  readonly property: string;
  readonly value: string;
}

interface CssRule {
  readonly selector: string;
  readonly declarations: readonly CssDeclaration[];
}

/** The text between an opening brace and the brace that closes it. */
function readBlock(text: string, open: number): { inner: string; end: number } {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return { inner: text.slice(open + 1, index), end: index + 1 };
    }
  }
  return { inner: text.slice(open + 1), end: text.length };
}

/** The declarations of a rule body, split on the semicolons that end them. */
function declarationsOf(body: string): CssDeclaration[] {
  const declarations: CssDeclaration[] = [];
  let depth = 0;
  let current = '';
  const flush = () => {
    const colon = current.indexOf(':');
    if (colon !== -1) {
      const property = current.slice(0, colon).trim();
      const value = current.slice(colon + 1).trim();
      if (property !== '' && value !== '') declarations.push({ property, value });
    }
    current = '';
  };
  for (const char of body) {
    if (char === '(') depth += 1;
    else if (char === ')') depth = Math.max(0, depth - 1);
    if (char === ';' && depth === 0) {
      flush();
      continue;
    }
    current += char;
  }
  flush();
  return declarations;
}

/** The rules of a stylesheet, including the ones inside a media query. */
function cssRules(source: string): CssRule[] {
  const text = withoutComments(source);
  const found: CssRule[] = [];
  let prelude = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char !== '{') {
      prelude += char;
      index += 1;
      continue;
    }
    const block = readBlock(text, index);
    const head = prelude.trim();
    prelude = '';
    index = block.end;
    if (head.startsWith('@')) {
      // An at-rule may hold rules of its own, a media query for instance.
      found.push(...cssRules(block.inner));
      continue;
    }
    if (head !== '') found.push({ selector: head, declarations: declarationsOf(block.inner) });
  }
  return found;
}

/* ────────────────────────────────────────────────────────────────────────────
   The colour reader.

   A stylesheet that spells a colour out is painting a colour the app has no
   token for, so every way of spelling one out is an offender: a hex, a
   colour function, a colour by name, or a literal inside a color-mix(). The
   app's own tokens — var(--joy-*) — and the keywords that mean "no colour"
   are the only colours allowed.
   ──────────────────────────────────────────────────────────────────────────── */

/** The colours CSS knows by name. */
const NAMED_COLOURS = new Set(
  `aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
   burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan
   darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid
   darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet
   deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro
   ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki
   lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow
   lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray
   lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine
   mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue mediumspringgreen mediumturquoise
   mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab
   orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru
   pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen
   seashell sienna silver skyblue slateblue slategray slategrey snow springgreen steelblue tan teal thistle
   tomato turquoise violet wheat white whitesmoke yellow yellowgreen`
    .split(/\s+/)
    .filter((name) => name !== ''),
);

/** The keywords that stand for the absence of a colour, not for one. */
const COLOUR_KEYWORDS = new Set([
  'transparent',
  'currentcolor',
  'inherit',
  'initial',
  'unset',
  'revert',
  'none',
]);

/** A colour written as a hex: #fff, #ffff, #f4b72f or #f4b72fff. */
const HEX_COLOUR = /(^|[^\w#-])#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F])/g;

/** A colour written as a function: rgb(), hsl(), oklch() and the like. */
const COLOUR_FUNCTION = /\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\s*\(/g;

/** A colour mixed from other colours: color-mix(in srgb, … , …). */
const COLOUR_MIX = /color-mix\s*\(([^()]*)\)/g;

/** The app's own token reference. */
const JOY_TOKEN = /^var\(\s*--joy-[\w-]+\s*\)$/;

/** Every colour a value spells out, in words a reviewer can read. */
function colourOffenders(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(HEX_COLOUR)) {
    found.push(`hex colour "${match[0].trim()}"`);
  }
  for (const match of value.matchAll(COLOUR_FUNCTION)) {
    found.push(`colour function "${match[1] ?? ''}()"`);
  }
  for (const word of value.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (NAMED_COLOURS.has(word) && !COLOUR_KEYWORDS.has(word)) {
      found.push(`named colour "${word}"`);
    }
  }
  for (const match of value.matchAll(COLOUR_MIX)) {
    // The first part is the colour space; the rest are the colours mixed.
    for (const part of (match[1] ?? '').split(',').slice(1)) {
      const colour = part.trim().split(/\s+/)[0] ?? '';
      if (colour === '') continue;
      if (JOY_TOKEN.test(colour)) continue;
      if (COLOUR_KEYWORDS.has(colour.toLowerCase())) continue;
      found.push(`color-mix literal "${colour}"`);
    }
  }
  return found;
}

/**
 * The classes that make a rule part of the shared dialog frame, of the Joy
 * Code Settings dialog, of the Asset Library dialog that shares the frame,
 * or of the standard buttons. A rule that mentions none of them belongs to
 * some other part of the app and is none of this check's business, so the
 * check stays off unrelated rules.
 */
const DIALOG_CLASSES = [
  'agent-settings',
  'joy-agent-settings-dialog',
  'joy-settings-',
  'joy-accordion-',
  'joy-btn-',
  'asset-library-storage',
  'button-primary',
  'button-secondary',
  'button-danger',
  'button-link',
  'button-sm',
] as const;

/** Is this rule one of the dialog's own rules? */
function isDialogRule(rule: CssRule): boolean {
  const classes = [...rule.selector.matchAll(/\.(-?[_A-Za-z][\w-]*)/g)].map(
    (match) => match[1] ?? '',
  );
  return classes.some((className) =>
    DIALOG_CLASSES.some((prefix) => className === prefix || className.startsWith(prefix)),
  );
}

/** Every colour the given rules spell out, in words a reviewer can read. */
function colourOffendersIn(rules: readonly CssRule[]): string[] {
  const found: string[] = [];
  for (const rule of rules) {
    for (const declaration of rule.declarations) {
      // A token definition may name the colour it stands for.
      if (declaration.property.startsWith('--')) continue;
      for (const offender of colourOffenders(declaration.value)) {
        found.push(
          `${rule.selector} { ${declaration.property}: ${declaration.value} } -> ${offender}`,
        );
      }
    }
  }
  return found;
}

describe('the Joy Code Settings dialog stylesheet (T-P06)', () => {
  it('holds no colour of its own in the two dialog stylesheets', () => {
    for (const stylesheet of DIALOG_STYLESHEETS) {
      const rules = cssRules(sourceOf(stylesheet));
      expect(rules.length, `${stylesheet} must hold rules to check`).toBeGreaterThan(5);
      expect(colourOffendersIn(rules), `${stylesheet} must be built on the --joy-* tokens`).toEqual(
        [],
      );
    }
  });

  it('holds no colour of its own in the shared dialog rules of app.css', () => {
    // The frame the dialog sits in and the standard buttons live in app.css,
    // so the same rule applies to them: a colour of their own is an offender.
    const rules = cssRules(sourceOf(APP_STYLESHEET)).filter(isDialogRule);
    expect(
      rules.length,
      'the scope must find the dialog rules it is meant to check',
    ).toBeGreaterThan(30);
    expect(
      colourOffendersIn(rules),
      'the shared dialog rules of app.css must be built on the --joy-* tokens',
    ).toEqual([]);
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

describe('the colour reader (T-P06 review)', () => {
  it('catches every way a stylesheet can spell a colour out', () => {
    expect(colourOffenders('#fff')).toEqual(['hex colour "#fff"']);
    expect(colourOffenders('#f4b72f')).toHaveLength(1);
    expect(colourOffenders('rgb(0 0 0 / 50%)')).toHaveLength(1);
    expect(colourOffenders('rgba(0, 0, 0, 0.5)')).toHaveLength(1);
    expect(colourOffenders('hsl(210 90% 60%)')).toHaveLength(1);
    expect(colourOffenders('navy')).toEqual(['named colour "navy"']);
    expect(colourOffenders('white')).toEqual(['named colour "white"']);
    expect(colourOffenders('color-mix(in srgb, #fff 50%, #000)').length).toBeGreaterThan(0);
  });

  it('lets the app tokens and the absence of a colour through', () => {
    expect(colourOffenders('var(--joy-accent)')).toEqual([]);
    expect(colourOffenders('transparent')).toEqual([]);
    expect(colourOffenders('currentColor')).toEqual([]);
    expect(colourOffenders('color-mix(in srgb, var(--joy-ok) 48%, var(--joy-border))')).toEqual([]);
    expect(colourOffenders('color-mix(in srgb, var(--joy-bg-deep) 68%, transparent)')).toEqual([]);
    expect(
      colourOffenders('linear-gradient(145deg, var(--joy-accent), var(--joy-accent-hover))'),
    ).toEqual([]);
  });

  it('reads a rule that runs over several lines', () => {
    const rules = cssRules(`
      .thing {
        background:
          linear-gradient(
            145deg,
            var(--joy-accent),
            var(--joy-accent-hover)
          );
      }
    `);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.declarations).toHaveLength(1);
    expect(colourOffendersIn(rules)).toEqual([]);
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
      'AI models',
      'Safety and limits',
      'Live preview',
      'Tools and permissions',
      'Media support check',
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
