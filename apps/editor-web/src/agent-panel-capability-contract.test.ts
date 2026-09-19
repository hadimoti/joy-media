import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panelSource = readFileSync(new URL('./AgentPanel.tsx', import.meta.url), 'utf8');
const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

describe('Joy Code capability panel contract', () => {
  it('removes the Edit message stream from the Creative Brief and Recipes views', () => {
    const messagesStart = panelSource.indexOf('className={`joy-code-messages');
    const messagesOpeningTag = panelSource.slice(
      messagesStart,
      panelSource.indexOf('>', messagesStart),
    );

    expect(messagesStart).toBeGreaterThanOrEqual(0);
    expect(messagesOpeningTag).toContain(
      "hidden={composerCapability === 'creative-brief' || composerCapability === 'recipes'}",
    );
    expect(appCss).toContain('.joy-code-messages[hidden]');
  });

  it('returns to Edit before a recipe can request consent or approval', () => {
    const recipeStart = panelSource.indexOf('async function runRecipe');
    const recipeBlock = panelSource.slice(
      recipeStart,
      panelSource.indexOf('function detachLook', recipeStart),
    );
    const availabilityCheck = recipeBlock.indexOf(
      'if (entry === undefined || !entry.available) return;',
    );
    const switchToEdit = recipeBlock.indexOf("setComposerCapability('edit');");
    const launch = recipeBlock.indexOf('await runEditorCreativeSkill');

    expect(recipeStart).toBeGreaterThanOrEqual(0);
    expect(switchToEdit).toBeGreaterThan(availabilityCheck);
    expect(switchToEdit).toBeLessThan(launch);
  });

  it('declares onOpenSettings prop and renders Configure OpenRouter / Joy Agent trigger', () => {
    expect(panelSource).toContain('readonly onOpenSettings?: () => void;');
    expect(panelSource).toContain('Configure OpenRouter / Joy Agent');
    expect(panelSource).toContain('isDisconnected && onOpenSettings !== undefined');
  });
});
