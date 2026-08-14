import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TimelineTransitionJunction } from './TimelineTransitionJunction.js';

describe('TimelineTransitionJunction', () => {
  it('renders a transition as a cut junction with durable identity', () => {
    const html = renderToStaticMarkup(
      <TimelineTransitionJunction
        transition={{
          id: 'transition-1',
          trackId: 'Video 1',
          leftClipId: 'a',
          rightClipId: 'b',
          type: 'dissolve',
          durationUs: 500_000,
        }}
        boundaryUs={6_000_000}
        viewport={{ originUs: 0, pixelsPerSecond: 100 }}
        onSeek={() => undefined}
      />,
    );
    expect(html).toContain('data-transition-id="transition-1"');
    expect(html).toContain('Dissolve');
    expect(html).toContain('left:575px');
  });
});
