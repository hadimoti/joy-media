import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PropertyRow } from './PropertyRow.js';

describe('PropertyRow', () => {
  it('exposes every reusable keyframe action with a named accessible control', () => {
    const markup = renderToStaticMarkup(
      <PropertyRow
        label="Position X"
        controlId="position-x"
        value="120 px"
        onReset={() => undefined}
        onToggleAnimation={() => undefined}
        animationState="keyed"
        onPreviousKeyframe={() => undefined}
        onNextKeyframe={() => undefined}
        onOpenGraph={() => undefined}
      >
        <input id="position-x" type="number" value="120" readOnly />
      </PropertyRow>,
    );

    expect(markup).toContain('for="position-x"');
    expect(markup).toContain('Reset Position X');
    expect(markup).toContain('Remove Position X keyframe at playhead');
    expect(markup).toContain('Previous Position X keyframe');
    expect(markup).toContain('Next Position X keyframe');
    expect(markup).toContain('Open Position X in Graph Editor');
    expect(markup).toContain('aria-pressed="true"');
  });

  it('keeps mixed, disabled, and validation states explicit to assistive technology', () => {
    const markup = renderToStaticMarkup(
      <PropertyRow
        label="Opacity"
        controlId="opacity"
        mixed
        disabled
        error="Opacity must remain between 0 and 100."
        onReset={() => undefined}
        onToggleAnimation={() => undefined}
      >
        <input id="opacity" type="number" disabled />
      </PropertyRow>,
    );

    expect(markup).toContain('property-row-compact is-mixed is-disabled has-error');
    expect(markup).toContain('Mixed');
    expect(markup).toContain('Opacity must remain between 0 and 100.');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain('disabled=""');
  });

  it('uses the two-line layout for compound controls without removing the keyboard actions', () => {
    const markup = renderToStaticMarkup(
      <PropertyRow label="Color" layout="two-line" onToggleAnimation={() => undefined}>
        <input aria-label="Color value" type="text" value="#ffcc00" readOnly />
      </PropertyRow>,
    );

    expect(markup).toContain('property-row-two-line');
    expect(markup).toContain('Add Color keyframe at playhead');
  });

  it('keeps an inline mix row to one line with one value and a diamond keyframe control', () => {
    const markup = renderToStaticMarkup(
      <PropertyRow
        label="Gain"
        controlId="gain"
        value="1.00"
        layout="inline"
        onToggleAnimation={() => undefined}
        animationState="keyed"
      >
        <input id="gain" type="range" value="1" readOnly />
      </PropertyRow>,
    );

    expect(markup).toContain('property-row-inline');
    expect(markup).toContain('property-row-keyframe is-keyed');
    expect(markup).toContain('M8 3 13 8 8 13 3 8Z');
    expect(markup).toContain('fill="currentColor"');
    expect(markup).not.toContain('property-row-stopwatch');
    expect(markup.match(/1\.00/g)).toHaveLength(1);
  });

  it('keeps a between-keyframe diamond outlined', () => {
    const markup = renderToStaticMarkup(
      <PropertyRow label="Pan" onToggleAnimation={() => undefined} animationState="between">
        <input type="range" value="0" readOnly />
      </PropertyRow>,
    );

    expect(markup).toContain('property-row-keyframe is-between');
    expect(markup).toContain('M8 3 13 8 8 13 3 8Z');
    expect(markup).not.toContain('fill="currentColor"');
  });
});
