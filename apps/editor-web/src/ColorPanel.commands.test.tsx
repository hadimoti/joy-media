// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canonicalBindingKey,
  colorPropertyBinding,
  createIdentityColorGrade,
  encodeColorLutReference,
  IDENTITY_COLOR_ADJUSTMENTS,
  type ColorGradeV2,
  type JoyProjectV1,
} from '@joy-media/project-schema';
import {
  applyVisualObjectProjectTransaction,
  type VisualObjectTransaction,
} from '@joy-media/property-system';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { AdjustSection, ColorPanel } from './ColorPanel.js';
import { EditorPanelContext, type EditorPanelContextValue } from './editor-panel-context.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The twelve Adjust sliders: the stored key, the slider's label, the value its
 * Reset returns it to, and a value the test drags it to.
 */
const ADJUST_SLIDERS = [
  ['temperature', 'Temperature', 0, 0.4],
  ['tint', 'Tint', 0, -0.2],
  ['exposure', 'Exposure', 0, 1.5],
  ['contrast', 'Contrast', 0, 0.3],
  ['pivot', 'Pivot', 0.5, 0.65],
  ['highlights', 'Highlights', 0, 0.35],
  ['shadows', 'Shadows', 0, -0.25],
  ['whites', 'Whites', 0, 0.45],
  ['blacks', 'Blacks', 0, -0.4],
  ['saturation', 'Saturation', 1, 1.4],
  ['vibrance', 'Vibrance', 0, 0.5],
  ['hue', 'Hue', 0, 45],
] as const;

const LOOKS = [
  ['none', 'None'],
  ['clean-contrast', 'Clean Contrast'],
  ['soft-film', 'Soft Film'],
  ['warm-cinema', 'Warm Cinema'],
  ['cool-fade', 'Cool Fade'],
  ['monochrome', 'Monochrome'],
] as const;

const PLAYHEAD_US = 750_000;

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let session: { project: JoyProjectV1; dispatched: VisualObjectTransaction[] };

afterEach(async () => {
  if (root !== undefined) await act(async () => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  document.body.innerHTML = '';
});

/**
 * The panel as the editor runs it: every dispatched transaction is applied to
 * the project, and the panel renders again with that project.
 */
function mountColor(project: JoyProjectV1 = INITIAL_EDITOR_PROJECT): void {
  session = { project, dispatched: [] };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  settle();
}

function settle(): void {
  act(() => {
    root!.render(
      <EditorPanelContext.Provider
        value={{ showToast: vi.fn() } as unknown as EditorPanelContextValue}
      >
        <ColorPanel
          project={session.project}
          onChange={vi.fn()}
          playheadUs={PLAYHEAD_US}
          onDispatch={(transaction) => {
            session.dispatched.push(transaction);
            session.project = applyVisualObjectProjectTransaction(session.project, transaction);
          }}
        />
      </EditorPanelContext.Provider>,
    );
  });
}

function el<T extends Element = HTMLElement>(selector: string): T {
  const found = container!.querySelector<T>(selector);
  if (found === null) throw new Error(`no element for ${selector}`);
  return found;
}

function click(element: HTMLElement): void {
  act(() => element.click());
  settle();
}

function tab(id: 'adjust' | 'looks'): void {
  click(el<HTMLButtonElement>(`[data-panel-tab-id="${id}"]`));
}

function lookCard(label: string): HTMLButtonElement {
  const card = [...container!.querySelectorAll<HTMLButtonElement>('button.look-card')].find(
    (candidate) => candidate.querySelector('.look-card-label')?.textContent === label,
  );
  if (card === undefined) throw new Error(`no look card ${label}`);
  return card;
}

/** Drags a range input the way a colourist does: the input event, then the pointer release. */
function dragInput(label: string, value: number): void {
  const input = el<HTMLInputElement>(`input[type="range"][aria-label="${label}"]`);
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  act(() => {
    input.dispatchEvent(new Event('pointerup', { bubbles: true }));
  });
}

/** A drag inside the full panel, which then shows the document the drag wrote. */
function drag(label: string, value: number): void {
  dragInput(label, value);
  settle();
}

function lastCommand(): { type: string; payload: Record<string, unknown> } {
  const transaction = session.dispatched.at(-1);
  if (transaction === undefined) throw new Error('nothing was dispatched');
  return transaction.commands[0] as { type: string; payload: Record<string, unknown> };
}

function committedAdjust(): Record<string, number | undefined> {
  return { ...(session.project.colorGrade as ColorGradeV2 | undefined)?.adjust };
}

describe('Color panel Adjust sliders reach the project document', () => {
  it.each(ADJUST_SLIDERS)(
    'dragging %s commits one colour grade change and the document takes the value',
    (key, label, _reset, moveTo) => {
      mountColor();
      tab('adjust');
      drag(label, moveTo);

      // The drag itself writes nothing; only the release commits one change.
      expect(session.dispatched).toHaveLength(1);
      expect(lastCommand()).toMatchObject({
        type: 'color.setGrade',
        payload: { target: { scope: 'output' } },
      });
      expect(committedAdjust()[key]).toBe(moveTo);
    },
  );

  it.each(ADJUST_SLIDERS)(
    'Reset %s returns it to its identity value in the document',
    (key, label, reset, moveTo) => {
      mountColor();
      tab('adjust');
      drag(label, moveTo);
      click(el<HTMLButtonElement>(`button.property-row-reset[aria-label="Reset ${label}"]`));

      expect(session.dispatched).toHaveLength(2);
      expect(committedAdjust()[key]).toBe(reset);
    },
  );

  it.each(ADJUST_SLIDERS)(
    'a keyframe on %s at the playhead stores the value the slider holds',
    (key, label, _reset, moveTo) => {
      mountColor();
      tab('adjust');
      drag(label, moveTo);
      click(el<HTMLButtonElement>(`button[aria-label="Add ${label} keyframe at playhead"]`));

      expect(session.dispatched).toHaveLength(2);
      expect(lastCommand()).toEqual({
        type: 'propertyAnimation.replace',
        payload: {
          binding: colorPropertyBinding('output', `adjust.${key}`),
          value: {
            kind: key === 'hue' ? 'hue' : 'scalar',
            curve: {
              keyframes: [{ timeUs: PLAYHEAD_US, value: moveTo, interpolation: 'linear' }],
            },
          },
        },
      });
      // The keyframe is saved on the document, and the button now says so.
      const saved =
        session.project.propertyAnimations?.[
          canonicalBindingKey(colorPropertyBinding('output', `adjust.${key}`))
        ];
      expect(saved?.value.kind).toBe(key === 'hue' ? 'hue' : 'scalar');
      expect(el(`button[aria-label="Remove ${label} keyframe at playhead"]`)).not.toBeNull();
    },
  );

  it('LUT intensity: drag commits, keyframe stores the value, Reset returns it to 1', () => {
    mountColor();
    tab('looks');
    drag('LUT intensity', 0.6);
    expect(session.dispatched).toHaveLength(1);
    expect(session.project.colorGrade).toMatchObject({ lut: { intensity: 0.6 } });

    click(el<HTMLButtonElement>('button[aria-label="Add LUT intensity keyframe at playhead"]'));
    expect(lastCommand()).toEqual({
      type: 'propertyAnimation.replace',
      payload: {
        binding: colorPropertyBinding('output', 'lut.intensity'),
        value: {
          kind: 'scalar',
          curve: {
            keyframes: [{ timeUs: PLAYHEAD_US, value: 0.6, interpolation: 'linear' }],
          },
        },
      },
    });

    click(el<HTMLButtonElement>('button.property-row-reset[aria-label="Reset LUT intensity"]'));
    expect(session.project.colorGrade).toMatchObject({ lut: { intensity: 1 } });
  });

  it.each(LOOKS)('keyframing the %s look stores its reference at the playhead', (look, label) => {
    mountColor();
    tab('looks');
    if (look !== 'none') click(lookCard(label));
    click(el<HTMLButtonElement>('button[aria-label="Add Look or LUT keyframe at playhead"]'));

    const command = lastCommand();
    expect(command.type).toBe('propertyAnimation.replace');
    expect(command.payload.binding).toEqual(colorPropertyBinding('output', 'lut.reference'));
    // The panel's replace path also writes a `kind` field on each string key. Only the
    // time and the look reference are asserted here; sampling reads just those two.
    expect(command.payload.value).toMatchObject({
      kind: 'string',
      keys: [
        {
          timeUs: PLAYHEAD_US,
          value: encodeColorLutReference({ builtIn: look, intensity: 1 }),
        },
      ],
    });
    const saved =
      session.project.propertyAnimations?.[
        canonicalBindingKey(colorPropertyBinding('output', 'lut.reference'))
      ];
    expect(saved?.value).toMatchObject({
      kind: 'string',
      keys: [{ timeUs: PLAYHEAD_US, value: `builtin:${look}` }],
    });
  });

  it.each(LOOKS.slice(1))('choosing the %s look commits it to the document', (look, label) => {
    mountColor();
    tab('looks');
    click(lookCard(label));
    expect(session.dispatched).toHaveLength(1);
    expect(session.project.colorGrade).toMatchObject({ lut: { builtIn: look, intensity: 1 } });
  });

  it('choosing None on an identity grade changes nothing', () => {
    mountColor();
    tab('looks');
    click(lookCard('None'));
    expect(session.dispatched).toHaveLength(0);
  });

  it('Reset all returns every slider and the look to identity in one change', () => {
    mountColor();
    tab('adjust');
    drag('Temperature', 0.4);
    drag('Saturation', 1.4);
    tab('looks');
    click(lookCard('Warm Cinema'));
    expect(session.project.colorGrade).not.toEqual(createIdentityColorGrade());

    click(el<HTMLButtonElement>('button[aria-label="Reset all color controls"]'));
    expect(session.dispatched).toHaveLength(4);
    expect(lastCommand().payload).toEqual({
      target: { scope: 'output' },
      grade: createIdentityColorGrade(),
    });
    expect(session.project.colorGrade).toEqual(createIdentityColorGrade());
  });
});

/** Mounts the Adjust section with plain spies, so the calls it makes can be read directly. */
function AdjustHarness({
  patched,
  committed,
}: {
  readonly patched: (...args: [string, number, boolean?]) => void;
  readonly committed: (next: ColorGradeV2) => void;
}) {
  const [draft, setDraft] = useState<ColorGradeV2>(createIdentityColorGrade());
  return (
    <AdjustSection
      draft={draft}
      onPatch={(...args) => {
        patched(...args);
        const [key, value] = args;
        setDraft((current) => ({
          ...current,
          adjust: { ...IDENTITY_COLOR_ADJUSTMENTS, ...current.adjust, [key]: value },
        }));
      }}
      onCommit={(next) => {
        committed(next);
        setDraft(next);
      }}
      animationStateFor={() => 'none'}
      onToggleAnimation={() => undefined}
      canAnimate={false}
    />
  );
}

describe('AdjustSection patches and commits', () => {
  it.each(ADJUST_SLIDERS)(
    'a %s drag is patched live and finalised once on release',
    (key, label, _reset, moveTo) => {
      const patched = vi.fn();
      const committed = vi.fn();
      container = document.createElement('div');
      document.body.append(container);
      root = createRoot(container);
      act(() => root!.render(<AdjustHarness patched={patched} committed={committed} />));

      dragInput(label, moveTo);

      expect(patched).toHaveBeenNthCalledWith(1, key, moveTo);
      expect(patched).toHaveBeenNthCalledWith(2, key, moveTo, true);
      expect(patched).toHaveBeenCalledTimes(2);
      expect(committed).not.toHaveBeenCalled();
    },
  );

  it('Reset section commits the identity adjustments as one grade', () => {
    const patched = vi.fn();
    const committed = vi.fn();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => root!.render(<AdjustHarness patched={patched} committed={committed} />));
    dragInput('Contrast', 0.3);
    act(() => el<HTMLButtonElement>('button.section-reset').click());

    expect(committed).toHaveBeenCalledTimes(1);
    expect(committed.mock.calls[0]![0]).toMatchObject({ adjust: IDENTITY_COLOR_ADJUSTMENTS });
  });
});
