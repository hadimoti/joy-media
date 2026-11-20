import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { labRoots } from './lab-roots.mjs';
import {
  MONITOR_EDIT_ROWS,
  MONITOR_EDIT_ROWS_BY_ID,
  M07_TITLE_TEXT,
  cropHandleSelector,
  readTextValue,
  scratchLibraryAssetPath,
} from './desktop-monitor-edit-steps.mjs';

const EXPECTED_IDS = [
  'D-M07-01',
  'D-M07-02',
  'D-M07-03',
  'D-M07-04',
  'D-M07-05',
  'D-M07-06',
  'D-M07-07',
  'D-M07-08',
  'D-M07-09',
  'D-M07-10',
];

test('T-M07 has one isolated driver row for each live acceptance case', () => {
  assert.deepEqual(
    MONITOR_EDIT_ROWS.map((row) => row.id),
    EXPECTED_IDS,
  );
  assert.deepEqual(Object.keys(MONITOR_EDIT_ROWS_BY_ID), EXPECTED_IDS);
  assert.equal(M07_TITLE_TEXT.english, 'T-M07 English edited in place');
  assert.equal(M07_TITLE_TEXT.persian, 'عنوان فارسی ویرایش‌شده');
});

test('Monitor text readback uses the text document content, including Persian text', () => {
  assert.equal(
    readTextValue({ version: 1, blocks: [{ id: 'b1', runs: [{ text: M07_TITLE_TEXT.english }] }] }),
    M07_TITLE_TEXT.english,
  );
  assert.equal(
    readTextValue({ version: 1, blocks: [{ id: 'b1', runs: [{ text: M07_TITLE_TEXT.persian }] }] }),
    M07_TITLE_TEXT.persian,
  );
  assert.equal(
    readTextValue({
      version: 1,
      blocks: [{ id: 'b1', runs: [{ text: 'one' }, { text: ' two' }] }],
    }),
    'one two',
  );
});

test('crop handle selectors target the handle from the crop box', () => {
  assert.equal(cropHandleSelector('left'), '[data-crop-handle="left"]');
  assert.throws(() => cropHandleSelector('centre'), /unknown crop handle/u);
});

test('missing-media setup is limited to the current run scratch library', () => {
  const id = `joylib-${'a'.repeat(64)}`;
  const libraryDir = join(labRoots().scratch, 'libraries', 'run-1');
  assert.equal(scratchLibraryAssetPath(libraryDir, id, 'image'), join(libraryDir, 'images', id));
  assert.throws(
    () => scratchLibraryAssetPath(labRoots().scratch, id, 'image'),
    /outside the scratch library root/u,
  );
  assert.throws(
    () => scratchLibraryAssetPath(join(labRoots().scratch, 'libraries'), id, 'image'),
    /outside the scratch library root/u,
  );
  assert.throws(
    () =>
      scratchLibraryAssetPath(
        join(labRoots().scratch, 'libraries', 'run-1', 'nested'),
        id,
        'image',
      ),
    /outside the scratch library root/u,
  );
});

test('media-backed T-M07 rows refuse before touching the page without a fixture', async () => {
  for (const id of [
    'D-M07-03',
    'D-M07-04',
    'D-M07-05',
    'D-M07-06',
    'D-M07-07',
    'D-M07-08',
    'D-M07-09',
    'D-M07-10',
  ]) {
    await assert.rejects(
      MONITOR_EDIT_ROWS_BY_ID[id].run(null, { media: undefined }),
      new RegExp(`BLOCKED-on-fixture ${id}`),
    );
  }
});
