import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

// The guard reads only `active` from the presence hook, so the hook is replaced with a fixed value
// and the rendered markup is checked for both states.
let runActive = false;
vi.mock('./agent-presence.js', () => ({
  useAgentPanelPresence: () => ({ active: runActive }),
}));

const { JoyCodeCloseButton } = await import('./JoyCodeCloseButton.js');

function render(): string {
  const api = { id: 'agent', close: () => undefined };
  return renderToStaticMarkup(<JoyCodeCloseButton api={api as never} />);
}

describe('JoyCodeCloseButton', () => {
  it('is enabled when no agent run is active, so the panel can be closed', () => {
    runActive = false;
    const markup = render();
    expect(markup).toContain('aria-label="Close Joy Code panel"');
    expect(markup).not.toContain('disabled');
    expect(markup).toContain('title="Close Joy Code"');
  });

  it('is disabled while an agent run is active, so a run is never closed silently', () => {
    runActive = true;
    const markup = render();
    expect(markup).toContain('disabled=""');
    expect(markup).toContain('title="Stop Joy Code before closing it"');
  });
});
