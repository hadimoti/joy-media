import { describe, expect, it } from 'vitest';
import { INITIAL_EDITOR_PROJECT } from './editor-project.js';
import {
  CAPTION_BURN_IN_KEY,
  readCaptionBurnIn,
  withCaptionBurnIn,
  withCaptionBurnInNodes,
} from './caption-burn-in.js';
import type { RenderFrameIR } from '@joy-media/render-ir';

describe('caption burn-in', () => {
  it('persists burn-in preference in pluginData', () => {
    expect(readCaptionBurnIn(INITIAL_EDITOR_PROJECT)).toBe(false);
    const enabled = withCaptionBurnIn(INITIAL_EDITOR_PROJECT, true);
    expect(enabled.pluginData[CAPTION_BURN_IN_KEY]).toBe(true);
    expect(readCaptionBurnIn(enabled)).toBe(true);
  });

  it('appends caption nodes only when burn-in is enabled', () => {
    const base: RenderFrameIR = {
      version: 1,
      compositionId: 'root',
      timeUs: 2_100_000,
      viewport: { width: 1080, height: 1920, dpr: 1 },
      background: { r: 0, g: 0, b: 0, a: 255 },
      nodes: [],
    };
    const off = withCaptionBurnInNodes(base, INITIAL_EDITOR_PROJECT);
    expect(off.nodes).toHaveLength(0);

    const on = withCaptionBurnInNodes(base, withCaptionBurnIn(INITIAL_EDITOR_PROJECT, true));
    expect(on.nodes.length).toBeGreaterThan(0);
    expect(on.nodes.every((node) => node.kind === 'text')).toBe(true);
  });
});
