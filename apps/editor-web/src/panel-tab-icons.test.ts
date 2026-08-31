import { describe, expect, it } from 'vitest';
import { PANEL_IDS } from './workspace.js';
import {
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
});
