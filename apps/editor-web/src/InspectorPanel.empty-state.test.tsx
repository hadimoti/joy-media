// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InspectorPanel } from './InspectorPanel.js';

describe('the Inspector with nothing selected (T-D05)', () => {
  it('says one line, and it is one line', () => {
    const markup = renderToStaticMarkup(
      <InspectorPanel
        object={undefined}
        allObjects={{}}
        playheadUs={0}
        onSetStatic={() => undefined}
        onDispatch={() => undefined}
      />,
    );

    expect(markup).toContain('Select a clip');
    expect(markup).not.toContain('Select a clip to edit its properties.');

    // One message for the whole panel: the note under the tabs, and nothing else.
    expect(markup.match(/joy-panel-hint/g) ?? []).toHaveLength(1);
    expect(markup).not.toContain('empty-hint');
  });
});
