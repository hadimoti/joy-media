import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TimelineCanvas } from './TimelineCanvas.js';

describe('TimelineCanvas track visibility controls', () => {
  it('renders accessible eye controls with honest show/hide semantics', () => {
    const markup = renderToStaticMarkup(
      <TimelineCanvas
        durationUs={10_000_000}
        playheadUs={0}
        viewport={{ originUs: 0, pixelsPerSecond: 20 }}
        onViewportChange={() => undefined}
        autoFit={false}
        tracks={[
          {
            id: 'visible-track',
            label: 'Visible track',
            items: [],
            controls: {
              trackId: 'visible-track',
              locked: false,
              visible: true,
              solo: false,
              onToggle: () => undefined,
            },
          },
          {
            id: 'hidden-track',
            label: 'Hidden track',
            items: [],
            controls: {
              trackId: 'hidden-track',
              locked: false,
              visible: false,
              solo: false,
              onToggle: () => undefined,
            },
          },
        ]}
        selectedClipIds={new Set()}
        onSeek={() => undefined}
        onSelectClips={() => undefined}
      />,
    );

    expect(markup).toContain('aria-label="Hide visible-track"');
    expect(markup).toContain('title="Hide track"');
    expect(markup).toContain('aria-label="Show hidden-track"');
    expect(markup).toContain('title="Show track"');
    expect(markup).toContain('d="M1.5 8s2.5-4.5');
    expect(markup).toContain('d="M2.5 2.5 13.5 13.5');
    expect(markup).not.toContain('Mute');
    expect(markup).not.toContain('Speaker');
  });
});
