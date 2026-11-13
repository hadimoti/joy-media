// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AudioPanel } from './AudioPanel.js';
import { AUDIO_WORKFLOW_PRESETS } from './audio-studio-runtime.js';
import { EMPTY_AUDIO_STATE } from './audio-session.js';
import { PopupProvider, usePopup } from './popup-manager.js';
import { POPUP_IDS } from './popup-ids.js';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * T-D15: the Enhance presets are a 2 x 3 card grid; the processing plan appears
 * only after a preset is chosen; the engine status is an info popover on the
 * shared popup manager (T-P05).
 */

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** A second popup on the same manager, to test the one-popup rule. */
function OtherPopup() {
  const popup = usePopup(POPUP_IDS.monitorZoom);
  return (
    <div ref={popup.rootRef}>
      <button
        type="button"
        data-testid="other-popup"
        data-popup-trigger={POPUP_IDS.monitorZoom}
        onClick={(event) => popup.toggle(event.currentTarget)}
      >
        Other
      </button>
      {popup.open && <div role="dialog" aria-label="Other popup" />}
    </div>
  );
}

function render(
  onRunBrowserDsp: (workflowId: string, clipIds: readonly string[]) => void = () => undefined,
  withOtherPopup = false,
) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <PopupProvider>
        <AudioPanel
          clipIds={['voice-a']}
          audioState={EMPTY_AUDIO_STATE}
          onAudioChange={() => undefined}
          onRunBrowserDsp={onRunBrowserDsp}
        />
        {withOtherPopup && <OtherPopup />}
      </PopupProvider>,
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

function popover(): Element | null {
  return container?.querySelector('#audio-engine-status-popover') ?? null;
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

  it('does not call the apply path when a preset is chosen; only Apply calls it', () => {
    const onRunBrowserDsp = vi.fn();
    render(onRunBrowserDsp);

    // Choosing a preset shows the plan and the Review button. It changes nothing yet.
    act(() => presetButtons()[0]!.click());
    expect(onRunBrowserDsp).not.toHaveBeenCalled();

    // Review shows the Apply step; still nothing is applied.
    act(() => button('Review Voice Polish changes').click());
    expect(onRunBrowserDsp).not.toHaveBeenCalled();

    // Only the Apply press calls the apply path, once, for the chosen preset.
    act(() => button('Apply changes').click());
    expect(onRunBrowserDsp).toHaveBeenCalledTimes(1);
    expect(onRunBrowserDsp.mock.calls[0]?.[0]).toBe(AUDIO_WORKFLOW_PRESETS[0]!.id);
  });
});

describe('AudioPanel engine status popover (T-D15, T-P05)', () => {
  it('is closed by default and opens and closes from its info button', () => {
    render();
    expect(popover()).toBeNull();
    const trigger = button('Engine status');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.title).toBe('Engine status');

    act(() => trigger.click());
    expect(popover()).not.toBeNull();
    expect(popover()?.textContent).toMatch(/Browser DSP/);
    expect(popover()?.textContent).toMatch(/Local device/);
    expect(button('Engine status').getAttribute('aria-expanded')).toBe('true');

    act(() => button('Close engine status').click());
    expect(popover()).toBeNull();
  });

  it('closes on Escape and returns focus to its trigger', () => {
    render();
    act(() => button('Engine status').click());
    expect(popover()).not.toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(popover()).toBeNull();
    expect(document.activeElement).toBe(button('Engine status'));
  });

  it('closes on an outside pointer press', () => {
    render();
    act(() => button('Engine status').click());
    expect(popover()).not.toBeNull();

    act(() => {
      document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });

    expect(popover()).toBeNull();
  });

  it('stays open for a press inside it', () => {
    render();
    act(() => button('Engine status').click());
    act(() => {
      popover()!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    expect(popover()).not.toBeNull();
  });

  it('is one popup at a time: opening another popup closes it, and the reverse', () => {
    render(undefined, true);
    const other = () =>
      container?.querySelector('[data-testid="other-popup"]') as HTMLButtonElement;

    act(() => button('Engine status').click());
    expect(popover()).not.toBeNull();

    act(() => other().click());
    expect(popover()).toBeNull();
    expect(container?.querySelector('[role="dialog"][aria-label="Other popup"]')).not.toBeNull();

    act(() => button('Engine status').click());
    expect(popover()).not.toBeNull();
    expect(container?.querySelector('[role="dialog"][aria-label="Other popup"]')).toBeNull();
  });
});
