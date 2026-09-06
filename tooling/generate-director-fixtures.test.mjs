import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  floorPresentationPtsUs,
  presentationTimestampEvidence,
} from './generate-director-fixtures.mjs';

test('floors raw PTS ticks through the stream time base without decimal rounding', () => {
  // 1,024 / 15,360 seconds is 66,666.666... microseconds. The browser
  // normalizes to an integer microsecond floor, unlike Math.round().
  assert.equal(floorPresentationPtsUs(1024, '1/15360'), 66_666);
  assert.equal(floorPresentationPtsUs(512, '1/15360'), 33_333);
  assert.equal(floorPresentationPtsUs(-1, '1/3'), -333_334);
});

test('preserves ffprobe best-effort timestamp ticks beside compatible microseconds', () => {
  assert.deepEqual(
    presentationTimestampEvidence(
      [
        { best_effort_timestamp: 0 },
        { best_effort_timestamp: 512 },
        { best_effort_timestamp: 1024 },
      ],
      '1/15360',
    ),
    {
      presentationPtsTicks: [0, 512, 1024],
      actualPresentationPtsUs: [0, 33_333, 66_666],
    },
  );
});

test('the checked-in fixture manifest retains raw ticks with exact floor-normalized microseconds', () => {
  const manifest = JSON.parse(
    readFileSync(
      join(process.cwd(), 'tooling/fixtures/joy-director-fixture-manifest.json'),
      'utf8',
    ),
  );
  assert.equal(manifest.version, 2);
  for (const fixture of manifest.fixtures) {
    if (fixture.video === undefined) continue;
    assert.equal(fixture.video.presentationPtsTicks.length, fixture.video.frameCount);
    assert.deepEqual(
      fixture.video.actualPresentationPtsUs,
      fixture.video.presentationPtsTicks.map((ticks) =>
        floorPresentationPtsUs(ticks, fixture.video.timeBase),
      ),
    );
  }
  const cfr = manifest.fixtures.find((fixture) => fixture.name === 'cfr-numbered.mp4');
  assert.deepEqual(cfr.video.presentationPtsTicks.slice(0, 3), [0, 512, 1024]);
  assert.deepEqual(cfr.video.actualPresentationPtsUs.slice(0, 3), [0, 33_333, 66_666]);
});
