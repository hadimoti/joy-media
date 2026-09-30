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

  it('uses one accessible Settings trigger for provider and JOY Agent configuration', () => {
    expect(panelSource).toContain('readonly onOpenSettings?: () => void;');
    expect(panelSource).toContain('className="joy-code-settings-trigger-btn"');
    expect(panelSource).toContain('aria-label="Joy Code Settings"');
    expect(panelSource).not.toContain('Configure OpenRouter / Joy Agent');
    expect(panelSource).not.toContain('Select AI Model');
    expect(appCss).toContain('.joy-code-settings-trigger-btn:focus-visible');
  });

  it('requires all four terminal catch paths to use noEditsAppliedFailureMessage', () => {
    // Each catch block in the four error paths must invoke the shared
    // formatter so that every failure notice appends the "no edits were
    // applied" disclaimer.

    // 1. direct model run
    const region1Start = panelSource.indexOf(
      'if (intent === undefined && joyAgentEngineClient !== undefined) {',
    );
    const region1End = panelSource.indexOf('if (intent === undefined) {', region1Start + 1);
    expect(region1Start).toBeGreaterThanOrEqual(0);
    expect(region1End).toBeGreaterThan(region1Start);
    const region1 = panelSource.slice(region1Start, region1End);
    expect(region1).toContain('noEditsAppliedFailureMessage(error,');

    // 2. recipe runner
    const region2Start = panelSource.indexOf('async function runRecipe(');
    const region2End = panelSource.indexOf('function detachLook(', region2Start);
    expect(region2Start).toBeGreaterThanOrEqual(0);
    expect(region2End).toBeGreaterThan(region2Start);
    const region2 = panelSource.slice(region2Start, region2End);
    expect(region2).toContain('noEditsAppliedFailureMessage(error,');

    // 3. manual Look runner
    const region3Start = panelSource.indexOf('async function runLook(');
    const region3End = panelSource.indexOf(
      'async function bakeLookFromCompositionAudio(',
      region3Start,
    );
    expect(region3Start).toBeGreaterThanOrEqual(0);
    expect(region3End).toBeGreaterThan(region3Start);
    const region3 = panelSource.slice(region3Start, region3End);
    expect(region3).toContain('noEditsAppliedFailureMessage(error,');

    // 4. JOY-agent Look runner
    const region4Start = panelSource.indexOf('async function runAgentLook(');
    const region4End = panelSource.indexOf('function rejectModelDraft(', region4Start);
    expect(region4Start).toBeGreaterThanOrEqual(0);
    expect(region4End).toBeGreaterThan(region4Start);
    const region4 = panelSource.slice(region4Start, region4End);
    expect(region4).toContain('noEditsAppliedFailureMessage(error,');

    // Exactly four formatter references across the whole file.
    const formatterRefs = panelSource.match(/noEditsAppliedFailureMessage\(error\s*,/g);
    expect(formatterRefs).not.toBeNull();
    expect(formatterRefs!.length).toBe(4);

    // None of the old inline Error/fallback expressions should remain.
    expect(panelSource).not.toMatch(
      /error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*'JOY run failed safely\.'/,
    );
    expect(panelSource).not.toMatch(
      /error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*'The recipe run failed safely\.'/,
    );
    expect(panelSource).not.toMatch(
      /error\s+instanceof\s+Error\s*\?\s*error\.message\s*:\s*'The Look run failed safely\.'/,
    );
  });
});
