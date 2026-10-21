import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import { TransitionsPanel } from './TransitionsPanel.js';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';

describe('TransitionsPanel junction operations', () => {
  it('renders replaceable transition cards and a target-specific remove action', () => {
    const root = INITIAL_EDITOR_PROJECT.compositions.root!;
    const project = {
      ...INITIAL_EDITOR_PROJECT,
      transitions: [
        {
          id: 'transition-1',
          trackId: 'track-0',
          leftClipId: 'intro',
          rightClipId: 'product',
          type: 'dissolve',
          durationUs: 500_000,
        },
      ],
      compositions: {
        ...INITIAL_EDITOR_PROJECT.compositions,
        root: {
          ...root,
          tracks: [
            {
              id: 'video-1',
              kind: 'video' as const,
              name: 'Video 1',
              order: 0,
              enabled: true,
              locked: false,
              clips: [
                {
                  id: 'left',
                  kind: 'video' as const,
                  assetId: 'left-asset',
                  startUs: 0,
                  durationUs: 1_000_000,
                  sourceInUs: 0,
                },
                {
                  id: 'right',
                  kind: 'video' as const,
                  assetId: 'right-asset',
                  startUs: 1_000_000,
                  durationUs: 1_000_000,
                  sourceInUs: 0,
                },
              ],
            },
          ],
        },
      },
    };
    const markup = renderToStaticMarkup(
      <TransitionsPanel
        project={project}
        timelineProject={buildReferenceSpikeProject()}
        selectedClipIds={['intro', 'product']}
        onAddTransition={() => undefined}
        onRemoveTransition={() => undefined}
        onUpdateTransition={() => undefined}
        showToast={() => undefined}
      />,
    );

    expect(markup).toContain('data-transition-type="dissolve"');
    expect(markup).toContain('aria-label="Remove selected transition"');
    expect(markup).toContain('data-transition-id="transition-1"');
    expect(markup).toContain('transition-card is-active');

    const activeCard = markup.match(/<div\b[^>]*class="transition-card is-active"[^>]*>/)?.[0];
    expect(activeCard).toBeDefined();
    expect(activeCard).not.toContain('role="button"');
    expect(markup).toContain(
      '<button type="button" class="transition-card-select" aria-pressed="true" aria-label="Selected Dissolve transition"',
    );
    expect(markup).toContain('class="icon-button card-fav-btn"');
  });
});
