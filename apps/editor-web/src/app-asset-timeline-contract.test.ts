import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const timelinePanelSource = readFileSync(new URL('./TimelinePanel.tsx', import.meta.url), 'utf8');

describe('App asset timeline integrity contract', () => {
  it('preserves the imported asset identity and verified bytes metadata', () => {
    const callback = appSource.slice(
      appSource.indexOf('const addAssetToTimeline = (asset:'),
      appSource.indexOf(
        'const bindMediaClip = (',
        appSource.indexOf('const addAssetToTimeline = (asset:'),
      ),
    );
    expect(callback).toContain('readonly sha256: string;');
    expect(callback).toContain('readonly bytes: number;');
    expect(callback).toContain('sha256: asset.sha256,');
    expect(callback).toContain('bytes: asset.bytes,');
    expect(callback).toContain('id: asset.assetId,');
  });

  it('fits a bound media clip against the composition that received it', () => {
    const placementSource = readFileSync(
      new URL('./timeline-media-placement.ts', import.meta.url),
      'utf8',
    );
    const projectSource = readFileSync(new URL('./media-project.ts', import.meta.url), 'utf8');

    // The panel sends the frame of the composition that received the clip with every placement.
    expect(timelinePanelSource).toContain(
      'const frame = { width: composition.width, height: composition.height };',
    );
    expect(timelinePanelSource).toContain(
      'placements.map((placement) => ({ ...placement, frame }))',
    );
    // The placement carries it to the binder, which fits new media to that frame only.
    expect(placementSource).toContain('placement.frame');
    expect(projectSource).toContain('frame?: { readonly width: number; readonly height: number }');
    expect(projectSource).toContain("mode: 'fit'");
  });

  it('uses one drop handler and keeps Media drops off the timeline', () => {
    const handlerStart = appSource.indexOf('const handleDroppedFiles =');
    const handlerEnd = appSource.indexOf("\n    if (api.id === 'timeline')", handlerStart);
    const handler = appSource.slice(handlerStart, handlerEnd);

    expect(handlerStart).toBeGreaterThanOrEqual(0);
    expect(handlerEnd).toBeGreaterThan(handlerStart);
    expect(handler).toContain("target.surface !== 'media' && composition !== undefined");
    expect(handler).toContain('if (!shouldPlace) continue;');
    expect(handler).toContain("target.surface === 'media'");
    expect(appSource.match(/const handleDroppedFiles =/g)).toHaveLength(1);
    expect(appSource).toContain('onImportFiles={handleDroppedFiles}');
    expect(appSource).toContain(
      "onImportFiles={(files) => handleDroppedFiles(files, { surface: 'media' })}",
    );
    expect(appSource).toContain(
      "handleDroppedFiles(files, { surface: 'monitor', timeUs: activeTimelinePlayheadUs })",
    );
    expect(appSource).not.toContain('handleImportDroppedFiles');
  });

  it('uses renderer File imports only without a desktop bridge and reports a desktop miss', () => {
    const handlerStart = appSource.indexOf('const handleDroppedFiles =');
    const handlerEnd = appSource.indexOf("\n    if (api.id === 'timeline')", handlerStart);
    const handler = appSource.slice(handlerStart, handlerEnd);
    const fallbackStart = handler.indexOf('} else if (!isDesktopHost()) {');
    const failureStart = handler.indexOf('} else {', fallbackStart);

    expect(fallbackStart).toBeGreaterThanOrEqual(0);
    expect(failureStart).toBeGreaterThan(fallbackStart);
    expect(handler.slice(fallbackStart, fallbackStart + 180)).toContain(
      'Renderer File imports are a browser-only fallback.',
    );
    expect(handler.slice(fallbackStart, failureStart)).toContain(
      'const asset = await importMediaFile({',
    );
    expect(handler.match(/importMediaFile\(/g)).toHaveLength(1);
    expect(handler.slice(failureStart)).toContain(
      "message: 'Desktop dropped-file import is unavailable.',",
    );
    expect(handler).toContain(
      "context.showToast(`Failed to import ${failure.displayName}: ${failure.message}`, 'error');",
    );
  });
});
