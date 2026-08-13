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
});
