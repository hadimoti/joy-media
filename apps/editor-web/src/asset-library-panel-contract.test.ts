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
    expect(panelSource).not.toContain('<span>Add to timeline</span>');
  });

  it('loads the account and cloud libraries without waiting for project binding readiness', () => {
    const refreshPath = panelSource.slice(
      panelSource.indexOf('const refresh = useCallback'),
      panelSource.indexOf('const importSelectedFile'),
    );
    expect(refreshPath).not.toContain('ensureProject(');
    expect(refreshPath).toContain('client.myAssets();');
    expect(refreshPath).not.toContain('if (!projectScopeReady) return;');
    expect(refreshPath).toContain('client.sharedCloudAssets()');
    expect(refreshPath).toContain('setItems(assets.map((asset) => ({ asset, derivatives: [] })));');
    expect(refreshPath).toContain('void Promise.all(');
  });

  it('reports a real All count alongside media-specific category counts', () => {
    expect(panelSource).toMatch(/entry\.id === 'all'\s*\?\s*sourceItems\.length/);
  });

  it('associates a cross-project catalog asset before adding it to the timeline', () => {
    expect(panelSource).toContain('const catalogAsset = items.find');
    expect(panelSource).toContain(
      'const associated = await client.associateAsset(projectId, catalogAsset.id);',
    );
    expect(panelSource).toContain('Could not add ${asset.displayName} to this project');
  });
});
