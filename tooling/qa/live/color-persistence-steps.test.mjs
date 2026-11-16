import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePage } from './fake-page.mjs';
import {
  applyEachBuiltInLook,
  BUILT_IN_COLOUR_LOOKS,
  runColourLifecycle,
} from './color-persistence-steps.mjs';

function lifecycleState() {
  return {
    pixel: { r: 40, g: 180, b: 50 },
    grade: { lut: 'none' },
    exported: false,
    reopened: false,
    undone: false,
  };
}

function lifecycle(state, page) {
  return {
    readPreviewPixel: async () => ({ ...state.pixel }),
    readGrade: async () => ({ ...state.grade }),
    edit: async () => {
      state.grade = { lut: 'monochrome' };
      state.pixel = { r: 120, g: 120, b: 120 };
      await page.locator('[data-color-look="monochrome"]').click();
    },
    saveAndReopen: async () => {
      state.reopened = true;
      return { ...state.grade };
    },
    compareExportFrame: async () => {
      state.exported = true;
    },
    undo: async () => {
      assert.equal(state.reopened, true);
      state.grade = { lut: 'none' };
      state.pixel = { r: 40, g: 180, b: 50 };
      state.undone = true;
      await page.keyboard.press('Control+z');
    },
    pixel: { x: 100, y: 100 },
  };
}

test('colour lifecycle checks preview, save/reopen, optional export compare, then Undo', async () => {
  const page = createFakePage();
  const state = lifecycleState();
  const message = await runColourLifecycle(page, lifecycle(state, page));

  assert.match(message, /preview changed/u);
  assert.equal(state.reopened, true);
  assert.equal(state.exported, true);
  assert.equal(state.undone, true);
  assert.ok(page.calls.some((call) => call.includes('monochrome')));
  assert.ok(page.calls.some((call) => call.includes('Control+z')));
});

test('colour lifecycle fails when an edit leaves the known preview frame unchanged', async () => {
  const page = createFakePage();
  const state = lifecycleState();
  const deps = lifecycle(state, page);
  deps.edit = async () => {
    state.grade = { lut: 'monochrome' };
  };

  await assert.rejects(runColourLifecycle(page, deps), /not the preview pixel/u);
  assert.equal(state.reopened, false);
});

test('colour lifecycle fails when save and reopen loses the edited grade', async () => {
  const page = createFakePage();
  const state = lifecycleState();
  const deps = lifecycle(state, page);
  deps.saveAndReopen = async () => ({ lut: 'none' });

  await assert.rejects(runColourLifecycle(page, deps), /did not keep the colour grade/u);
  assert.equal(state.undone, false);
});

test('the Look driver covers all six built-in Looks and checks each lifecycle', async () => {
  const page = createFakePage();
  const lookResults = await applyEachBuiltInLook(page, async (look) => {
    let active = 'none';
    const baseline = { r: 40, g: 180, b: 50 };
    const graded = { r: 100, g: 100, b: 100 };
    const baselineGrade = { lut: 'none' };
    const grade = { lut: look.id };
    return {
      pixel: { x: 100, y: 100 },
      readPreviewPixel: async () => (active === 'none' ? baseline : graded),
      readGrade: async () => (active === 'none' ? baselineGrade : grade),
      saveAndReopen: async () => grade,
      undo: async () => {
        active = 'none';
      },
      edit: async () => {
        active = look.id;
      },
    };
  });

  assert.deepEqual(
    lookResults.map(({ look }) => look),
    BUILT_IN_COLOUR_LOOKS.map(({ id }) => id),
  );
  for (const { name } of BUILT_IN_COLOUR_LOOKS) {
    assert.ok(page.calls.some((call) => call.includes(name)));
  }
});
