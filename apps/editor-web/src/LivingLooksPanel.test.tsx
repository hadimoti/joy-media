// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { BUILT_IN_LOOK_PACKS } from '@joy-media/motion-core';
import { CONTENT_FONT_FAMILIES } from '@joy-media/project-schema';
import { JOY_CODE_OPERATION_KINDS } from '@joy-media/agent-tools';
import { catalog } from './joy-agent/look-operations.js';
import { LivingLooksPanel, type LivingLooksEntityOption } from './LivingLooksPanel.js';

const CATALOG = catalog(BUILT_IN_LOOK_PACKS, {
  availableOperationKinds: JOY_CODE_OPERATION_KINDS,
  availableFonts: CONTENT_FONT_FAMILIES as readonly string[],
});

const ENTITIES: LivingLooksEntityOption[] = [
  { id: 'title-1', label: 'Headline title', kind: 'visual-object' },
  { id: 'title-2', label: 'Deck title', kind: 'visual-object' },
  { id: 'cap-1', label: 'Captions', kind: 'caption-clip' },
];

let container: HTMLElement | undefined;
let root: Root | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = undefined;
  root = undefined;
});

function mount(overrides: Partial<Parameters<typeof LivingLooksPanel>[0]> = {}): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <LivingLooksPanel
        hidden={false}
        catalog={CATALOG}
        entities={ENTITIES}
        runningLookId={undefined}
        busy={false}
        onRun={vi.fn()}
        {...overrides}
      />,
    );
  });
}

function q<T extends Element>(selector: string): T {
  const el = container!.querySelector<T>(selector);
  if (el === null) throw new Error(`no element for ${selector}`);
  return el;
}

describe('LivingLooksPanel', () => {
  it('lists all five packs with honest availability', () => {
    const markup = renderToStaticMarkup(
      <LivingLooksPanel
        hidden={false}
        catalog={CATALOG}
        entities={ENTITIES}
        runningLookId={undefined}
        busy={false}
        onRun={() => undefined}
      />,
    );
    for (const pack of BUILT_IN_LOOK_PACKS) expect(markup).toContain(pack.title);
  });

  it('marks a pack unavailable when a required operation kind is missing', () => {
    const limited = catalog(BUILT_IN_LOOK_PACKS, {
      availableOperationKinds: JOY_CODE_OPERATION_KINDS.filter((k) => k !== 'text.setTemplate'),
      availableFonts: CONTENT_FONT_FAMILIES as readonly string[],
    });
    const markup = renderToStaticMarkup(
      <LivingLooksPanel
        hidden={false}
        catalog={limited}
        entities={ENTITIES}
        runningLookId={undefined}
        busy={false}
        onRun={() => undefined}
      />,
    );
    expect(markup).toMatch(/is-unavailable/);
    expect(markup).toContain('Needs:');
  });

  it('keeps Run disabled until the required slot is bound, then emits bound inputs', () => {
    const onRun = vi.fn();
    mount({ onRun });

    const runButton = q<HTMLButtonElement>('.living-look-run');
    expect(runButton.disabled).toBe(true);

    const headlineSelect = q<HTMLSelectElement>('.living-look-slot select');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLSelectElement.prototype,
        'value',
      )!.set!;
      setter.call(headlineSelect, 'title-1');
      headlineSelect.dispatchEvent(new Event('change', { bubbles: true }));
    });

    expect(q<HTMLButtonElement>('.living-look-run').disabled).toBe(false);

    act(() => {
      q<HTMLFormElement>('.living-look-editor').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });

    expect(onRun).toHaveBeenCalledTimes(1);
    const arg = onRun.mock.calls[0]![0];
    expect(arg.definitionId).toBe('editorial-clean');
    expect(arg.definitionVersion).toBe(1);
    expect(arg.entityBindings.headline).toBe('title-1');
    const clean = BUILT_IN_LOOK_PACKS.find((p) => p.id === 'editorial-clean')!;
    for (const control of clean.controls) expect(arg.controlValues[control.id]).toBeDefined();
    expect(arg.kind).toBe('apply');
  });

  it('an applied Look row emits detach / reset / update inputs', () => {
    const onRun = vi.fn();
    const clean = BUILT_IN_LOOK_PACKS.find((p) => p.id === 'editorial-clean')!;
    mount({
      onRun,
      applied: [
        {
          instanceId: 'look-1',
          definitionId: 'editorial-clean',
          title: clean.title,
          controlValues: {},
          overriddenBindingIds: ['b1', 'b2'],
          orphaned: false,
        },
      ],
    });

    expect(container!.querySelector('.applied-looks')).not.toBeNull();

    act(() => {
      container!.querySelector<HTMLButtonElement>('.applied-look-reset')!.click();
    });
    expect(onRun).toHaveBeenCalledWith({
      kind: 'reset',
      instanceId: 'look-1',
      bindingIds: ['b1', 'b2'],
    });

    act(() => {
      container!.querySelector<HTMLButtonElement>('.applied-look-detach')!.click();
    });
    expect(onRun).toHaveBeenCalledWith({ kind: 'detach', instanceId: 'look-1' });

    const firstControl = container!.querySelector<HTMLInputElement>(
      '.applied-look-control input, .applied-look-control select',
    )!;
    act(() => {
      if (firstControl instanceof HTMLInputElement && firstControl.type === 'range') {
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )!.set!;
        setter.call(firstControl, '0.5');
      }
      firstControl.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const updateCall = onRun.mock.calls.find((c) => c[0]?.kind === 'update');
    expect(updateCall).toBeDefined();
    expect(updateCall![0].instanceId).toBe('look-1');
  });

  it('shows the "Ask JOY" agent affordance only when onAgentRun is provided', () => {
    const withoutAgent = renderToStaticMarkup(
      <LivingLooksPanel
        hidden={false}
        catalog={CATALOG}
        entities={ENTITIES}
        runningLookId={undefined}
        busy={false}
        onRun={() => undefined}
      />,
    );
    expect(withoutAgent).not.toContain('living-looks-agent');

    const onAgentRun = vi.fn();
    mount({ onAgentRun });
    const textarea = q<HTMLTextAreaElement>('.living-looks-agent-prompt');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype,
        'value',
      )!.set!;
      setter.call(textarea, 'apply editorial clean to the headline');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      q<HTMLFormElement>('.living-looks-agent').dispatchEvent(
        new Event('submit', { bubbles: true, cancelable: true }),
      );
    });
    expect(onAgentRun).toHaveBeenCalledWith('apply editorial clean to the headline');
  });

  it('marks an orphaned applied Look', () => {
    const clean = BUILT_IN_LOOK_PACKS.find((p) => p.id === 'editorial-clean')!;
    const markup = renderToStaticMarkup(
      <LivingLooksPanel
        hidden={false}
        catalog={CATALOG}
        entities={ENTITIES}
        applied={[
          {
            instanceId: 'look-1',
            definitionId: 'editorial-clean',
            title: clean.title,
            controlValues: {},
            overriddenBindingIds: [],
            orphaned: true,
          },
        ]}
        runningLookId={undefined}
        busy={false}
        onRun={() => undefined}
      />,
    );
    expect(markup).toMatch(/is-orphaned/);
    expect(markup).toContain('rebind or detach');
  });
});
