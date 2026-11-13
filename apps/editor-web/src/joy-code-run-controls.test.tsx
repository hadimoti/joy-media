// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONNECT_MODEL_FIRST_TITLE } from './joy-code-run-gate.js';
import { JoyCodeConnectButton, RecipeRunControls } from './joy-code-run-controls.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** Mounts once; later calls re-render the same root, as a connect or disconnect does. */
function renderInto(element: ReactElement) {
  if (container === undefined || root === undefined) {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  }
  act(() => root?.render(element));
}

function connectControl(): HTMLElement | null {
  return (
    container?.querySelector<HTMLElement>(
      `[role="button"][aria-label="${CONNECT_MODEL_FIRST_TITLE}"]`,
    ) ?? null
  );
}

function runButton(): HTMLButtonElement {
  const button = container?.querySelector<HTMLButtonElement>('.joy-code-recipe-run');
  if (button === null || button === undefined) throw new Error('No Run button');
  return button;
}

function keyDown(target: HTMLElement, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
}

const RECIPE = {
  title: 'Shorten intro',
  running: false,
  blocked: false,
  readinessText: 'Connect a model with JOY edit tools in Agent Settings to run recipes.',
};

describe('the connect step is reachable from the keyboard', () => {
  it('is a focusable button with the accessible name "Connect a model first"', () => {
    renderInto(<JoyCodeConnectButton onConnect={() => undefined} />);
    const control = connectControl();
    expect(control).not.toBeNull();
    expect(control?.getAttribute('role')).toBe('button');
    expect(control?.tabIndex).toBe(0);
    control?.focus();
    expect(document.activeElement).toBe(control);
  });

  it('opens the connect step on Enter', () => {
    const onConnect = vi.fn();
    renderInto(<JoyCodeConnectButton onConnect={onConnect} />);
    keyDown(connectControl()!, 'Enter');
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('opens the connect step on Space, and stops the page from scrolling', () => {
    const onConnect = vi.fn();
    renderInto(<JoyCodeConnectButton onConnect={onConnect} />);
    const control = connectControl()!;
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    act(() => {
      control.dispatchEvent(event);
    });
    expect(onConnect).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('ignores other keys', () => {
    const onConnect = vi.fn();
    renderInto(<JoyCodeConnectButton onConnect={onConnect} />);
    keyDown(connectControl()!, 'a');
    expect(onConnect).not.toHaveBeenCalled();
  });

  it('opens the connect step on a click', () => {
    const onConnect = vi.fn();
    renderInto(<JoyCodeConnectButton onConnect={onConnect} />);
    act(() => connectControl()!.click());
    expect(onConnect).toHaveBeenCalledTimes(1);
  });
});

describe('a recipe row through a connect and a disconnect, without a reload', () => {
  it('disables Run with the connect hover text while no model is connected', () => {
    renderInto(
      <RecipeRunControls
        {...RECIPE}
        ready={false}
        noModel
        onRun={() => undefined}
        onConnect={() => undefined}
      />,
    );
    expect(runButton().disabled).toBe(true);
    expect(runButton().title).toBe(CONNECT_MODEL_FIRST_TITLE);
    expect(connectControl()).not.toBeNull();
  });

  it('enables Run after a model is connected, and removes the connect step', () => {
    const onRun = vi.fn();
    const props = { ...RECIPE, onRun, onConnect: () => undefined };
    renderInto(<RecipeRunControls {...props} ready={false} noModel />);
    renderInto(<RecipeRunControls {...props} ready noModel={false} />);
    expect(runButton().disabled).toBe(false);
    expect(runButton().title).toBe('');
    expect(connectControl()).toBeNull();
    act(() => runButton().click());
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('disables Run again after the model is disconnected', () => {
    const props = { ...RECIPE, onRun: () => undefined, onConnect: () => undefined };
    renderInto(<RecipeRunControls {...props} ready noModel={false} />);
    expect(runButton().disabled).toBe(false);
    renderInto(<RecipeRunControls {...props} ready={false} noModel />);
    expect(runButton().disabled).toBe(true);
    expect(runButton().title).toBe(CONNECT_MODEL_FIRST_TITLE);
    expect(connectControl()).not.toBeNull();
  });

  it('keeps Run disabled, without the connect step, while a run is in progress', () => {
    renderInto(
      <RecipeRunControls
        {...RECIPE}
        ready
        noModel={false}
        blocked
        running
        onRun={() => undefined}
      />,
    );
    expect(runButton().disabled).toBe(true);
    expect(runButton().textContent).toBe('Running…');
    expect(connectControl()).toBeNull();
  });
});
