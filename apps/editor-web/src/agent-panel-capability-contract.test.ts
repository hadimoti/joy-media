import { readFileSync } from 'node:fs';
import * as ts from 'typescript';
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

  it('requires the terminal catch paths to use the shared Joy Code failure table', () => {
    // Each catch block in the four error paths must pick its failure from the
    // shared table, so that every failure card carries the plain message and
    // its "no edits were applied" disclaimer. The picker is joyCodeKeyForThrown
    // (joy-code-messages.ts, T-J01); it never shows the thrown text itself.

    // 1. direct model run
    const region1Start = panelSource.indexOf(
      'if (intent === undefined && joyAgentEngineClient !== undefined) {',
    );
    const region1End = panelSource.indexOf('if (intent === undefined) {', region1Start + 1);
    expect(region1Start).toBeGreaterThanOrEqual(0);
    expect(region1End).toBeGreaterThan(region1Start);
    const region1 = panelSource.slice(region1Start, region1End);
    expect(region1).toContain('joyCodeKeyForThrown(error)');

    // 2. recipe runner
    const region2Start = panelSource.indexOf('async function runRecipe(');
    const region2End = panelSource.indexOf('function detachLook(', region2Start);
    expect(region2Start).toBeGreaterThanOrEqual(0);
    expect(region2End).toBeGreaterThan(region2Start);
    const region2 = panelSource.slice(region2Start, region2End);
    expect(region2).toContain('joyCodeKeyForThrown(error)');

    // 3. manual Look runner
    const region3Start = panelSource.indexOf('async function runLook(');
    const region3End = panelSource.indexOf(
      'async function bakeLookFromCompositionAudio(',
      region3Start,
    );
    expect(region3Start).toBeGreaterThanOrEqual(0);
    expect(region3End).toBeGreaterThan(region3Start);
    const region3 = panelSource.slice(region3Start, region3End);
    expect(region3).toContain('joyCodeKeyForThrown(error)');

    // 4. JOY-agent Look runner
    const region4Start = panelSource.indexOf('async function runAgentLook(');
    const region4End = panelSource.indexOf('function rejectModelDraft(', region4Start);
    expect(region4Start).toBeGreaterThanOrEqual(0);
    expect(region4End).toBeGreaterThan(region4Start);
    const region4 = panelSource.slice(region4Start, region4End);
    expect(region4).toContain('joyCodeKeyForThrown(error)');

    // Seven table lookups for a thrown error: the four runner catch paths, plus the
    // apply path and the plan path, which also show a failure card, plus the
    // attachment path, whose message is shown in the composer.
    const tableRefs = panelSource.match(/joyCodeKeyForThrown\(error\)/g);
    expect(tableRefs).not.toBeNull();
    expect(tableRefs!.length).toBe(7);

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

  it('shows every failure as the calm card from the table, never the engine or host text', () => {
    // The card replaces the chat line for a failure.
    expect(panelSource).toContain('<JoyCodeFailureCard');
    expect(panelSource).toContain('failureKey: key');
    expect(panelSource).toContain('message.failureKey !== undefined');

    // No failure interpolates the text of a result, a load or an event into the chat.
    expect(panelSource).not.toMatch(/\$\{(?:result|loaded|event)\.message\b/);
    expect(panelSource).not.toMatch(/\$\{failureMessage\}/);
    expect(panelSource).not.toMatch(/\(\$\{(?:result|loaded)\.message\}\)/);
    expect(panelSource).not.toMatch(/\$\{joyCodeMessageFor\w*\(/);

    // The old code paths that picked a message by the raw reason text are gone.
    expect(panelSource).not.toContain('joyCodeMessageForThrown(');
    expect(panelSource).not.toContain('joyCodeMessageForRunError(');
    expect(panelSource).not.toContain('joyCodeMessageForBlockReason(');
    expect(panelSource).not.toContain('joyCodeMessageForLookBlockReason(');

    // Every failure is logged by its code, through one reporter.
    expect(panelSource).toContain('reportJoyCodeFailure(code)');
    expect(panelSource).toContain('joyCodeKeyForRecipeStop(result.reason, result.failureCode)');
    expect(panelSource).toContain('codesFromDiagnostics(result.diagnostics)');
  });

  it('saves the exact request each failure retries, on that failure only', () => {
    // One saved target per failure message; no shared "last request" slot.
    expect(panelSource).not.toContain('retryRequestRef');
    expect(panelSource).not.toContain('retryLastJoyCodeRequest');
    expect(panelSource).toContain('const [retryTargets] = useState(createJoyCodeRetryTargets);');
    expect(panelSource).toContain('if (retry !== undefined) retryTargets.save(id, retry);');
    expect(panelSource).toContain('failureCardProps(message.id, message.failureKey)');

    // Each failure site passes the request it failed with, in its own block.
    const block = (start: string, end: string) => {
      const from = panelSource.indexOf(start);
      expect(from, start).toBeGreaterThanOrEqual(0);
      return panelSource.slice(from, panelSource.indexOf(end, from + start.length));
    };
    const uses = (text: string, name: string) => (text.match(new RegExp(name, 'g')) ?? []).length;

    // Plan: declared once, then used by the builder and approval failures.
    const planBlock = block('  function plan(intent: AgentIntent', '  function submitPrompt(');
    expect(uses(planBlock, 'failedPlan')).toBe(3);
    // Engine prompt: declared once, then used by the run-failed event and the catch.
    const promptBlock = block('  function submitPrompt(', '  async function runRecipe(');
    expect(uses(promptBlock, 'failedPrompt')).toBe(3);
    // Recipe: declared once, then used by the blocked, stale-authority and catch paths.
    const recipeBlock = block('  async function runRecipe(', '  function detachLook(');
    expect(uses(recipeBlock, 'failedRecipe')).toBe(4);
    // Look: declared once, then used by the blocked, stale-authority and catch paths.
    const lookBlock = block('  async function runLook(', '  /**\n   * Decode the active');
    expect(uses(lookBlock, 'failedLook')).toBe(4);
    // Audio bake: declared once, then used by the audio-load and no-operations failures.
    const bakeBlock = block(
      '  async function bakeLookFromCompositionAudio(',
      '  /**\n   * Ask the JOY agent',
    );
    expect(uses(bakeBlock, 'failedBake')).toBe(3);
    // Agent Look: declared once, then used by the failed-result, stale-authority and catch paths.
    const agentLookBlock = block('  async function runAgentLook(', '  function rejectModelDraft(');
    expect(uses(agentLookBlock, 'failedAgentLook')).toBe(4);

    // Apply and execution failures save nothing: Dismiss only, never a replay.
    const applyBlock = block(
      '  function applyModelDraft(',
      '  function isTerminalPreparedChangeError(',
    );
    expect(applyBlock).not.toContain('retry');
  });

  it('shows the table sentence for every failure path, never the engine text', () => {
    expect(panelSource).not.toContain("appendMessage(threadId, 'assistant', built.reason)");
    expect(panelSource).not.toContain('${approval.reason}');
    expect(panelSource).not.toContain('Dry-run errors:');
    expect(panelSource).not.toContain('executionResult.errors.join');
    expect(panelSource).not.toContain('lastRun.executionResult.errors');
    expect(panelSource).not.toContain('errors: [error.message]');
    expect(panelSource).toContain('joyCodeKeyForExecutionErrors(executionResult.errors)');
    expect(panelSource).toContain('joyCodeMessageByKey(lastRun.failureKey).sentence');
    expect(panelSource).toContain('joyCodeKeyForBlockReason(built.reason)');
  });

  it('hides the grey live-status strip while a run has failed', () => {
    expect(panelSource).toContain("liveAgentPhase !== undefined && liveAgentPhase !== 'failed'");
  });

  it('never renders an engine, host or thrown message in JSX, only the table sentence', () => {
    // Parse the panel and look at every JSX expression container, so a `{...}` in a
    // plain object or a block is not counted. A raw reason or message must not be
    // rendered in the chat, the composer or the plan card.
    const sourceFile = ts.createSourceFile(
      'AgentPanel.tsx',
      panelSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    // A raw reference is the property itself, such as `pending.approval.reason`, not a
    // value that a table lookup (`joyCodeMessageByKey(...)`, `joyCodeKey...(...)`) has turned
    // into a sentence first.
    const rawReference = /^(?:[\w$]+\.)*(?:approval\.reason|error\.message|result\.message)$/;
    const jsxExpressions: string[] = [];
    const rawRenders: string[] = [];

    /** The raw references a JSX expression renders, not counting nested JSX or table lookups. */
    const rawReferencesIn = (root: ts.Node): string[] => {
      const found: string[] = [];
      const walk = (node: ts.Node): void => {
        if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
          return;
        if (ts.isCallExpression(node) && /^joyCode\w*$/.test(node.expression.getText(sourceFile)))
          return;
        const text = node.getText(sourceFile);
        if (ts.isPropertyAccessExpression(node) && rawReference.test(text)) {
          found.push(text);
          return;
        }
        ts.forEachChild(node, walk);
      };
      walk(root);
      return found;
    };

    const visit = (node: ts.Node): void => {
      if (ts.isJsxExpression(node) && node.expression !== undefined) {
        jsxExpressions.push(node.expression.getText(sourceFile));
        for (const reference of rawReferencesIn(node.expression)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          rawRenders.push(`AgentPanel.tsx:${line} renders ${reference}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);

    // The scan must actually have seen the panel's JSX, or it proves nothing.
    expect(jsxExpressions.length, 'the scan must see the panel JSX').toBeGreaterThan(100);
    expect(rawRenders, 'no raw reason or message may be rendered in JSX').toEqual([]);
  });
});
