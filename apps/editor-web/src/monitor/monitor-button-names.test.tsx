// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_MONITOR_VIEW_OPTIONS } from './monitor-view-options.js';
import { MonitorViewMenu } from './MonitorViewMenu.js';

/**
 * T-M12: every button in a rendered Monitor control has an accessible name and a tooltip
 * (title). A button that has a keyboard shortcut must name it in its tooltip.
 */

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

function render(element: ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => root?.render(element));
  return container;
}

/** The problems with the controls under `host`: no name, or no tooltip. */
function controlProblems(host: HTMLElement): string[] {
  const controls = [...host.querySelectorAll<HTMLElement>('button, [role="button"]')];
  return controls.flatMap((control) => {
    const name = control.getAttribute('aria-label') ?? control.textContent?.trim() ?? '';
    const tooltip = control.getAttribute('title') ?? '';
    const problems = [
      ...(name.length === 0 ? ['no name'] : []),
      ...(tooltip.length === 0 ? ['no tooltip'] : []),
    ];
    return problems.length === 0 ? [] : [`${name || control.className}: ${problems.join(', ')}`];
  });
}

describe('Monitor controls have a name and a tooltip (T-M12)', () => {
  it('every button of the rendered View menu has a name and a tooltip, once the menu is open', () => {
    const host = render(
      <MonitorViewMenu options={DEFAULT_MONITOR_VIEW_OPTIONS} onChange={() => undefined} />,
    );
    const trigger = host.querySelector<HTMLButtonElement>('.monitor-view-trigger');
    expect(trigger).not.toBeNull();
    act(() => trigger?.click());

    const controls = host.querySelectorAll('button, [role="button"]');
    expect(controls.length).toBeGreaterThan(5);
    expect(controlProblems(host)).toEqual([]);
  });
});
