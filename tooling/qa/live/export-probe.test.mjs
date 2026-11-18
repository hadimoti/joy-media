import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkExportProbe,
  EXPORT_SECONDS,
  ffprobeJson,
  trimTimelineToSeconds,
} from './export-probe.mjs';

const validProbe = {
  format: { duration: '2.00' },
  streams: [
    { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
};

test('the media rows require a 2-second H.264 video export', () => {
  assert.equal(EXPORT_SECONDS, 2);
  assert.match(checkExportProbe(validProbe), /h264 1920x1080, 2\.00 s/u);
});

test('ffprobe validation rejects an export outside the two-second window', () => {
  assert.throws(
    () => checkExportProbe({ ...validProbe, format: { duration: '4.0' } }),
    /expected 2 s/u,
  );
});

test('ffprobe validation checks requested audio presence', () => {
  assert.throws(
    () => checkExportProbe({ ...validProbe, streams: [validProbe.streams[0]] }, { audio: true }),
    /no audio stream/u,
  );
});

test('ffprobe command errors include the failing tool result', () => {
  assert.throws(
    () => ffprobeJson('export.mp4', { run: () => ({ status: 1, stderr: 'bad media' }) }),
    /ffprobe failed on export\.mp4: bad media/u,
  );
});

test('the cut refuses to delete anything when the playhead did not move', async () => {
  const deleted = [];
  const page = {
    keyboard: { press: async () => undefined },
    evaluate: async () => ({
      clips: [{ id: 'clip-a', left: 100, right: 400 }],
      playheadX: 100,
    }),
    waitForTimeout: async () => undefined,
    getByLabel: () => ({
      first: () => ({ fill: async () => undefined, press: async () => undefined }),
    }),
    locator: () => {
      deleted.push('locator');
      throw new Error('a clip was touched');
    },
  };
  await assert.rejects(() => trimTimelineToSeconds(page, 2, 'D-X'), /playhead did not move/u);
  assert.deepEqual(deleted, []);
});
