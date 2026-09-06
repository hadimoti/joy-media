import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentTimelineOverlay, hasRenderableAgentTimelineOverlay } from './AgentTimelineOverlay.js';

describe('AgentTimelineOverlay', () => {
  it('is a non-interactive visual layer with accessible ghost diffs', () => {
    const markup = renderToStaticMarkup(
      <AgentTimelineOverlay
        diffs={[
          {
            kind: 'add',
            clip: { id: 'clip-new', trackId: 'track-v1', startUs: 0, durationUs: 1_000_000 },
          },
        ]}
        viewport={{ originUs: 0, pixelsPerSecond: 20 }}
        tracks={[{ trackId: 'track-v1', topPx: 0, heightPx: 44 }]}
      />,
    );
    expect(markup).toContain('class="agent-timeline-overlay"');
    expect(markup).toContain(
      'class="agent-timeline-ghost agent-timeline-ghost--add is-destination"',
    );
    expect(markup).toContain('data-clip-id="clip-new"');
    expect(markup).toContain('aria-label="Add clip-new"');
    expect(markup).toContain('role="note"');
  });

  it('renders a bounded summary when a proposed track has no canonical lane yet', () => {
    const diffs = [
      {
        kind: 'add' as const,
        clip: { id: 'clip-root', trackId: 'track-root', startUs: 0, durationUs: 1_000_000 },
      },
    ];
    expect(hasRenderableAgentTimelineOverlay(diffs, [])).toBe(true);
    expect(
      hasRenderableAgentTimelineOverlay(diffs, [{ trackId: 'track-root', topPx: 0, heightPx: 44 }]),
    ).toBe(true);
    const markup = renderToStaticMarkup(
      <AgentTimelineOverlay
        diffs={diffs}
        viewport={{ originUs: 0, pixelsPerSecond: 20 }}
        tracks={[]}
      />,
    );
    expect(markup).toContain('class="agent-timeline-diff agent-timeline-diff--add"');
    expect(markup).toContain('aria-label="Agent staged timeline changes"');
    expect(markup).toContain('Add clip-root');
  });
});
