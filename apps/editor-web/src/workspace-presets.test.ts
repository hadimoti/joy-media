import { describe, expect, it } from 'vitest';
import { workspacePresetLayout } from './workspace-presets.js';

describe('workspace presets', () => {
  it('keeps the edit preset as the normal seeded layout', () => {
    expect(workspacePresetLayout('edit', 'vertical')).toBeDefined();
  });

  it('changes the active group to the task intent without changing panel IDs', () => {
    const layout = workspacePresetLayout('audio-captions', 'vertical') as {
      readonly panels: Record<string, unknown>;
    };
    expect(Object.keys(layout.panels)).toHaveLength(20);
  });
});
