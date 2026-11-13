import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const appSource = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

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
});
