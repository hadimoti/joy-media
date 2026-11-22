import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ADJUST_LAYER_DESCRIPTORS,
  INSPECTOR_NUMERIC_SECTIONS,
  NUMERIC_ACTION_CHECKLIST,
  actionsFor,
  expandEffectNumberCases,
  inspectorNumericCases,
} from './inspector-numeric-cases.mjs';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

function readRepoFile(relativePath) {
  return readFileSync(join(REPO_ROOT, relativePath), 'utf8');
}

/** Parses one built-in effect descriptor's params out of registerBuiltins.ts source text. */
function parseBuiltinParams(source, descriptorId) {
  const start = source.indexOf(`id: '${descriptorId}'`);
  assert.notEqual(start, -1, `descriptor ${descriptorId} is in registerBuiltins.ts`);
  const end = source.indexOf('tags:', start);
  const block = source.slice(start, end);
  const params = [];
  for (const match of block.matchAll(/\{\n\s+key: '([^']+)',([\s\S]*?)\n\s+\}/g)) {
    const fields = { key: match[1] };
    for (const line of match[2].matchAll(/^\s+(\w+): (.+?),?$/gm)) {
      const raw = line[2];
      if (raw.startsWith("'")) fields[line[1]] = raw.slice(1, -1);
      else if (raw === 'true' || raw === 'false') fields[line[1]] = raw === 'true';
      else fields[line[1]] = Number(raw);
    }
    params.push(fields);
  }
  return params;
}

const byKey = new Map(inspectorNumericCases.map((entry) => [entry.key, entry]));

test('every case has a unique section and control key', () => {
  const keys = inspectorNumericCases.map((entry) => entry.key);
  assert.equal(new Set(keys).size, keys.length, 'section/control keys are unique');
  for (const entry of inspectorNumericCases) {
    assert.equal(entry.key, `${entry.section}/${entry.control}`);
    assert.ok(INSPECTOR_NUMERIC_SECTIONS.includes(entry.section), `known section ${entry.section}`);
  }
});

test('the inventory holds the requested fields per section', () => {
  const counts = {};
  for (const entry of inspectorNumericCases) {
    counts[entry.section] = (counts[entry.section] ?? 0) + 1;
  }
  assert.deepEqual(counts, { Transform: 6, Adjust: 5, Crop: 4, Audio: 2, Speed: 3, Mask: 6 });
  assert.equal(inspectorNumericCases.length, 26);
  assert.deepEqual(
    inspectorNumericCases.filter((entry) => entry.section === 'Transform').map((entry) => entry.label),
    ['Position X', 'Position Y', 'Scale X', 'Scale Y', 'Rotation', 'Opacity'],
  );
});

test('explicit input ids are unique and the case list is frozen', () => {
  const ids = inspectorNumericCases
    .map((entry) => entry.input.id)
    .filter((id) => id !== null);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(Object.isFrozen(inspectorNumericCases));
  for (const entry of inspectorNumericCases) assert.ok(Object.isFrozen(entry));
});

test('expandEffectNumberCases emits one case per numeric param of every descriptor', () => {
  const descriptors = [
    {
      id: 'alpha',
      params: [
        {
          key: 'a',
          label: 'A',
          type: 'number',
          defaultValue: 2,
          min: 0,
          max: 10,
          step: 0.5,
          unit: 'px',
          animatable: true,
        },
        { key: 'flag', label: 'Flag', type: 'boolean', defaultValue: true },
        { key: 'pos', label: 'Pos', type: 'vector2', defaultValue: { x: 0, y: 0 } },
        {
          key: 'b',
          label: 'B',
          type: 'number',
          defaultValue: -1,
          min: -5,
          max: 5,
          step: 1,
        },
      ],
    },
    { id: 'beta', params: [{ key: 'flag', label: 'Flag', type: 'boolean', defaultValue: false }] },
    { id: 'gamma' },
  ];
  const before = JSON.stringify(descriptors);
  const cases = expandEffectNumberCases(descriptors);
  assert.equal(JSON.stringify(descriptors), before, 'input descriptors are not mutated');
  assert.deepEqual(
    cases.map((entry) => entry.key),
    ['Adjust/alpha.a', 'Adjust/alpha.b'],
  );
  const [a, b] = cases;
  assert.equal(a.section, 'Adjust');
  assert.equal(a.label, 'A');
  assert.equal(a.min, 0);
  assert.equal(a.max, 10);
  assert.equal(a.step, 0.5);
  assert.equal(a.defaultValue, 2);
  assert.equal(a.unit, 'px');
  assert.equal(a.animatable, true);
  assert.equal(a.input.ariaLabel, 'A value');
  assert.equal(b.animatable, false, 'a missing animatable flag is not animatable');
  assert.equal(b.min, -5);
  assert.equal(b.max, 5);
  assert.equal(b.step, 1);
  assert.equal(b.defaultValue, -1);
  assert.equal(b.unit, '');
});

test('expandEffectNumberCases takes a section override and an empty list yields nothing', () => {
  const cases = expandEffectNumberCases(
    [{ id: 'solo', params: [{ key: 'k', label: 'K', type: 'number', defaultValue: 0 }] }],
    { section: 'Effects' },
  );
  assert.equal(cases[0].key, 'Effects/solo.k');
  assert.equal(cases[0].min, null);
  assert.equal(cases[0].max, null);
  assert.equal(cases[0].step, null);
  assert.deepEqual(expandEffectNumberCases([]), []);
});

test('the Adjust cases are the expansion of the five Adjust-layer params', () => {
  const adjust = inspectorNumericCases.filter((entry) => entry.section === 'Adjust');
  assert.deepEqual(
    adjust.map((entry) => entry.control),
    [
      'brightness-contrast.brightness',
      'brightness-contrast.contrast',
      'hue-saturation.hue',
      'hue-saturation.saturation',
      'vibrance.amount',
    ],
  );
  assert.deepEqual(adjust, expandEffectNumberCases(ADJUST_LAYER_DESCRIPTORS));
});

test('the Adjust descriptor copy matches the built-in effect source', () => {
  const source = readRepoFile('packages/visual-effects/src/builtin/registerBuiltins.ts');
  for (const descriptor of ADJUST_LAYER_DESCRIPTORS) {
    const sourceParams = parseBuiltinParams(source, descriptor.id);
    const withUnit = (param) => ({ unit: '', ...param });
    assert.deepEqual(
      descriptor.params.map(withUnit),
      sourceParams.map(withUnit),
      `${descriptor.id} params match registerBuiltins.ts`,
    );
  }
});

test('min, max, step and default values are carried through to the cases', () => {
  const expectations = {
    'Transform/scaleX': { min: 0.001, max: null, step: 1, defaultValue: 1 },
    'Transform/opacity': { min: 0, max: 100, step: 1, defaultValue: 100, unit: '%' },
    'Adjust/brightness-contrast.brightness': { min: -1, max: 1, step: 0.01, defaultValue: 0 },
    'Adjust/hue-saturation.hue': { min: -1, max: 1, step: 0.01, defaultValue: 0, unit: 'turn' },
    'Crop/right': { min: 0, max: 0.49, step: 0.01, defaultValue: 0 },
    'Audio/volume': { min: 0, max: 2, step: 0.01, defaultValue: 1 },
    'Audio/pan': { min: -1, max: 1, step: 0.01, defaultValue: 0 },
    'Speed/rate': { min: 0.1, max: 8, step: 0.05, defaultValue: 1, reverseMin: -8 },
    'Speed/remap-start': { min: 0, max: null, step: 1, defaultValue: null },
    'Mask/box.width': { min: 0, max: 1, step: 0.01, defaultValue: 0.6 },
    'Mask/points.x': { min: 0, max: 1, step: 0.01, defaultValue: 0.5 },
  };
  for (const [key, expected] of Object.entries(expectations)) {
    const entry = byKey.get(key);
    assert.ok(entry, `case ${key} exists`);
    for (const [field, value] of Object.entries(expected)) {
      assert.deepEqual(entry[field], value, `${key}.${field}`);
    }
  }
  assert.deepEqual(byKey.get('Transform/opacity').stored, {
    min: 0,
    max: 1,
    defaultValue: 1,
    displayScale: 100,
  });
});

test('no case is a non-numeric control', () => {
  for (const entry of inspectorNumericCases) {
    assert.equal(entry.type, 'number', `${entry.key} is a number input`);
    assert.doesNotMatch(
      `${entry.key} ${entry.label} ${entry.input.ariaLabel ?? ''}`,
      /link|checkbox|invert|decontaminate|preset|ramp|expression|subject|model|direction|mode/i,
      `${entry.key} names no non-numeric control`,
    );
  }
  assert.equal(
    inspectorNumericCases.some((entry) => /feather|expand|detail/i.test(entry.key)),
    false,
    'mask edge sliders are outside this inventory',
  );
});

test('every case input identity exists in the source it names', () => {
  for (const entry of inspectorNumericCases) {
    const source = readRepoFile(entry.input.source);
    assert.ok(source.includes(entry.input.marker), `${entry.key} marker in ${entry.input.source}`);
    if (entry.input.container !== undefined) {
      assert.ok(source.includes(entry.input.container), `${entry.key} container ${entry.input.container}`);
    }
  }
});

test('the shared checklist is one array and keyframe items apply only to animatable cases', () => {
  assert.deepEqual(
    NUMERIC_ACTION_CHECKLIST.map((action) => action.id),
    [
      'typing',
      'arrows',
      'spinner',
      'wheel',
      'bounds',
      'drag-right',
      'drag-left',
      'cancel',
      'keyframe',
      'undo-redo',
    ],
  );
  for (const entry of inspectorNumericCases) {
    assert.equal(entry.actions, NUMERIC_ACTION_CHECKLIST, `${entry.key} shares the checklist`);
  }
  assert.ok(actionsFor(byKey.get('Transform/x')).some((action) => action.id === 'keyframe'));
  assert.equal(
    actionsFor(byKey.get('Crop/left')).some((action) => action.id === 'keyframe'),
    false,
  );
  assert.equal(actionsFor(byKey.get('Crop/left')).length, NUMERIC_ACTION_CHECKLIST.length - 1);
});
