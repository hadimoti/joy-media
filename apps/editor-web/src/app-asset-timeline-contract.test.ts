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

  it('places dropped files only when they came from the timeline', () => {
    const handlerStart = appSource.indexOf('const handleImportDroppedFiles =');
    const handlerEnd = appSource.indexOf('const activeTimelineDurationUs', handlerStart);
    const handler = appSource.slice(handlerStart, handlerEnd);

    expect(handler).toContain("dropMode === 'timeline'");
    expect(appSource).toContain(
      "onImportFiles={(files) => handleImportDroppedFiles(files, 'timeline')}",
    );
    expect(appSource).toContain(
      "onImportFiles={(files) => handleImportDroppedFiles(files, 'media')}",
    );
  });
});
