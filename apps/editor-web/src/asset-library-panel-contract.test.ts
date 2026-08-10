import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const panelSource = readFileSync(new URL('./AssetLibraryPanel.tsx', import.meta.url), 'utf8');

describe('AssetLibraryPanel successful import contract', () => {
  it('includes ownership, applies the reveal state, and retains refresh reconciliation', () => {
    const successPath = panelSource.slice(
      panelSource.indexOf('const imported = await importMediaFile'),
      panelSource.indexOf('const fetchCloudOriginal'),
    );

    expect(successPath).toContain('setItems((current) => includeOwnedAsset');
    expect(successPath).toContain('setOwnedAssetIds((current) => includeOwnedAsset');
    expect(successPath).toContain('const reveal = importedAssetRevealState(imported);');
    expect(successPath).toContain('setAssetSource(reveal.assetSource);');
    expect(successPath).toContain('setCategory(reveal.category);');
    expect(successPath).toContain('setCollection(reveal.collection);');
    expect(successPath).toContain('setQuery(reveal.query);');
    expect(successPath).toContain('setAvailability(reveal.availability);');
    expect(successPath).toContain('setSort(reveal.sort);');
    expect(successPath).toContain('setRenderLimit(reveal.renderLimit);');
    expect(successPath).toContain('await refresh();');
  });

  it('renders an add-to-timeline action for every rendered asset', () => {
    expect(panelSource).toContain('rendered.map(({ asset, derivatives }) =>');
    expect(panelSource).toContain('aria-label={`Add ${asset.displayName} to timeline`}');
  });
});
