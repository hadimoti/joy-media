import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appCss = readFileSync(new URL('./app.css', import.meta.url), 'utf8');

/** Declarations of the rule whose selector is exactly `selector`. */
function declarationsOf(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = appCss.match(new RegExp(`(?:^|\\n)${escaped} \\{([\\s\\S]*?)\\n\\}`));
  return match?.[1]?.trim() ?? '';
}

// A CSS-text check: it proves the override exists and beats the fixed height of the Joy Code Settings frame,
// not how it looks (the live look is confirmed with the desktop driver).
describe('Asset Library Storage dialog height', () => {
  const dialog = '.agent-settings-dialog.joy-agent-settings-dialog.asset-library-storage-dialog';

  it('is as tall as its content instead of the fixed height of the Joy Code Settings frame', () => {
    const rule = declarationsOf(dialog);
    expect(rule).toContain('height: auto;');
    expect(rule).toMatch(/max-height: min\(820px, calc\(100vh - 48px\)\);/u);
  });

  it('lets the body shrink and scroll inside the window instead of filling the frame', () => {
    const rule = declarationsOf(
      '.asset-library-storage-dialog.joy-agent-settings-dialog > .agent-settings-body',
    );
    expect(rule).toContain('flex: 0 1 auto;');
    expect(rule).toContain('min-height: 0;');
  });

  it('uses a selector at least as specific as the fixed-height rule it overrides', () => {
    const joyCss = readFileSync(new URL('./JoyAgentSettingsDialog.css', import.meta.url), 'utf8');
    expect(joyCss).toContain('.agent-settings-dialog.joy-agent-settings-dialog {');
    // three classes against two
    expect(dialog.split('.').length - 1).toBeGreaterThan(2);
  });
});
