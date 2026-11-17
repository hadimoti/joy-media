// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PanelShell } from './PanelShell.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
});

describe('PanelShell dismissible note', () => {
  it('shows a close icon in front of the note and calls onDismissNote when it is clicked', () => {
    const dismiss = vi.fn();
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => {
      root?.render(
        <PanelShell title="Assets" note="clip.mp4 added to the timeline." onDismissNote={dismiss}>
          <p>Body</p>
        </PanelShell>,
      );
    });

    const note = host.querySelector('.joy-panel-note');
    const close = note?.querySelector<HTMLButtonElement>('button.joy-panel-note-close');
    expect(close).not.toBeNull();
    expect(close?.getAttribute('aria-label')).toBe('Dismiss message');
    expect(close?.querySelector('svg')).not.toBeNull();
    // The icon comes first, the text after it.
    expect(note?.firstElementChild).toBe(close);
    expect(note?.textContent).toContain('clip.mp4 added to the timeline.');

    act(() => close?.click());
    expect(dismiss).toHaveBeenCalledTimes(1);
  });

  it('shows no close icon when the note cannot be dismissed', () => {
    const markup = renderToStaticMarkup(
      <PanelShell title="Inspector" note="Select a clip">
        <p>Body</p>
      </PanelShell>,
    );
    expect(markup).toContain('Select a clip');
    expect(markup).not.toContain('joy-panel-note-close');
  });
});
