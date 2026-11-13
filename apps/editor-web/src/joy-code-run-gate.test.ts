import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import {
  CONNECT_MODEL_FIRST_TITLE,
  createRunStartAnnouncer,
  runControlGate,
} from './joy-code-run-gate.js';

const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

/** A `--token: #rrggbb;` value from the first :root block of app.css. */
function rootToken(name: string): string {
  const start = css.indexOf(':root {');
  expect(start).toBeGreaterThanOrEqual(0);
  const block = css.slice(start, css.indexOf('}', start));
  const match = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(block);
  expect(match, `token ${name}`).not.toBeNull();
  return match![1]!;
}

/** The `var(--token)` a property uses inside one rule of app.css. */
function ruleColourToken(selector: string, property: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, selector).toBeGreaterThanOrEqual(0);
  const body = css.slice(start, css.indexOf('}', start));
  const match = new RegExp(`(?:^|\\n)\\s*${property}:\\s*var\\((--[\\w-]+)\\)`).exec(body);
  expect(match, `${property} in ${selector}`).not.toBeNull();
  return match![1]!;
}

function luminance(hex: string): number {
  const channel = (offset: number): number => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio between two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

describe('runControlGate', () => {
  const ready = { ready: true, noModel: false, readinessText: 'Not ready', blocked: false };

  it('disables a Run control with no model and says to connect one first', () => {
    const gate = runControlGate({ ...ready, noModel: true, ready: false });
    expect(gate).toEqual({
      disabled: true,
      title: CONNECT_MODEL_FIRST_TITLE,
      opensConnect: true,
    });
    expect(CONNECT_MODEL_FIRST_TITLE).toBe('Connect a model first');
  });

  it('keeps the reason of any other not-ready state as the hover text, without opening settings', () => {
    expect(runControlGate({ ...ready, ready: false, readinessText: 'Local-only' })).toEqual({
      disabled: true,
      title: 'Local-only',
      opensConnect: false,
    });
  });

  it('disables a blocked control with no hover text', () => {
    expect(runControlGate({ ...ready, blocked: true })).toEqual({
      disabled: true,
      title: undefined,
      opensConnect: false,
    });
  });

  it('enables a control that is ready and not blocked', () => {
    expect(runControlGate(ready)).toEqual({
      disabled: false,
      title: undefined,
      opensConnect: false,
    });
  });
});

describe('run start announcement', () => {
  it('adds the message once, on the first started checkpoint', () => {
    const announce = vi.fn();
    const announcer = createRunStartAnnouncer(announce);
    announcer.observe({ state: 'started' });
    announcer.observe({ state: 'started' });
    announcer.observe({ state: 'completed' });
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it('adds no message when the run is refused before it starts', () => {
    const announce = vi.fn();
    const announcer = createRunStartAnnouncer(announce);
    announcer.observe({ state: 'blocked' });
    announcer.observe({ state: 'completed' });
    expect(announce).not.toHaveBeenCalled();
  });
});

describe('contrast', () => {
  it('computes the WCAG ratio', () => {
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrast('#777777', '#777777')).toBeCloseTo(1, 5);
  });

  it('reads the composer hint at 4.5 to 1 or more on its input field', () => {
    const token = ruleColourToken('.joy-code-input textarea::placeholder', 'color');
    const ratio = contrast(rootToken(token), rootToken('--joy-bg-input'));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('reads the send button at 4.5 to 1 or more when it is idle', () => {
    const colour = ruleColourToken('.joy-code-send:disabled', 'color');
    const background = ruleColourToken('.joy-code-send:disabled', 'background');
    const ratio = contrast(rootToken(colour), rootToken(background));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  it('colours the ready send glyph with the accent-on token (glyph on an accent fill)', () => {
    // --joy-on-accent is the documented token for text and glyphs printed on the accent
    // fill; the text-roles test only restricts --joy-text* names, so this is allowed.
    expect(ruleColourToken('.joy-code-send', 'color')).toBe('--joy-on-accent');
    expect(ruleColourToken('.joy-code-send', 'background')).toBe('--joy-accent');
    expect(rootToken('--joy-on-accent')).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('reads the send button at 4.5 to 1 or more when it is ready to send', () => {
    const colour = ruleColourToken('.joy-code-send', 'color');
    const background = ruleColourToken('.joy-code-send', 'background');
    const ratio = contrast(rootToken(colour), rootToken(background));
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
