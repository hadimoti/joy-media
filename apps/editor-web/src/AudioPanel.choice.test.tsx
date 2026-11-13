// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPanel } from './AudioPanel.js';
import { AUDIO_WORKFLOW_PRESETS } from './audio-studio-runtime.js';
import { EMPTY_AUDIO_STATE } from './audio-session.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * T-D15: the Enhance presets are a 2 x 3 card grid; the processing plan appears
 * only after a preset is chosen; the engine status is an info popover.
 */

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function render() {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <AudioPanel
        clipIds={['voice-a']}
        audioState={EMPTY_AUDIO_STATE}
        onAudioChange={() => undefined}
        onRunBrowserDsp={() => undefined}
      />,
    ),
  );
}

function presetButtons(): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll<HTMLButtonElement>('.audio-workflow-choice') ?? []);
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(container?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
    (candidate) => candidate.getAttribute('aria-label') === label,
  );
  if (found === undefined) throw new Error(`No button "${label}"`);
  return found;
}

describe('AudioPanel presets (T-D15)', () => {
  it('lists the six presets as cards', () => {
    render();
    expect(presetButtons()).toHaveLength(AUDIO_WORKFLOW_PRESETS.length);
    expect(presetButtons()).toHaveLength(6);
    for (const preset of presetButtons()) expect(preset.textContent).toMatch(/steps/);
  });

  it('shows the processing plan and Apply only after a choice', () => {
    render();
    expect(container?.querySelector('[aria-label="Processing plan"]')).toBeNull();
    expect(container?.querySelector('[aria-label="Review Voice Polish changes"]')).toBeNull();

    act(() => presetButtons()[0]!.click());

    expect(container?.querySelector('[aria-label="Processing plan"]')).not.toBeNull();
    expect(container?.querySelector('[aria-label="Review Voice Polish changes"]')).not.toBeNull();
    expect(presetButtons()[0]!.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('AudioPanel engine status popover (T-D15)', () => {
  it('is closed by default and opens and closes from its info button', () => {
    render();
    expect(container?.querySelector('#audio-engine-status-popover')).toBeNull();
    const trigger = button('Engine status');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.title).toBe('Engine status');

    act(() => trigger.click());
    const popover = container?.querySelector('#audio-engine-status-popover');
    expect(popover).not.toBeNull();
    expect(popover?.textContent).toMatch(/Browser DSP/);
    expect(popover?.textContent).toMatch(/Local Worker/);
    expect(button('Engine status').getAttribute('aria-expanded')).toBe('true');

    act(() => button('Close engine status').click());
    expect(container?.querySelector('#audio-engine-status-popover')).toBeNull();
  });

  it('does not call the apply path when a preset is only previewed', () => {
    const onRunBrowserDsp = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root?.render(
        <AudioPanel
          clipIds={['voice-a']}
          audioState={EMPTY_AUDIO_STATE}
          onAudioChange={() => undefined}
          onRunBrowserDsp={onRunBrowserDsp}
        />,
      ),
    );
    expect(onRunBrowserDsp).not.toHaveBeenCalled();
  });
});
