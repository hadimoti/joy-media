import { expect, test, type TestInfo } from '@playwright/test';
import {
  authenticate,
  openPanel,
  openReferenceWorkspace,
  recordEvidence,
  selectFirstTimelineClip,
  type R5Evidence,
} from './wp29-r5-harness.js';

type CaseExpectation = Pick<R5Evidence, 'caseId' | 'expected'>;

async function verifyCase(
  testInfo: TestInfo,
  expectation: CaseExpectation,
  run: () => Promise<string>,
): Promise<void> {
  try {
    const actual = await run();
    await recordEvidence(testInfo, {
      ...expectation,
      functional: 'PASS',
      uiA11y: 'PASS',
      actual,
      fixture: 'Authenticated E2E_TOKEN session; seeded Local editor project.',
    });
  } catch (error) {
    await recordEvidence(testInfo, {
      ...expectation,
      functional: 'FAIL',
      uiA11y: 'FAIL',
      actual: error instanceof Error ? error.message : String(error),
      fixture: 'Authenticated E2E_TOKEN session; seeded Local editor project.',
    });
    throw error;
  }
}

async function openMotionPanel(page: Parameters<typeof openPanel>[0]): Promise<void> {
  await openPanel(page, 'Motion');
  await expect(page.locator('.motion-panel')).toBeVisible();
}

async function selectReferenceClip(page: Parameters<typeof openPanel>[0]): Promise<void> {
  const timeline = page.locator('.timeline-panel');
  if (!(await timeline.isVisible())) {
    await page.locator('.panel-tab[aria-label="Timeline"]').first().click();
  }
  await expect(timeline).toBeVisible();
  await selectFirstTimelineClip(page);
}

async function applyArcInPreset(page: Parameters<typeof openPanel>[0]): Promise<void> {
  const motion = page.locator('.motion-panel');
  await motion.getByRole('tab', { name: 'Presets' }).click();
  await motion
    .locator('.motion-field', { hasText: 'Preset' })
    .locator('select')
    .selectOption('joy-arc-in');
  await motion.getByRole('button', { name: 'Apply motion preset' }).click();
  await expect(motion.getByRole('img', { name: 'x keyframes', exact: true })).toBeVisible();
  await expect(motion.getByRole('img', { name: 'y keyframes', exact: true })).toBeVisible();
}

test.describe('WP-29 R5 batch F — motion, camera, and templates', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
    try {
      await openReferenceWorkspace(page);
    } catch (error) {
      if (!(await page.getByRole('button', { name: 'File' }).isVisible())) throw error;
      // Dockview occasionally restores the sibling Flow tab as active even in
      // a fresh context. The workspace is open; explicitly activate Timeline.
      await openPanel(page, 'Timeline');
    }
  });

  test('R5 CASE-79 creates and opens a motion, then authors a keyframe that updates preview', async ({
    page,
  }, testInfo) => {
    await verifyCase(
      testInfo,
      {
        caseId: 79,
        expected:
          'A new MotionSceneDocument opens in Motion Studio; a UI-authored keyframe changes the rendered layer at the new playhead.',
      },
      async () => {
        await openMotionPanel(page);
        await page.getByRole('button', { name: 'Create new motion' }).click();

        const studio = page.locator('.motion-studio-overlay');
        await expect(studio).toBeVisible();
        await expect(studio.locator('.ms-topbar-name')).toHaveText('Untitled Motion 1');

        await studio.getByRole('button', { name: 'Add rectangle' }).click();
        await expect(studio.locator('.ms-layer[data-layer-id]')).toHaveCount(1);
        const canvasLayer = studio.locator('.ms-layer[data-layer-id]').first();
        await expect(canvasLayer).toHaveCSS('left', '100px');

        const xRow = studio
          .locator('.ms-inspector-section', { hasText: 'Transform' })
          .locator('.ms-inspector-row')
          .filter({ has: page.locator('.ms-inspector-label', { hasText: /^X$/ }) })
          .first();
        await xRow.locator('input[type="number"]').fill('240');
        await expect(canvasLayer).toHaveCSS('left', '240px');

        const toggleXKeyframe = xRow.getByRole('button', { name: 'Toggle keyframe' });
        await toggleXKeyframe.click();
        await expect(
          studio.getByLabel('Keyframe properties'),
          'Toggle keyframe must create an editable animation row rather than behaving as a no-op.',
        ).toBeVisible();
        await expect(toggleXKeyframe).toHaveAttribute('aria-pressed', 'true');

        await studio.getByRole('button', { name: 'Forward one second' }).click();
        await xRow.locator('input[type="number"]').fill('320');
        await toggleXKeyframe.click();
        await expect(
          studio.locator('.ms-timeline-kf-row', { hasText: 'transform.x' }),
        ).toContainText('2');
        await expect(studio.locator('.ms-canvas-stage')).toHaveAttribute('data-playhead', '1000');
        await expect(canvasLayer).toHaveCSS('left', '320px');

        return 'Created Untitled Motion 1, added a rectangle, authored X=240 at 0 ms and X=320 at 1000 ms through the inspector diamonds, and observed the live canvas update.';
      },
    );
  });

  test('R5 CASE-80 renames, duplicates, and deletes only the intended motion', async ({
    page,
  }, testInfo) => {
    await verifyCase(
      testInfo,
      {
        caseId: 80,
        expected:
          'Rename, Duplicate, and confirmed Delete affect only the chosen MotionSceneDocument and leave an independent copy.',
      },
      async () => {
        await openMotionPanel(page);
        await page.getByRole('button', { name: 'Create new motion' }).click();
        await page.getByRole('button', { name: 'Back to editor' }).click();

        const motion = page.locator('.motion-panel');
        const original = 'Untitled Motion 1';
        const renamed = 'R5 Motion 80';
        await expect(motion.getByRole('button', { name: `Open ${original}` })).toBeVisible();

        page.once('dialog', (dialog) => void dialog.accept(renamed));
        await motion.getByRole('button', { name: `Rename ${original}` }).click();
        await expect(motion.getByRole('button', { name: `Open ${renamed}` })).toBeVisible();

        await motion.getByRole('button', { name: `Duplicate ${renamed}` }).click();
        const copy = `${renamed} (Copy)`;
        await expect(motion.getByRole('button', { name: `Open ${copy}` })).toBeVisible();
        await expect(motion.getByRole('listitem')).toHaveCount(2);

        page.once('dialog', (dialog) => void dialog.accept());
        await motion.getByRole('button', { name: `Delete ${renamed}`, exact: true }).click();
        await expect(
          motion.getByRole('button', { name: `Open ${renamed}`, exact: true }),
        ).toHaveCount(0);
        await expect(
          motion.getByRole('button', { name: `Open ${copy}`, exact: true }),
        ).toBeVisible();

        await motion.getByRole('button', { name: `Open ${copy}`, exact: true }).click();
        const studio = page.locator('.motion-studio-overlay');
        await expect(studio).toBeVisible();
        await expect(studio.locator('.ms-topbar-name')).toHaveText(copy);

        return 'Renamed the draft, duplicated it, confirmed deletion of only the original, and opened the surviving independent copy.';
      },
    );
  });

  test('R5 CASE-81 persists a favorite and applies the selected motion preset', async ({
    page,
  }, testInfo) => {
    await verifyCase(
      testInfo,
      {
        caseId: 81,
        expected:
          'Favorite state persists in the motion library and Apply writes the selected preset channels to the selected visual object.',
      },
      async () => {
        await selectReferenceClip(page);
        await openMotionPanel(page);
        const motion = page.locator('.motion-panel');

        await motion.getByRole('tab', { name: 'Library' }).click();
        const favoriteButton = motion
          .getByRole('button', { name: /^Add .+ to favorites$/ })
          .first();
        const favoriteName = (await favoriteButton.getAttribute('aria-label'))!.replace(
          /^Add (.+) to favorites$/,
          '$1',
        );
        await favoriteButton.click();
        await expect(
          motion.getByRole('button', { name: `Remove ${favoriteName} from favorites` }),
        ).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                JSON.parse(localStorage.getItem('joy-media.motion-favorites') ?? '[]') as string[],
            ),
          )
          .toHaveLength(1);
        const [favoriteId] = await page.evaluate(
          () => JSON.parse(localStorage.getItem('joy-media.motion-favorites') ?? '[]') as string[],
        );
        expect(favoriteId).toMatch(/^joy-/);

        await motion.getByRole('tab', { name: 'Presets' }).click();
        await motion
          .locator('.motion-field', { hasText: 'Preset' })
          .locator('select')
          .selectOption('joy-pop-in');
        await motion.getByRole('button', { name: 'Apply motion preset' }).click();
        await expect(
          motion.getByRole('img', { name: 'scaleX keyframes', exact: true }),
        ).toBeVisible();
        await expect(
          motion.getByRole('img', { name: 'scaleY keyframes', exact: true }),
        ).toBeVisible();
        await expect(
          motion.getByRole('img', { name: 'opacity keyframes', exact: true }),
        ).toBeVisible();

        await page.reload();
        await selectReferenceClip(page);
        await openMotionPanel(page);
        await page.locator('.motion-panel').getByRole('tab', { name: 'Library' }).click();
        await expect(
          page
            .locator('.motion-panel')
            .getByRole('button', { name: `Remove ${favoriteName} from favorites` }),
        ).toBeVisible();

        return `Favorited ${favoriteName}, persisted it across reload, and applied Pop In with scaleX, scaleY, and opacity channels.`;
      },
    );
  });

  test('R5 CASE-82 applies and removes an HTML scene from the selected clip', async ({
    page,
  }, testInfo) => {
    await verifyCase(
      testInfo,
      {
        caseId: 82,
        expected:
          'Adding an HTML scene creates one new bound scene instance and Remove restores the previous project composition.',
      },
      async () => {
        await selectReferenceClip(page);
        await openMotionPanel(page);
        const motion = page.locator('.motion-panel');
        await motion.getByRole('tab', { name: 'Scenes' }).click();

        const removeButtons = motion.locator('button[aria-label^="Remove HTML scene "]');
        const beforeLabels = await removeButtons.evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute('aria-label') ?? ''),
        );
        const beforeCount = beforeLabels.length;

        const addButton = motion.getByRole('button', { name: /^Add .+ to selected clip$/ }).first();
        const sceneName = (await addButton.getAttribute('aria-label'))!.replace(
          /^Add (.+) to selected clip$/,
          '$1',
        );
        await addButton.click();
        if (await page.getByRole('heading', { name: 'Editor recovered safely' }).isVisible()) {
          const detail = await page.locator('[role="alert"] p').textContent();
          throw new Error(`Adding ${sceneName} crashed the editor: ${detail ?? 'unknown error'}`);
        }
        await expect(removeButtons).toHaveCount(beforeCount + 1);

        const afterLabels = await removeButtons.evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute('aria-label') ?? ''),
        );
        const addedLabel = afterLabels.find((label) => !beforeLabels.includes(label));
        expect(
          addedLabel,
          'The added scene must expose a target-specific Remove control.',
        ).toBeTruthy();
        await motion.getByRole('button', { name: addedLabel!, exact: true }).click();
        await expect(removeButtons).toHaveCount(beforeCount);
        await expect(motion.getByRole('button', { name: addedLabel!, exact: true })).toHaveCount(0);

        return `Added ${sceneName} as one new HTML-scene instance and removed that exact instance without altering the seeded scenes.`;
      },
    );
  });

  test('R5 CASE-83 creates, saves, and reopens a spatial path', async ({ page }, testInfo) => {
    await verifyCase(
      testInfo,
      {
        caseId: 83,
        expected:
          'A selected object with X/Y animation previews a spatial path; Save persists sampled path data across workspace reload.',
      },
      async () => {
        await selectReferenceClip(page);
        await openMotionPanel(page);
        await applyArcInPreset(page);

        const motion = page.locator('.motion-panel');
        await motion.getByRole('tab', { name: 'Spatial' }).click();
        await expect(motion.getByRole('img', { name: 'XY motion path' })).toBeVisible();
        const save = motion.getByRole('button', { name: 'Save spatial path' });
        await expect(save).toBeEnabled();
        await save.click();

        await expect
          .poll(() =>
            page.evaluate(() =>
              Object.values(localStorage).some((value) => value.includes('"spatialPath"')),
            ),
          )
          .toBe(true);

        await page.reload();
        await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
        await expect
          .poll(() =>
            page.evaluate(() =>
              Object.values(localStorage).some((value) => value.includes('"spatialPath"')),
            ),
          )
          .toBe(true);
        await selectReferenceClip(page);
        await openMotionPanel(page);
        await page.locator('.motion-panel').getByRole('tab', { name: 'Spatial' }).click();
        await expect(
          page.locator('.motion-panel').getByRole('img', { name: 'XY motion path' }),
        ).toBeVisible();

        return 'Applied Arc In to provide X/Y curves, saved the sampled spatialPath, reloaded, and reopened the path preview from persisted state.';
      },
    );
  });

  test('R5 CASE-84 creates and configures a camera with persistent active state', async ({
    page,
  }, testInfo) => {
    await verifyCase(
      testInfo,
      {
        caseId: 84,
        expected:
          'Create Camera, active-camera selection, transform, depth, roll, FOV, and parent all persist and reopen in sync.',
      },
      async () => {
        await openPanel(page, 'Camera');
        let camera = page.locator('.camera-panel');
        await camera.getByRole('button', { name: 'Create camera' }).click();
        if (await page.getByRole('heading', { name: 'Editor recovered safely' }).isVisible()) {
          const detail = await page.locator('[role="alert"] p').textContent();
          throw new Error(`Creating camera-1 crashed the editor: ${detail ?? 'unknown error'}`);
        }
        let rigSelects = camera.locator('.camera-field select');
        await expect(rigSelects.nth(0)).toHaveValue('camera-1');
        await rigSelects.nth(1).selectOption('camera-1');

        await camera.getByRole('tab', { name: 'Transform' }).click();
        const transformField = (label: string) =>
          camera
            .locator('.camera-controls .camera-field', { hasText: label })
            .locator('input,select');
        await transformField('X').fill('125');
        await transformField('Y').fill('250');
        await transformField('Depth (Z)').fill('-640');
        await transformField('Roll').fill('12');
        await transformField('Field of view').fill('68');
        await transformField('Parent').selectOption('intro-title');

        await page.reload();
        await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
        await openPanel(page, 'Camera');
        camera = page.locator('.camera-panel');
        rigSelects = camera.locator('.camera-field select');
        await expect(rigSelects.nth(1)).toHaveValue('camera-1');
        await rigSelects.nth(0).selectOption('camera-1');
        await camera.getByRole('tab', { name: 'Transform' }).click();
        await expect(transformField('X')).toHaveValue('125');
        await expect(transformField('Y')).toHaveValue('250');
        await expect(transformField('Depth (Z)')).toHaveValue('-640');
        await expect(transformField('Roll')).toHaveValue('12');
        await expect(transformField('Field of view')).toHaveValue('68');
        await expect(transformField('Parent')).toHaveValue('intro-title');

        return 'Created camera-1, activated it, edited X/Y/Z/roll/FOV/parent, then reloaded and verified every value.';
      },
    );
  });

  test('R5 CASE-85 browses, applies, and confirmed-deletes a user template', async ({
    page,
  }, testInfo) => {
    await verifyCase(
      testInfo,
      {
        caseId: 85,
        expected:
          'Template categories browse correctly; applying adds content; authored templates enter My Templates and delete only after confirmation.',
      },
      async () => {
        await selectReferenceClip(page);
        const initialClipCount = await page.locator('.timeline-clip[data-clip-id]').count();
        await openPanel(page, 'Templates');
        const templates = page.locator('.templates-panel');
        await expect(templates.locator('.template-card')).toHaveCount(10);

        await templates.getByRole('tab', { name: 'Titles' }).click();
        await expect(templates.locator('.template-card')).toHaveCount(4);
        await expect(templates.locator('.template-card-category')).toHaveText([
          'Titles',
          'Titles',
          'Titles',
          'Titles',
        ]);

        const customName = 'R5 Template 85';
        page.once('dialog', (dialog) => void dialog.accept(customName));
        await templates.getByRole('button', { name: 'Save JOY Title to My Templates' }).click();
        await expect(templates.getByRole('tab', { name: 'My Templates' })).toHaveAttribute(
          'aria-selected',
          'true',
        );
        await expect(templates.locator('.template-card', { hasText: customName })).toBeVisible();

        await templates.getByRole('button', { name: `Apply ${customName}` }).click();
        await expect(
          page.getByText(`Template "${customName}" applied`, { exact: true }),
        ).toBeVisible();
        await expect(page.locator('.timeline-clip[data-clip-id]')).toHaveCount(
          initialClipCount + 1,
        );

        page.once('dialog', (dialog) => void dialog.accept());
        await templates.getByRole('button', { name: `Delete ${customName}` }).click();
        await expect(templates.locator('.template-card', { hasText: customName })).toHaveCount(0);
        await expect(templates.getByText('No saved templates yet.', { exact: true })).toBeVisible();

        return 'Browsed the four Titles, saved JOY Title as a user template, applied it to add one clip, and confirmed deletion of only that saved copy.';
      },
    );
  });
});
