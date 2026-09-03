import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const panelSource = readFileSync(
  fileURLToPath(new URL('./AssetLibraryPanel.tsx', import.meta.url)),
  'utf8',
);
const discoverySource = readFileSync(
  fileURLToPath(new URL('./StockVideoDiscovery.tsx', import.meta.url)),
  'utf8',
);
const clientSource = readFileSync(
  fileURLToPath(new URL('./control-plane-client.ts', import.meta.url)),
  'utf8',
);

describe('stock-video asset-library UI contract', () => {
  it('keeps stock cards separate from BrowserAsset and preserves all stable categories', () => {
    expect(panelSource).toContain('BrowserStockVideo');
    for (const slug of [
      'business-work',
      'technology',
      'people-lifestyle',
      'nature',
      'travel-places',
      'city-transport',
      'food-drink',
      'abstract-backgrounds',
    ])
      expect(clientSource).toContain(slug);
    expect(discoverySource).toContain('STOCK_VIDEO_CATEGORIES');
  });

  it('contains explicit attribution and import states, never a pre-import timeline action', () => {
    expect(panelSource).toMatch(/source|creator/i);
    expect(panelSource).toMatch(/Import to My media|import.*media/i);
    expect(panelSource).toMatch(/loading|importing|failed|retry/i);
    expect(panelSource).not.toMatch(/stock.*add.*timeline|add.*timeline.*stock/i);
  });
});
