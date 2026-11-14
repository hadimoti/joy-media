// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { VisualObjectV1 } from '@joy-media/project-schema';
import { InspectorPanel } from './InspectorPanel.js';
import { monitorTransformPreview } from './monitor/monitor-transform-preview.js';
import { effectRegistry, registerBuiltins } from '@joy-media/visual-effects';

if (!effectRegistry.hasEffect('brightness-contrast')) registerBuiltins();

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const crop = { left: 0, top: 0, right: 0, bottom: 0 };
const SHAPE = {
  id: 'shape-1',
  kind: 'shape',
  transform: { x: 120, y: 80, scaleX: 1, scaleY: 0.5, rotationDeg: 0, opacity: 1, crop },
} as VisualObjectV1;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  monitorTransformPreview.set(undefined);
});

function mount(object: VisualObjectV1): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <InspectorPanel
        object={object}
        selectedName="Clip one"
        selectedKind="video"
        selectedTrackName="V1"
        allObjects={{ [object.id]: object }}
        playheadUs={1_500_000}
        onSetStatic={() => undefined}
        onDispatch={() => undefined}
      />,
    ),
  );
}

function rowOf(label: string): HTMLElement {
  const row = container!.querySelector<HTMLElement>(`[data-property-row="${label}"]`);
  if (row === null) throw new Error(`no row for ${label}`);
  return row;
}

/** The columns a row fills, left to right, named by the part that sits in each. */
const COLUMNS: readonly (readonly [string, string])[] = [
  ['label', '.property-row-label'],
  ['value', '.inspector-grid-value'],
  ['slider', '.property-control-slider'],
  ['reset', '.property-row-reset'],
  ['keyframe', '.property-row-keyframe'],
  ['fx', 'button.fx'],
];

function columnsOf(row: HTMLElement): string[] {
  const found = COLUMNS.flatMap(([name, selector]) => {
    const part = row.querySelector(selector);
    return part === null ? [] : [{ name, part }];
  });
  found.sort((a, b) =>
    a.part.compareDocumentPosition(b.part) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
  return found.map((entry) => entry.name);
}

describe('Inspector row grid (T-D10)', () => {
  it('gives every transform property its own row, one property per row', () => {
    mount(SHAPE);
    const labels = ['Position X', 'Position Y', 'Scale X', 'Scale Y', 'Rotation', 'Opacity'];
    for (const label of labels) {
      const row = rowOf(label);
      expect(row.classList.contains('inspector-grid-row'), label).toBe(true);
      // Exactly one editable value field and one label per row.
      expect(row.querySelectorAll('input[type="number"]'), label).toHaveLength(1);
      expect(row.querySelectorAll('.property-row-label'), label).toHaveLength(1);
    }
    expect(container!.querySelectorAll('[data-property-row].inspector-grid-row')).toHaveLength(
      labels.length,
    );

    const position = container!.querySelector('[role="group"][aria-label="Position"]')!;
    expect(position.querySelectorAll('[data-property-row]')).toHaveLength(2);
    const scale = container!.querySelector('[role="group"][aria-label="Scale"]')!;
    expect(scale.querySelectorAll('[data-property-row]')).toHaveLength(2);
  });

  it('puts the columns in the same order in Position, Scale, Rotation and Opacity', () => {
    mount(SHAPE);
    const sameColumns = ['label', 'value', 'reset', 'keyframe', 'fx'];
    for (const label of ['Position X', 'Position Y', 'Scale X', 'Scale Y', 'Rotation']) {
      expect(columnsOf(rowOf(label)), label).toEqual(sameColumns);
    }
    // Opacity is the same columns with its slider in the free-space column.
    expect(columnsOf(rowOf('Opacity'))).toEqual([
      'label',
      'value',
      'slider',
      'reset',
      'keyframe',
      'fx',
    ]);
  });

  it('shows each value once, in its field, with the unit inside the field', () => {
    mount(SHAPE);
    expect(container!.querySelectorAll('.property-row-value')).toHaveLength(0);
    const unit = rowOf('Opacity').querySelector('.inspector-grid-value .inspector-unit');
    expect(unit?.textContent).toBe('%');
  });

  it('keeps the interpolation icons on the Transform header line', () => {
    mount(SHAPE);
    const head = container!.querySelector('.inspector-section-head')!;
    expect(head.querySelector('h3')?.textContent).toBe('Transform');
    const icons = head.querySelector('[role="group"][aria-label="Keyframe interpolation"]')!;
    expect(icons.querySelectorAll('button')).toHaveLength(4);
    expect(icons.querySelector('button[aria-label="Linear"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('shows the clip name and the playhead on one line, then the four details', () => {
    mount(SHAPE);
    const line = container!.querySelector('.inspector-selection-row')!;
    expect(line.querySelector('.inspector-selected-name')?.textContent).toBe('Clip one');
    expect(line.querySelector('.inspector-playhead-meta')?.textContent).toBe('1.50s');
    const details = [...container!.querySelectorAll('.inspector-selection-detail span')].map(
      (span) => span.textContent,
    );
    expect(details).toEqual(['Kind', 'Track', 'Source', 'Timeline']);
    // The name appears once; no word is repeated in the header.
    expect(container!.textContent?.match(/Clip one/g)).toHaveLength(1);
  });

  it('gives the Effects tab the same row grid', () => {
    mount({
      ...SHAPE,
      effects: [
        {
          id: 'fx-1',
          effectId: 'brightness-contrast',
          enabled: true,
          params: { brightness: 0.2 },
        },
      ],
    } as unknown as VisualObjectV1);
    const tabs = [...container!.querySelectorAll<HTMLElement>('[role="tab"]')];
    const effects = tabs.find((tab) => tab.textContent === 'Effects')!;
    act(() => effects.click());
    const rows = container!.querySelectorAll('[data-property-row].inspector-grid-row');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.querySelector('.property-row-value')).toBeNull();
      const columns = columnsOf(row as HTMLElement);
      expect(columns[0]).toBe('label');
      expect(columns[1]).toBe('value');
    }
  });
});
