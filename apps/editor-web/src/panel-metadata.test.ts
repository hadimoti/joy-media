import { describe, expect, it } from 'vitest';
import { PANEL_IDS } from './workspace.js';
import {
  PANEL_INTENT_LABELS,
  PANEL_INTENT_ORDER,
  PANEL_METADATA,
  PANEL_METADATA_BY_ID,
  panelsForIntent,
} from './panel-metadata.js';

describe('panel metadata registry', () => {
  it('covers every durable panel exactly once', () => {
    expect(PANEL_METADATA).toHaveLength(PANEL_IDS.length);
    expect(new Set(PANEL_METADATA.map((entry) => entry.id)).size).toBe(PANEL_IDS.length);
    expect(PANEL_IDS.every((id) => PANEL_METADATA_BY_ID[id].label.length > 0)).toBe(true);
  });

  it('keeps the product taxonomy discoverable by intent', () => {
    expect(PANEL_INTENT_ORDER.map((intent) => PANEL_INTENT_LABELS[intent])).toEqual([
      'Media',
      'Edit',
      'Enhance',
      'Automation',
      'System',
    ]);
    expect(panelsForIntent('media').map((entry) => entry.label)).toEqual([
      'Assets',
      'Captions',
      'Text',
      'Audio',
      'Library',
    ]);
    expect(panelsForIntent('automation').map((entry) => entry.label)).toEqual([
      'Joy Code',
      'Workflows',
      'Jobs',
    ]);
  });
});
