import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PANEL_IDS } from './workspace.js';
import {
  PANEL_LABELS,
  PANEL_TAB_ICONS,
  panelLabel,
  panelTabIconUrl,
  panelTabSvgIcon,
} from './panel-tab-icons.js';

describe('dock panel tab icons', () => {
  it('gives each durable panel either a shared mask or inline SVG icon', () => {
    for (const panelId of PANEL_IDS) {
      expect(
        panelTabIconUrl(panelId) ?? panelTabSvgIcon(panelId),
        `${panelId} (${panelLabel(panelId)}) should not render the text fallback`,
      ).toBeTruthy();
    }
  });

  it('gives the 3D tab its own cube icon, not the Animate glyph (OB-01a)', () => {
    expect(panelTabIconUrl('scene3d')).toBeTruthy();
    expect(panelTabIconUrl('scene3d')).not.toBe(panelTabIconUrl('motion'));

    const cube = readFileSync(new URL('./panel-icons/ui/cube-3d_24x24.png', import.meta.url));
    const animate = readFileSync(new URL('./panel-icons/ui/motion_24x24.png', import.meta.url));
    expect(cube.equals(animate)).toBe(false);
    expect(PANEL_TAB_ICONS.scene3d).toBe(panelTabIconUrl('scene3d'));
    // The old 3D glyph was public/assets/24_3d.png, byte-identical to Animate.
    expect(panelTabIconUrl('scene3d')).not.toContain('24_3d');
  });

  it('gives every panel a non-empty name that also serves as its tooltip (OB-01b, OB-16c)', () => {
    for (const panelId of PANEL_IDS) {
      const label = PANEL_LABELS[panelId];
      expect(label.trim().length, `${panelId} needs a name`).toBeGreaterThan(0);
      expect(panelLabel(panelId)).toBe(label);
    }
  });
});
