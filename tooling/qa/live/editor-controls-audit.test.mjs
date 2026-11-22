import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectorNumericCases } from './inspector-numeric-cases.mjs';
import { timelineControlCases } from './timeline-control-cases.mjs';
import { buildEditorControlsAuditRows } from './editor-controls-audit.mjs';

const descriptors = [
  {
    id: 'tone',
    params: [
      {
        key: 'gain',
        label: 'Gain',
        type: 'number',
        defaultValue: 0,
        min: -1,
        max: 1,
        step: 0.01,
        animatable: true,
      },
      { key: 'enabled', label: 'Enabled', type: 'boolean', defaultValue: true },
    ],
  },
];

function fakeHelpers({ unavailableIds = [], failingIds = [] } = {}) {
  const state = new Map();
  const calls = [];
  const snapshot = async (_page, row) => state.get(row.id) ?? { value: 0 };
  const perform = async (_page, row) => {
    calls.push(row.id);
    if (failingIds.includes(row.id)) throw new Error('fake action failed');
    state.set(row.id, { value: (state.get(row.id)?.value ?? 0) + 1 });
    return { evidence: { observed: true } };
  };
  return {
    calls,
    cdp: { snapshot, perform },
    pointer: { snapshot, perform },
    prerequisite: async (_page, row) =>
      unavailableIds.includes(row.id)
        ? { available: false, reason: 'fixture prerequisite absent' }
        : { available: true },
    assert: async ({ before, after }) => ({
      ok: JSON.stringify(before) !== JSON.stringify(after),
      detail: 'state changed',
    }),
  };
}

test('expands every inventory family into stable independent audit rows', () => {
  const rows = buildEditorControlsAuditRows(fakeHelpers(), descriptors);
  const ids = rows.map((row) => row.id);

  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.length > timelineControlCases.length + inspectorNumericCases.length);
  assert.ok(ids.some((id) => id.startsWith('timeline:')));
  assert.ok(ids.some((id) => id.startsWith('desktop:')));
  assert.ok(ids.some((id) => id.startsWith('inspector:')));
  assert.ok(ids.some((id) => id.startsWith('monitor:')));
  for (const suffix of [
    'space.tap',
    'space.hold',
    'space.repeat',
    'space.focus-ownership',
    'gesture.single-undo',
    'caption.direction-ltr',
    'caption.direction-rtl',
    'caption.reopen',
  ]) {
    assert.ok(ids.includes(`editor:${suffix}`), `missing editor row ${suffix}`);
  }

  const grouped = rows.filter(
    (row) => row.sourceIds?.includes('toolbar.play') || row.sourceIds?.includes('toolbar.pause'),
  );
  assert.ok(grouped.length >= 2);
  assert.equal(new Set(grouped.map((row) => row.id)).size, grouped.length);
});

test('records pre/post state and deterministic evidence paths; unavailable differs from failed', async () => {
  const helpers = fakeHelpers({
    unavailableIds: ['editor:space.tap'],
    failingIds: ['editor:space.hold'],
  });
  const rows = buildEditorControlsAuditRows(helpers, descriptors);
  const tap = rows.find((row) => row.id === 'editor:space.tap');
  const hold = rows.find((row) => row.id === 'editor:space.hold');
  const gesture = rows.find((row) => row.id === 'editor:gesture.single-undo');

  const unavailable = await tap.run({});
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.rerunnable, true);
  assert.match(unavailable.reason, /fixture prerequisite absent/u);

  const failed = await hold.run({});
  assert.equal(failed.status, 'failed');
  assert.match(failed.reason, /fake action failed/u);

  const firstPath = gesture.expectedEvidencePath;
  const secondPath = buildEditorControlsAuditRows(fakeHelpers(), descriptors).find(
    (row) => row.id === gesture.id,
  ).expectedEvidencePath;
  assert.equal(firstPath, secondPath);
  assert.ok(firstPath.endsWith(`${gesture.evidenceKey}.png`));
  assert.equal(typeof gesture.run, 'function');
});

test('validates effect descriptors per parameter and models keyed and unkeyed number behavior', () => {
  const malformed = [
    {
      id: 'tone',
      params: [
        {
          key: 'gain',
          label: 'Gain',
          type: 'number',
          defaultValue: 0,
          min: -1,
          max: 1,
          step: 0.01,
          animatable: true,
        },
        {
          key: 'broken',
          label: 'Broken',
          type: 'number',
          defaultValue: 0,
          min: 2,
          max: 1,
          step: 0,
        },
      ],
    },
  ];
  const rows = buildEditorControlsAuditRows(fakeHelpers(), malformed);
  const valid = rows.find((row) => row.id === 'descriptor:tone/gain:keyed-value');
  const invalid = rows.find((row) => row.id === 'descriptor:tone/broken:validation');
  const unkeyed = rows.find((row) => row.id === 'descriptor:tone/gain:uncued-value');

  assert.ok(valid, 'numeric parameter gets a keyframe-aware row');
  assert.ok(unkeyed, 'numeric parameter gets an unkeyed row');
  assert.ok(invalid, 'each malformed numeric parameter gets its own validation row');
  assert.equal(valid.parameter.key, 'gain');
  assert.equal(invalid.parameter.key, 'broken');
  assert.equal(invalid.status, 'failed');
  assert.match(invalid.reason, /min.*max|step/u);
});

test('keeps duplicate descriptor parameters as unique per-parameter failures', () => {
  const duplicate = [
    {
      id: 'tone',
      params: [
        {
          key: 'gain',
          label: 'Gain',
          type: 'number',
          defaultValue: 0,
          min: -1,
          max: 1,
          step: 0.01,
        },
        {
          key: 'gain',
          label: 'Gain again',
          type: 'number',
          defaultValue: 0,
          min: -1,
          max: 1,
          step: 0.01,
        },
      ],
    },
  ];
  const rows = buildEditorControlsAuditRows(fakeHelpers(), duplicate).filter((row) =>
    row.id.startsWith('descriptor:tone/gain'),
  );

  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  assert.equal(rows.find((row) => row.id.endsWith('~2:validation'))?.status, 'failed');
});

test('runs an available row through only its injected family driver and requires an assertion', async () => {
  const helpers = fakeHelpers();
  const rows = buildEditorControlsAuditRows(helpers, descriptors);
  const row = rows.find((entry) => entry.id === 'editor:space.tap');
  const result = await row.run({});

  assert.equal(result.status, 'passed');
  assert.deepEqual(helpers.calls, [row.id]);
  assert.deepEqual(result.pre, { value: 0 });
  assert.deepEqual(result.post, { value: 1 });
  assert.equal(result.expectedEvidencePath, row.expectedEvidencePath);
  assert.equal(result.evidence.observed, true);
});
