import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AgentTimelineOverlay } from './AgentTimelineOverlay.js';

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
    expect(markup).toContain('class="agent-timeline-ghost agent-timeline-ghost--add is-destination"');
    expect(markup).toContain('data-clip-id="clip-new"');
    expect(markup).toContain('aria-label="Add clip-new"');
    expect(markup).toContain('role="note"');
  });
});
