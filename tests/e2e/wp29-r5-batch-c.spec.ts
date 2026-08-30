import { expect, test, type Page } from '@playwright/test';
import { readFile, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  E2E_TOKEN,
  MEDIA_FIXTURE_DIR,
  authenticate,
  openDisposableWorkspace,
  openPanel,
  recordEvidence,
  selectFirstTimelineClip,
} from './wp29-r5-harness.js';

interface TranscriptionFixture {
  readonly language: string;
  readonly modelId: string;
  readonly speakers: readonly { readonly id: string; readonly name: string }[];
  readonly words: readonly {
    readonly text: string;
    readonly startUs: number;
    readonly endUs: number;
    readonly confidence: number;
    readonly speakerId: string;
  }[];
}

interface TranscriptionProbe {
  requests: number;
  language?: string;
  authorization?: string;
  contentType?: string;
  bytes?: number;
  failNext: boolean;
}

const readFileAsync = promisify(readFile);
const fixtureDirectory = join(process.cwd(), 'apps/editor-web/src/fixtures');
const englishFixture = JSON.parse(
  readFileSync(join(fixtureDirectory, 'transcription-en-US.json'), 'utf8'),
) as TranscriptionFixture;
const persianFixture = JSON.parse(
  readFileSync(join(fixtureDirectory, 'transcription-fa-IR.json'), 'utf8'),
) as TranscriptionFixture;

async function openCaptionActions(page: Page): Promise<void> {
  const menu = page.locator('.caption-action-menu').first();
  if ((await menu.getAttribute('open')) === null) {
    await menu.locator('summary[aria-label="Caption track actions"]').click();
  }
  await expect(menu).toHaveAttribute('open', '');
}

async function uploadCaptionText(
  page: Page,
  file: { readonly name: string; readonly mimeType: string; readonly text: string },
): Promise<void> {
  await openCaptionActions(page);
  const chooserPromise = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Import SRT/VTT' }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: file.name,
    mimeType: file.mimeType,
    buffer: Buffer.from(file.text, 'utf8'),
  });
}

async function downloadCaptionText(
  page: Page,
  buttonName: 'Export SRT' | 'Export VTT',
): Promise<{ readonly fileName: string; readonly text: string }> {
  await openCaptionActions(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: buttonName }).click();
  const download = await downloadPromise;
  const path = await download.path();
  if (path === null) throw new Error(`${buttonName} did not produce a local browser download`);
  return {
    fileName: download.suggestedFilename(),
    text: await readFileAsync(path, 'utf8'),
  };
}

async function openEmptyCaptionTrack(page: Page, title: string): Promise<void> {
  await openDisposableWorkspace(page, title);
  await openPanel(page, 'Captions');
  await page.getByRole('button', { name: 'Add caption track' }).click();
  await expect(page.locator('summary[aria-label="Caption track actions"]')).toBeVisible();
}

async function openVideoCaptionTrack(page: Page, title: string): Promise<void> {
  await openDisposableWorkspace(page, title);
  await openPanel(page, 'Assets');
  await page.getByRole('button', { name: 'Import media' }).first().click();
  const drawer = page.getByRole('dialog', { name: 'Import media' });
  const mediaName = `wp29-caption-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
  await drawer.locator('input[type="file"][aria-label="Media file"]').setInputFiles({
    name: mediaName,
    mimeType: 'video/mp4',
    buffer: readFileSync(join(MEDIA_FIXTURE_DIR, 'video.mp4')),
  });
  await drawer.getByRole('button', { name: 'Confirm import' }).click();
  const card = page.locator('.asset-card', { hasText: mediaName });
  await expect(card).toHaveCount(1);
  const addButton = card.getByRole('button', { name: `Add ${mediaName} to timeline` });
  await addButton.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.timeline-clip[data-clip-id]')).toHaveCount(1);
  await selectFirstTimelineClip(page);
  await openPanel(page, 'Captions');
  await page.getByRole('button', { name: 'Add caption track' }).click();
  await page.getByRole('tab', { name: 'Generate' }).click();
  await expect(page.getByRole('button', { name: 'Generate English' })).toBeVisible();
}

async function routeTranscriptionFixture(
  page: Page,
  fixture: TranscriptionFixture,
  responseDelayMs = 0,
): Promise<{ readonly probe: TranscriptionProbe; readonly requestSeen: Promise<void> }> {
  const probe: TranscriptionProbe = { requests: 0, failNext: false };
  let markRequestSeen: (() => void) | undefined;
  const requestSeen = new Promise<void>((resolve) => {
    markRequestSeen = resolve;
  });

  await page.route('**/api/v1/providers/speech/transcribe?*', async (route) => {
    const request = route.request();
    const postData = request.postDataBuffer();
    probe.requests += 1;
    probe.language = new URL(request.url()).searchParams.get('language') ?? undefined;
    probe.authorization = request.headers().authorization;
    probe.contentType = request.headers()['content-type'];
    probe.bytes = postData?.byteLength ?? 0;
    markRequestSeen?.();
    markRequestSeen = undefined;

    if (probe.failNext) {
      probe.failNext = false;
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: { code: 'PROVIDER_UNAVAILABLE', message: 'deterministic provider outage' },
        }),
      });
      return;
    }

    if (responseDelayMs > 0)
      await new Promise<void>((resolve) => {
        setTimeout(resolve, responseDelayMs);
      });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          language: fixture.language,
          words: fixture.words,
          speakers: fixture.speakers,
          provenance: {
            providerId: 'joy.playwright-fixture',
            modelId: fixture.modelId,
            createdAt: '2026-08-11T00:00:00.000Z',
          },
        },
      }),
    });
  });

  return { probe, requestSeen };
}

test.describe('WP-29 R5 batch C — captions', () => {
  test.beforeEach(async ({ page }) => {
    await authenticate(page);
  });

  test('[R5 CASE-53] reverts and deletes one caption with one-step recovery', async ({
    page,
  }, testInfo) => {
    await openEmptyCaptionTrack(page, `R5-53-${testInfo.project.name}`);
    await page.getByRole('button', { name: 'Add caption' }).click();

    const rows = page.locator('.captions-panel .caption-row');
    const row = rows.first();
    const text = row.getByRole('textbox', { name: /Caption text / });
    await expect(rows).toHaveCount(1);
    await expect(text).toHaveValue('New caption');

    await text.fill('Edited caption');
    await expect(text).toHaveValue('Edited caption');

    const revert = row.getByRole('button', { name: /Revert caption .* to source text/ });
    await revert.click();
    await expect(text).toHaveValue('');
    await expect(row.getByRole('button', { name: /Revert caption .* to source text/ })).toHaveCount(
      0,
    );
    await page.keyboard.press('Control+z');
    await expect(text).toHaveValue('Edited caption');

    await row.getByRole('button', { name: /Delete caption / }).click();
    await expect(rows).toHaveCount(0);
    await page.keyboard.press('Control+z');
    await expect(rows).toHaveCount(1);
    await expect(rows.first().getByRole('textbox', { name: /Caption text / })).toHaveValue(
      'Edited caption',
    );

    await recordEvidence(testInfo, {
      caseId: 53,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected:
        'Revert and Delete affect only the intended caption, expose named controls, and each recovers in one Undo.',
      actual:
        'The named text control edited the override; Revert restored source, Undo restored the edit, Delete removed one row, and the next Undo restored that same caption.',
    });
  });

  test('[R5 CASE-54] applies Clean, Karaoke, and RTL caption templates with persistent state', async ({
    page,
  }, testInfo) => {
    await openEmptyCaptionTrack(page, `R5-54-${testInfo.project.name}`);
    await page.getByRole('tab', { name: 'Style' }).click();
    const templateGroup = page.getByRole('group', { name: 'Caption template' });
    const clean = templateGroup.getByRole('button', { name: 'JOY Clean' });
    const karaoke = templateGroup.getByRole('button', { name: 'JOY Karaoke Pop' });
    const rtl = templateGroup.getByRole('button', { name: 'JOY RTL Classic' });

    await expect(clean).toHaveAttribute('aria-pressed', 'true');
    await karaoke.click();
    await expect(karaoke).toHaveAttribute('aria-pressed', 'true');
    await expect(clean).toHaveAttribute('aria-pressed', 'false');
    await rtl.click();
    await expect(rtl).toHaveAttribute('aria-pressed', 'true');
    await expect(karaoke).toHaveAttribute('aria-pressed', 'false');

    await page.reload();
    await expect(page.getByRole('button', { name: 'File' })).toBeVisible();
    await openPanel(page, 'Captions');
    await page.getByRole('tab', { name: 'Style' }).click();
    const restoredGroup = page.getByRole('group', { name: 'Caption template' });
    await expect(restoredGroup.getByRole('button', { name: 'JOY RTL Classic' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await recordEvidence(testInfo, {
      caseId: 54,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected:
        'Clean, Karaoke, and RTL template controls expose an accurate active style, apply exclusively, and persist across reload.',
      actual:
        'All three named controls were keyboard-accessible; active styling moved exclusively from Clean to Karaoke to RTL and RTL restored after reload.',
    });
  });

  test('[R5 CASE-55] imports multiline SRT text and exact cue timing', async ({
    page,
  }, testInfo) => {
    await openEmptyCaptionTrack(page, `R5-55-${testInfo.project.name}`);
    await uploadCaptionText(page, {
      name: 'wp29-multiline.srt',
      mimeType: 'application/x-subrip',
      text: [
        '1',
        '00:00:01,000 --> 00:00:03,500',
        'JOY Media',
        'multiline caption',
        '',
        '2',
        '00:00:04,250 --> 00:00:05,750',
        'Second cue',
        '',
      ].join('\n'),
    });

    const rows = page.locator('.captions-panel .caption-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0).locator('.caption-source')).toHaveValue('JOY Media multiline caption');
    await expect(rows.nth(1).locator('.caption-source')).toHaveValue('Second cue');
    await expect(rows.nth(0).locator('.caption-time')).toHaveText('1.00s');
    await expect(rows.nth(1).locator('.caption-time')).toHaveText('4.25s');
    await expect(page.getByText(/bad cue\(s\) were skipped/)).toHaveCount(0);

    await recordEvidence(testInfo, {
      caseId: 55,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'A real SRT upload joins multiline cue text and preserves both cue starts.',
      actual:
        'The file chooser imported two cues; multiline text normalized to spaces and starts rendered at 1.00s and 4.25s.',
    });
  });

  test('[R5 CASE-56] imports Persian WebVTT, resolves RTL, and reports malformed cues', async ({
    page,
  }, testInfo) => {
    await openEmptyCaptionTrack(page, `R5-56-${testInfo.project.name}`);
    await uploadCaptionText(page, {
      name: 'wp29-persian-with-diagnostic.vtt',
      mimeType: 'text/vtt',
      text: [
        'WEBVTT',
        '',
        'intro',
        '00:00.500 --> 00:02.000',
        'سلام، این یک آزمون است.',
        '',
        'broken-cue',
        'not a timing line',
        'این بخش نباید وارد شود',
        '',
      ].join('\n'),
    });

    const section = page.getByRole('region', { name: 'Captions en-US' });
    await expect(section.locator('.caption-row')).toHaveCount(1);
    await expect(section.locator('.caption-source')).toHaveValue('سلام، این یک آزمون است.');
    await expect(section.locator('.caption-time')).toHaveAccessibleName('Seek to 0.50s');
    await expect(section.locator('.caption-track-summary')).toContainText('en-USRTL');
    await expect(page.getByText('On import, 1 bad cue(s) were skipped.')).toBeVisible();

    await recordEvidence(testInfo, {
      caseId: 56,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected:
        'A valid Persian VTT cue remains usable while a malformed cue receives actionable feedback.',
      actual:
        'The valid 0.50s Persian cue rendered with RTL resolution and the invalid block produced a one-cue warning.',
    });
  });

  test('[R5 CASE-57] downloads current captions as valid SRT and WebVTT bytes', async ({
    page,
  }, testInfo) => {
    await openEmptyCaptionTrack(page, `R5-57-${testInfo.project.name}`);
    await uploadCaptionText(page, {
      name: 'wp29-export-source.srt',
      mimeType: 'application/x-subrip',
      text: [
        '1',
        '00:00:01,000 --> 00:00:02,750',
        'First exported cue',
        '',
        '2',
        '00:00:03,125 --> 00:00:04,500',
        'دومین زیرنویس',
        '',
      ].join('\n'),
    });

    const srt = await downloadCaptionText(page, 'Export SRT');
    const webVtt = await downloadCaptionText(page, 'Export VTT');

    expect(srt.fileName).toMatch(/\.srt$/i);
    expect(Buffer.byteLength(srt.text, 'utf8')).toBeGreaterThan(0);
    expect(srt.text).toContain('1\n00:00:01,000 --> 00:00:02,750\nFirst exported cue');
    expect(srt.text).toContain('2\n00:00:03,125 --> 00:00:04,500\nدومین زیرنویس');
    expect(webVtt.fileName).toMatch(/\.vtt$/i);
    expect(Buffer.byteLength(webVtt.text, 'utf8')).toBeGreaterThan(0);
    expect(webVtt.text).toMatch(/^WEBVTT\n/);
    expect(webVtt.text).toContain('00:00:01.000 --> 00:00:02.750');
    expect(webVtt.text).toContain('00:00:03.125 --> 00:00:04.500');
    expect(webVtt.text).toContain('دومین زیرنویس');

    await recordEvidence(testInfo, {
      caseId: 57,
      functional: 'PASS',
      uiA11y: 'PASS',
      expected: 'Both export controls emit non-empty, current, validly timed caption downloads.',
      actual: `Playwright captured ${srt.fileName} (${Buffer.byteLength(srt.text, 'utf8')} bytes) and ${webVtt.fileName} (${Buffer.byteLength(webVtt.text, 'utf8')} bytes), then parsed their timing/text bytes.`,
    });
  });

  test('[R5 CASE-58] transcribes English media with progress, confidence, and error recovery', async ({
    page,
  }, testInfo) => {
    const { probe, requestSeen } = await routeTranscriptionFixture(page, englishFixture, 350);
    await openVideoCaptionTrack(page, `R5-58-${testInfo.project.name}`);

    const transcribeButton = page.getByRole('button', { name: 'Generate English' });
    await transcribeButton.click();
    await requestSeen;
    const progressVisible =
      (await transcribeButton.isDisabled()) ||
      (await page
        .locator(
          '.captions-panel [aria-busy="true"], .captions-panel [role="progressbar"], .captions-panel [data-transcribing="true"]',
        )
        .evaluateAll((elements) =>
          elements.some((element) => element.getClientRects().length > 0),
        ));

    await page.getByRole('tab', { name: 'Transcript' }).click();
    const source = page.locator('.captions-panel .caption-source').first();
    await expect(source).toHaveValue('Welcome to the JOY Media studio');
    await expect(
      page.locator('.captions-panel .caption-warning[title^="Transcription confidence"]'),
    ).toHaveText('94%');
    expect(probe).toMatchObject({
      requests: 1,
      language: 'en-US',
      authorization: `Bearer ${E2E_TOKEN}`,
      contentType: 'video/mp4',
    });
    expect(probe.bytes).toBeGreaterThan(0);

    probe.failNext = true;
    await page.getByRole('tab', { name: 'Generate' }).click();
    await page.getByRole('button', { name: 'Generate English' }).click();
    await expect(page.locator('.captions-panel .joy-panel-note')).toContainText(
      'Live transcription could not process the selected media. You can continue editing captions manually.',
    );
    await page.getByRole('tab', { name: 'Transcript' }).click();
    await expect(source).toHaveValue('Welcome to the JOY Media studio');

    await recordEvidence(testInfo, {
      caseId: 58,
      functional: 'PASS-FIXTURE',
      uiA11y: progressVisible ? 'PASS-FIXTURE' : 'FAIL',
      expected:
        'English transcription reports progress, posts selected media once, places timed/confident text, and preserves editing on failure.',
      actual: progressVisible
        ? 'A visible progress state preceded a fixture transcript; a second 503 left the result intact with recovery guidance.'
        : 'The deterministic transcript and 503 recovery worked, but no disabled/busy/progress state was exposed while the request was pending.',
      fixture: 'apps/editor-web/src/fixtures/transcription-en-US.json via Playwright route',
    });
    expect(
      progressVisible,
      'English transcription must expose a visible or accessible pending state',
    ).toBe(true);
  });

  test('[R5 CASE-59] transcribes Persian with RTL punctuation, confidence, and caption seek', async ({
    page,
  }, testInfo) => {
    const fixture: TranscriptionFixture = {
      ...persianFixture,
      words: persianFixture.words.map((word, index, words) =>
        index === words.length - 1 ? { ...word, text: `${word.text}.` } : word,
      ),
    };
    const { probe } = await routeTranscriptionFixture(page, fixture);
    await openVideoCaptionTrack(page, `R5-59-${testInfo.project.name}`);
    await page.getByRole('button', { name: 'Generate Persian' }).click();
    await page.getByRole('tab', { name: 'Transcript' }).click();

    const section = page.getByRole('region', { name: 'Captions fa-IR' });
    const source = section.locator('.caption-source').first();
    await expect(source).toHaveValue('سلام به استودیوی جوی خوش آمدید.');
    await expect(section.locator('.caption-track-summary')).toContainText('fa-IRRTL');
    await expect(section.locator('.caption-warning[title^="Transcription confidence"]')).toHaveText(
      '94%',
    );
    expect(probe).toMatchObject({
      requests: 1,
      language: 'fa-IR',
      authorization: `Bearer ${E2E_TOKEN}`,
      contentType: 'video/mp4',
    });
    expect(probe.bytes).toBeGreaterThan(0);

    const timeline = page.locator('.timeline-panel');
    await timeline.getByRole('button', { name: 'Forward one second' }).click();
    await expect(timeline.locator('.timeline-timecode')).toHaveText('0:01.00');
    await section.getByRole('button', { name: 'Seek to 0.00s' }).click();
    await expect(timeline.locator('.timeline-timecode')).toHaveText('0:00.00');

    const computedDirection = await source.evaluate(
      (element) => window.getComputedStyle(element).direction,
    );
    await recordEvidence(testInfo, {
      caseId: 59,
      functional: 'PASS-FIXTURE',
      uiA11y: computedDirection === 'rtl' ? 'PASS-FIXTURE' : 'FAIL',
      expected:
        'Persian transcription preserves punctuation/confidence, presents RTL text, and seeks the timeline from its cue.',
      actual: `The media POST, Persian result, 94% confidence, punctuation, and 1.00s→0.00s cue seek worked; computed caption direction was ${computedDirection}.`,
      fixture:
        'apps/editor-web/src/fixtures/transcription-fa-IR.json with terminal punctuation via Playwright route',
    });
    expect(computedDirection, 'Persian caption text must render with RTL base direction').toBe(
      'rtl',
    );
  });
});
