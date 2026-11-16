import assert from 'node:assert/strict';
import test from 'node:test';
import { compareRgbFrames } from '../compare.mjs';
import {
  EXPORT_MATRIX_IDS,
  EXPORT_MATRIX_ROWS,
  inspectPreset,
  parseProcessTreeWorkingSet,
  processTreeWorkingSet,
} from './export-matrix-steps.mjs';

const validProbe = {
  format: { duration: '6.00' },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      avg_frame_rate: '30/1',
      nb_frames: '180',
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
};

test('A10 has nine selectable preset rows, one three-frame compare and one memory row', () => {
  assert.deepEqual(
    EXPORT_MATRIX_IDS,
    Array.from({ length: 11 }, (_, index) => `D-A10-${String(index + 1).padStart(2, '0')}`),
  );
  assert.equal(EXPORT_MATRIX_ROWS.length, 11);
});

test('preset validation checks dimensions, rate, frame count, one-frame duration and audio', () => {
  assert.equal(inspectPreset(validProbe, 'youtube-1080').pass, true);
  const noAudio = { ...validProbe, streams: [validProbe.streams[0]] };
  assert.ok(inspectPreset(noAudio, 'youtube-1080').problems.includes('audio stream missing'));
  const short = { ...validProbe, format: { duration: '5.9' } };
  assert.equal(inspectPreset(short, 'youtube-1080').pass, false);
});

test('RGB compare uses the stated mean absolute per-channel threshold', () => {
  const preview = { width: 2, height: 1, bytes: Buffer.from([10, 10, 10, 10, 10, 10]) };
  const near = { width: 2, height: 1, bytes: Buffer.from([11, 10, 10, 11, 10, 10]) };
  const shifted = { width: 2, height: 1, bytes: Buffer.from([14, 10, 10, 14, 10, 10]) };
  assert.equal(compareRgbFrames(preview, near, 1).status, 'pass');
  assert.equal(compareRgbFrames(preview, shifted, 1).status, 'fail');
});

test('memory sampler reads launched process tree working sets', () => {
  const rows = processTreeWorkingSet(12, {
    run: (_exe, _args) => ({
      status: 0,
      stdout: '[{"ProcessId":12,"WorkingSetSize":1024},{"ProcessId":13,"WorkingSetSize":512}]',
    }),
  });
  assert.deepEqual(rows, [
    { pid: 12, workingSetBytes: 1024 },
    { pid: 13, workingSetBytes: 512 },
  ]);
});

test('memory sample parser accepts a single PowerShell object and validates its fields', () => {
  assert.deepEqual(parseProcessTreeWorkingSet('{"ProcessId":12,"WorkingSetSize":1024}'), [
    { pid: 12, workingSetBytes: 1024 },
  ]);
  assert.deepEqual(parseProcessTreeWorkingSet(''), []);
  assert.throws(
    () => parseProcessTreeWorkingSet('{bad json'),
    /invalid process memory sample JSON/u,
  );
  assert.throws(
    () => parseProcessTreeWorkingSet('{"ProcessId":12,"WorkingSetSize":"unknown"}'),
    /invalid PID or working set/u,
  );
});

test('memory sampler reports spawn and PowerShell failures with useful details', () => {
  assert.throws(
    () =>
      processTreeWorkingSet(12, {
        run: () => ({ error: new Error('spawn failed'), status: null }),
      }),
    /process memory sample failed: spawn failed/u,
  );
  assert.throws(
    () => processTreeWorkingSet(12, { run: () => ({ status: 1, stderr: 'CIM access denied' }) }),
    /process memory sample failed: CIM access denied; exit code 1/u,
  );
});
