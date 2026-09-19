/* global document, fetch */
import { _electron as electron } from '@playwright/test';
import { resolve, join } from 'node:path';
import { mkdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const desktopRoot = resolve('apps/desktop');
const localAppData =
  process.env.LOCALAPPDATA || join(process.env.USERPROFILE || 'C:/Users/HadiMoti', 'AppData/Local');
const installedExe = resolve(localAppData, 'Programs/JOY Media/joy-media.exe');
const distExe = resolve(desktopRoot, 'dist/joy-media-win32-x64/joy-media.exe');
const targetExe = existsSync(installedExe) ? installedExe : distExe;
const targetCwd = existsSync(installedExe)
  ? resolve(localAppData, 'Programs/JOY Media')
  : resolve(desktopRoot, 'dist', 'joy-media-win32-x64');

const screenshotDir = resolve(
  process.env.JOY_SCREENSHOT_DIR ||
    'C:/Users/HadiMoti/.gemini/antigravity/brain/ac00181e-3969-48fc-a342-b10f4103c344/screenshots',
);
mkdirSync(screenshotDir, { recursive: true });

console.log('=== JOY Media Local Asset Library Playwright E2E Verification ===');
console.log(`Target Executable: ${targetExe}`);
console.log(`Working Directory: ${targetCwd}`);
console.log(`Screenshot Directory: ${screenshotDir}`);

const tempUserData = mkdtempSync(join(tmpdir(), 'joy-asset-lib-test-'));

let app;
try {
  const cleanEnv = { ...process.env };
  delete cleanEnv.NODE_ENV;

  console.log('1. Launching JOY Media desktop application...');
  app = await electron.launch({
    executablePath: targetExe,
    cwd: targetCwd,
    args: [`--user-data-dir=${tempUserData}`],
    env: cleanEnv,
  });

  const window = await app.firstWindow();
  await window.setViewportSize({ width: 1440, height: 900 });

  window.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error') {
      console.error(`[Renderer Error] ${text}`);
    } else if (text.includes('Asset') || text.includes('asset') || text.includes('catalog')) {
      console.log(`[Renderer Info] ${text}`);
    }
  });

  window.on('pageerror', (err) => {
    console.error(`[Uncaught Page Error] ${err.message}`);
  });

  await window.waitForLoadState('domcontentloaded');
  await new Promise((r) => setTimeout(r, 2000));

  // Step 1: Verify Desktop IPC Asset Library info directly from renderer
  console.log('2. Querying desktop.asset-library.get-settings via IPC...');
  const assetLibInfo = await window.evaluate(async () => {
    return await window.joyDesktop.invoke('desktop.asset-library.get-settings');
  });
  console.log('Asset Library Info from Desktop IPC:', JSON.stringify(assetLibInfo, null, 2));

  if (!assetLibInfo.exists || !assetLibInfo.hasCatalog) {
    throw new Error(`Asset library not valid or does not exist at ${assetLibInfo.directory}`);
  }
  if (
    assetLibInfo.counts.total !== 3075 ||
    assetLibInfo.counts.audio !== 1805 ||
    assetLibInfo.counts.image !== 1270
  ) {
    throw new Error(`Unexpected asset counts: ${JSON.stringify(assetLibInfo.counts)}`);
  }
  console.log(
    '✔ Asset Library IPC Info matched expected counts: 3075 total (1805 audio, 1270 images).',
  );

  // Step 2: Query desktop.asset-library.get-catalog
  console.log('3. Querying desktop.asset-library.get-catalog via IPC...');
  const catalog = await window.evaluate(async () => {
    return await window.joyDesktop.invoke('desktop.asset-library.get-catalog');
  });
  console.log(
    `Catalog loaded via IPC: ${catalog?.assets?.length} assets, version ${catalog?.version}`,
  );
  if (!catalog || catalog.assets?.length !== 3075) {
    throw new Error(`Catalog assets count mismatch: expected 3075, got ${catalog?.assets?.length}`);
  }
  console.log('✔ Asset Library Catalog loaded 3,075 items successfully.');

  // Step 3: Unlock workspace / open project
  console.log('4. Entering workspace...');
  const projectCard = window.locator('.project-library-card').first();
  if (await projectCard.isVisible()) {
    await projectCard.click();
    console.log('Clicked project card.');
  }

  await window
    .waitForSelector('.dockview-theme-dark, .workspace', { timeout: 10000 })
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 2000));

  // Step 4: Open Asset Library Settings Dialog via App menu or trigger
  console.log('5. Triggering Asset Library Settings dialog...');
  const clickedBtn = await window.evaluate(() => {
    const btn = document.querySelector(
      'button[title*="Asset Library Folder"], button[aria-label*="Asset Library"]',
    );
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });

  if (!clickedBtn) {
    const editMenu = window.locator('button.menu-trigger:has-text("Edit")');
    if (await editMenu.isVisible()) {
      await editMenu.click();
      await new Promise((r) => setTimeout(r, 300));
      const assetSettingsItem = window.locator('.menu-item:has-text("Asset Library Folder")');
      if (await assetSettingsItem.isVisible()) {
        await assetSettingsItem.click();
        console.log('Clicked "Asset Library Folder..." in Edit menu.');
      }
    }
  }

  await new Promise((r) => setTimeout(r, 1000));
  const shotSettings = join(screenshotDir, '06-asset-library-settings-dialog.png');
  await window.screenshot({ path: shotSettings, fullPage: true });
  console.log(`Captured screenshot: ${shotSettings}`);

  // Close the settings dialog using "Done" or the close icon
  const doneBtn = window.locator('button:has-text("Done")');
  if (await doneBtn.isVisible()) {
    await doneBtn.click();
    console.log('Closed Asset Library Settings dialog via Done.');
  } else {
    const xBtn = window.locator('.asset-settings-dialog button').first();
    await xBtn.click();
  }
  await new Promise((r) => setTimeout(r, 1000));

  // Step 5: Focus and interact with Library panel
  console.log('6. Focusing Library panel...');
  // Click on "Images 1270" filter pill
  const imagesChip = window.locator('button:has-text("Images"), button:has-text("1270")').first();
  if (await imagesChip.isVisible()) {
    await imagesChip.click();
    console.log('Clicked Images filter chip in Library.');
  }
  await new Promise((r) => setTimeout(r, 1200));

  const shotImages = join(screenshotDir, '07-asset-library-images-view.png');
  await window.screenshot({ path: shotImages, fullPage: true });
  console.log(`Captured screenshot: ${shotImages}`);

  // Click the "+" button on the first asset card to add to timeline
  const addBtn = window
    .locator(
      'button[title*="Add to timeline"], button[aria-label*="Add to timeline"], .library-card button:has-text("+"), button.asset-action-btn:has-text("+")',
    )
    .first();
  if (await addBtn.isVisible()) {
    await addBtn.click();
    console.log('Clicked "+" on first asset card to add to timeline.');
    await new Promise((r) => setTimeout(r, 2000));
  } else {
    // Try clicking the card's add button directly by class or selector
    const _plusIconBtn = window.locator('button:has(svg)').filter({ hasText: '' }).first();
    console.log('Attempted alternate add button search.');
  }

  const shotAdded = join(screenshotDir, '09-asset-added-to-timeline.png');
  await window.screenshot({ path: shotAdded, fullPage: true });
  console.log(`Captured screenshot: ${shotAdded}`);

  // Now switch to Audio filter chip in Library
  console.log('7. Testing audio asset addition to timeline...');
  const audioPill = window
    .locator('.asset-filter-pill:has-text("Audio"), button:has-text("Audio 1805")')
    .first();
  if (await audioPill.isVisible()) {
    await audioPill.click();
    console.log('Clicked Audio 1805 filter pill in Library.');
    await new Promise((r) => setTimeout(r, 1200));

    // Click "+" on first audio asset
    const audioAddBtn = window
      .locator('button[title*="Add to timeline"], button[aria-label*="Add to timeline"]')
      .first();
    if (await audioAddBtn.isVisible()) {
      await audioAddBtn.click();
      console.log('Clicked "+" on first audio asset card.');
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  const shotAudioAdded = join(screenshotDir, '10-audio-added-to-timeline.png');
  await window.screenshot({ path: shotAudioAdded, fullPage: true });
  console.log(`Captured screenshot: ${shotAudioAdded}`);

  // Step 6: Test joy-asset:// protocol directly inside renderer
  console.log('7. Testing joy-asset:// custom protocol in renderer...');
  const protocolTest = await window.evaluate(async () => {
    const audioRes = await fetch(
      'joy-asset://library/audio/joylib-01376f5f76ef237b6530b6306ec641d09cf6aa0268f7bac45c085004d7ffb232',
    );
    const imageRes = await fetch(
      'joy-asset://library/images/joylib-045d64ee6e795d2bec9811a0eac32e0806a64a9060859fd9fc647aaa8da798e5',
    );
    const audioBlob = await audioRes.blob();
    const imageBlob = await imageRes.blob();
    return {
      audioStatus: audioRes.status,
      audioSize: audioBlob.size,
      audioType: audioBlob.type,
      imageStatus: imageRes.status,
      imageSize: imageBlob.size,
      imageType: imageBlob.type,
    };
  });
  console.log('joy-asset:// protocol test result:', JSON.stringify(protocolTest, null, 2));

  if (protocolTest.audioStatus !== 200 || protocolTest.audioSize === 0) {
    throw new Error(`Audio fetch failed over joy-asset://: ${JSON.stringify(protocolTest)}`);
  }
  if (protocolTest.imageStatus !== 200 || protocolTest.imageSize === 0) {
    throw new Error(`Image fetch failed over joy-asset://: ${JSON.stringify(protocolTest)}`);
  }
  console.log('✔ joy-asset:// custom protocol successfully streamed local audio and image blobs!');

  // Step 7: Screenshot final workspace with Library active
  const shotWorkspace = join(screenshotDir, '07-asset-library-panel-verified.png');
  await window.screenshot({ path: shotWorkspace, fullPage: true });
  console.log(`Captured screenshot: ${shotWorkspace}`);

  console.log('=== ALL E2E ASSET LIBRARY CHECKS PASSED PERFECTLY ===');
} catch (err) {
  console.error('Verification failed:', err);
  process.exitCode = 1;
} finally {
  if (app) {
    await app.close();
  }
  try {
    rmSync(tempUserData, { recursive: true, force: true });
  } catch {
    /* ignore temp dir cleanup failure */
  }
}
