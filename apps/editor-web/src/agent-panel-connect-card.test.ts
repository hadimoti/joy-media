import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panelSource = readFileSync(new URL('./AgentPanel.tsx', import.meta.url), 'utf8');
const cardSource = readFileSync(
  new URL('./joy-code-connect-model-card.tsx', import.meta.url),
  'utf8',
);

/** The chat block that answers a prompt with no runnable model. */
function chatDisconnectBlock(): string {
  const start = panelSource.indexOf(
    'if (intent === undefined && joyAgentEngineClient !== undefined) {',
  );
  expect(start).toBeGreaterThanOrEqual(0);
  const end = panelSource.indexOf('const entityReferenceSource = {', start);
  expect(end).toBeGreaterThan(start);
  return panelSource.slice(start, end);
}

describe('Joy Code not-connected card wiring', () => {
  it('shows the one calm card on the Edit, Recipes and Looks surfaces', () => {
    expect(panelSource).toContain('ariaLabel="Edit readiness"');
    expect(panelSource).toContain('ariaLabel="Recipes readiness"');
    expect(panelSource).toContain('ariaLabel="Looks readiness"');
    expect(panelSource).toContain('showConnectCard={showConnectCard}');
    // The three hand-written technical banners are replaced by the shared slot.
    expect(panelSource).not.toContain('className="joy-code-disconnected-banner"');
  });

  it('keeps the chat quiet when no model is connected', () => {
    const chat = chatDisconnectBlock();
    expect(chat).toContain('if (connectionStatus === undefined) {');
    // The chat must not repeat what the card already says.
    expect(chat).not.toContain('No fallback provider was selected.');
    expect(chat).not.toContain('to run natural-language JOY edits.');
  });

  it('states an incompatible model in plain words, with no fallback sentence', () => {
    // Four incompatible-model messages (chat, Recipes, Looks, send guard) share this copy.
    expect(panelSource).not.toContain('no fallback provider was selected');
    expect(panelSource).toContain(
      'The configured model is incompatible. Test another model in Agent Settings.',
    );
  });

  it('hides the Recipes Run buttons until a model is connected', () => {
    expect(panelSource).toContain('{isRecipeRunnerReady && (');
    expect(panelSource).not.toContain('!isRecipeRunnerReady ||');
  });

  it('keeps one message and one action for the not-connected state', () => {
    expect(cardSource.match(/Joy Code is optional\. Connect your own AI model/g)).toHaveLength(1);
    expect(cardSource.match(/'Connect a model'/g)).toHaveLength(1);
  });
});
