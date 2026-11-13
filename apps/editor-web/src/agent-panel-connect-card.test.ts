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

  it('keeps the Recipes Run buttons visible but disabled until a model is connected', () => {
    // The gate decides disabled, hover text and the connect click (T-J02).
    expect(panelSource).toContain('<RecipeRunControls');
    expect(panelSource).toContain('ready={isRecipeRunnerReady}');
    expect(panelSource).toContain('noModel={capability === undefined}');
    expect(panelSource).not.toContain('{isRecipeRunnerReady && (');
    // A click on the recipe card body opens the connect step, through the shared helper (T-J02 review).
    expect(panelSource).toContain('connectOnCardClick(onOpenSettings)');
  });

  it('adds the "Run recipe" message only from the run start, never before the run', () => {
    // The one append of the message sits inside the start announcer, not in the run body.
    const appends = panelSource.match(/appendMessage\(threadId, 'user', `Run recipe/g) ?? [];
    expect(appends).toHaveLength(1);
    expect(panelSource).toMatch(
      /createRunStartAnnouncer\(\(\) =>\s*appendMessage\(threadId, 'user', `Run recipe/,
    );
    expect(panelSource).toContain('runAnnouncer.observe(checkpoint);');
  });

  it('offers the connect step from the Creative Brief card when no model is connected', () => {
    expect(panelSource).toContain('noModelConnected={capability === undefined}');
  });

  it('keeps one message and one action for the not-connected state', () => {
    expect(cardSource.match(/Joy Code is optional\. Connect your own AI model/g)).toHaveLength(1);
    expect(cardSource.match(/'Connect a model'/g)).toHaveLength(1);
  });
});
