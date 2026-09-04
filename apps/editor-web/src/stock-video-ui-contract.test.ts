import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STOCK_VIDEO_CATEGORY_ICONS } from './asset-library-icons.js';

const STOCK_CATEGORY_IDS = [
  'business-work',
  'technology',
  'people-lifestyle',
  'nature',
  'travel-places',
  'city-transport',
  'food-drink',
  'abstract-backgrounds',
] as const;

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
const iconSource = readFileSync(
  fileURLToPath(new URL('./asset-library-icons.ts', import.meta.url)),
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
    expect(panelSource).toContain('stockVideoCategory');
    expect(panelSource).toContain('stockVideoCategoryCounts');
    expect(panelSource).toContain('stock-video-category-rail');
    expect(discoverySource).not.toContain('stock-video-categories');
    expect(discoverySource).not.toContain('setCategory');
    expect(iconSource).toContain('STOCK_VIDEO_CATEGORY_ICONS');
    for (const asset of [
      "iconUrl('ui/charts.png')",
      "iconUrl('asset/24_UI.png')",
      "iconUrl('24_socials.png')",
      "iconUrl('24_scenes.png')",
      "iconUrl('camera.png')",
      "iconUrl('asset/24_arrows.png')",
      "iconUrl('asset/24_creative.png')",
      "iconUrl('asset/24_patterns.png')",
    ])
      expect(iconSource).toContain(asset);
  });

  it('maps exactly eight stable categories to distinct bundled local masks', () => {
    expect(Object.keys(STOCK_VIDEO_CATEGORY_ICONS).sort()).toEqual([...STOCK_CATEGORY_IDS].sort());
    expect(new Set(Object.values(STOCK_VIDEO_CATEGORY_ICONS)).size).toBe(STOCK_CATEGORY_IDS.length);
    for (const icon of Object.values(STOCK_VIDEO_CATEGORY_ICONS))
      expect(icon).not.toMatch(/^https?:/);
  });

  it('contains explicit attribution and import states, never a pre-import timeline action', () => {
    expect(panelSource).toMatch(/source|creator/i);
    expect(panelSource).toMatch(/Import to My media|import.*media/i);
    expect(panelSource).toMatch(/loading|importing|failed|retry/i);
    expect(panelSource).not.toMatch(/stock.*add.*timeline|add.*timeline.*stock/i);
  });

  it('passes the shared asset view mode into the native stock grid', () => {
    expect(panelSource).toContain('viewMode={viewMode}');
    expect(discoverySource).toContain('stock-video-grid--${viewMode}');
    expect(discoverySource).toContain('type { AssetViewMode }');
    expect(discoverySource).toContain('role="tabpanel"');
    expect(discoverySource).toContain('aria-modal="true"');
    expect(discoverySource).toContain('previewRequestSequence');
    expect(discoverySource).toContain('stock-video-card-actions');
    expect(discoverySource).toContain('onCategoryCountsChange');
  });
});
