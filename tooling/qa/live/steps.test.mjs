import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePage } from './fake-page.mjs';
import { importThroughLeftPanel } from './steps.mjs';

function importPage({ mediaAppearsOnAttempt = 2 } = {}) {
  let mediaWaits = 0;
  const page = createFakePage({
    answers: ({ path, method, fn }) => {
      if (method === 'evaluate' && fn === 'readOpenMenu') {
        return { open: true, group: 'View', items: [{ label: 'Create' }] };
      }
      if (path.includes('data-feature-tool') && path.includes('media') && method === 'isVisible')
        return false;
      if (path.includes('data-feature-tool') && path.includes('media') && method === 'waitFor') {
        mediaWaits += 1;
        if (mediaWaits < mediaAppearsOnAttempt) throw new Error('Media is not visible yet');
      }
      if (path.includes('.panel-tab') && method === 'evaluateAll') return ['Enhance'];
      return undefined;
    },
  });
  return { page, mediaWaits: () => mediaWaits };
}

test('left-panel import repeats View > Create when Media does not appear within three seconds', async () => {
  const { page, mediaWaits } = importPage({ mediaAppearsOnAttempt: 2 });

  await importThroughLeftPanel(page, 'fixture.mp4');

  assert.equal(mediaWaits(), 2);
  assert.equal(page.calls.filter((call) => call.includes('Create')).length >= 2, true);
  assert.ok(page.calls.some((call) => call.includes('Confirm import')));
});

test('left-panel import reports visible dock tab names after both Create attempts fail', async () => {
  const { page, mediaWaits } = importPage({ mediaAppearsOnAttempt: 3 });

  await assert.rejects(
    importThroughLeftPanel(page, 'fixture.mp4'),
    /Media tab did not appear after View > Create twice; visible dock tabs: Enhance/u,
  );

  assert.equal(mediaWaits(), 2);
});
