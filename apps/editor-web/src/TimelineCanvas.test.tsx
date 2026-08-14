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

  it('uses the shared authored-element visual language in Dual Lens Time items', () => {
    const kinds = [
      'video',
      'text',
      'effect',
      'filter',
      'adjust',
      'overlay',
      'scene3d',
      'audio',
    ] as const;
    const markup = renderToStaticMarkup(
      <TimelineCanvas
        durationUs={10_000_000}
        playheadUs={0}
        viewport={{ originUs: 0, pixelsPerSecond: 20 }}
        onViewportChange={() => undefined}
        autoFit={false}
        tracks={kinds.map((kind, index) => ({
          id: kind,
          label: kind,
          header: { kind, code: String(index + 1), name: kind },
          items: [
            {
              id: `${kind}-item`,
              label: kind,
              startUs: index * 100_000,
              endUs: index * 100_000 + 2_000_000,
              elementKind: kind,
              icon: kind,
            },
          ],
        }))}
        selectedClipIds={new Set(['adjust-item'])}
        onSeek={() => undefined}
        onSelectClips={() => undefined}
      />,
    );

    for (const kind of kinds) expect(markup).toContain(`data-element-kind="${kind}"`);
    expect(markup).toContain('timeline-clip--adjust');
    expect(markup).not.toContain('data-element-kind="sticker"');
  });
});
