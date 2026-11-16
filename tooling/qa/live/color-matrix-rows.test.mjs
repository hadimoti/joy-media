import assert from 'node:assert/strict';
import test from 'node:test';
import {
  COLOR_MATRIX_ROWS,
  COLOR_MATRIX_ROWS_BY_ID,
  readColourGrade,
} from './color-matrix-rows.mjs';
import { createFakePage } from './fake-page.mjs';
import { executeRow } from './matrix-core.mjs';

test('the live colour registry exposes T-F23 pixel equality and T-K07 rows in card order', () => {
  assert.deepEqual(
    COLOR_MATRIX_ROWS.map((row) => row.id),
    ['D-F23-01', 'D-K01', 'D-K02', 'D-K03', 'D-K04'],
  );
  assert.deepEqual(Object.keys(COLOR_MATRIX_ROWS_BY_ID), [
    'D-F23-01',
    'D-K01',
    'D-K02',
    'D-K03',
    'D-K04',
  ]);
});

test('a fake registered row passes through the matrix executor', async () => {
  const page = createFakePage();
  const log = { setLabel() {} };
  const result = await executeRow(
    { ...COLOR_MATRIX_ROWS_BY_ID['D-K01'], run: async () => 'fake colour pass' },
    page,
    { bridge: { log, drainTap: async () => 0 }, shot: async () => null },
  );
  assert.equal(result.id, 'D-K01');
  assert.equal(result.status, 'passed');
  assert.equal(result.message, 'fake colour pass');
});

test('colour grade reads use the document reader supplied by the matrix context', async () => {
  const page = createFakePage();
  const state = { document: { colorGrade: { lift: { r: 0.2, g: 0, b: 0 } } } };
  let calls = 0;
  const grade = await readColourGrade({
    page,
    async readDocument() {
      calls += 1;
      return state;
    },
  });

  assert.equal(calls, 1);
  assert.equal(grade['document.colorGrade'], state.document.colorGrade);
});

test('a fake registered row failure is reported as failed', async () => {
  const page = createFakePage();
  const log = { setLabel() {} };
  const result = await executeRow(
    {
      ...COLOR_MATRIX_ROWS_BY_ID['D-K02'],
      run: async () => {
        throw new Error('fake colour failure');
      },
    },
    page,
    { bridge: { log, drainTap: async () => 0 }, shot: async () => null },
  );
  assert.equal(result.id, 'D-K02');
  assert.equal(result.status, 'failed');
  assert.equal(result.message, 'fake colour failure');
});
