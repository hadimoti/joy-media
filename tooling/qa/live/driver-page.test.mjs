import assert from 'node:assert/strict';
import test from 'node:test';
import { join } from 'node:path';
import { isAppEditorUrl, keepDownloadsInScratch } from './driver.mjs';

test('the editor page is the one on the app scheme', () => {
  assert.equal(isAppEditorUrl('joy-media-app://renderer/index.html'), true);
});

test('the loading window, devtools and blank pages are not the editor', () => {
  assert.equal(isAppEditorUrl('data:text/html;charset=utf-8,%3C!doctype%20html%3E'), false);
  assert.equal(isAppEditorUrl('devtools://devtools/bundled/inspector.html'), false);
  assert.equal(isAppEditorUrl('about:blank'), false);
  assert.equal(isAppEditorUrl(''), false);
  assert.equal(isAppEditorUrl(undefined), false);
});

test('a download the page receives is saved into the scratch download folder under its own file name', async () => {
  const handlers = {};
  const page = {
    on(event, handler) {
      handlers[event] = handler;
    },
  };
  keepDownloadsInScratch(page, 'C:\\scratch\\profile\\downloads');
  const saved = [];
  await handlers.download({
    suggestedFilename: () => '..\\..\\evil\\joy-media-export-1.mp4',
    saveAs: async (path) => saved.push(path),
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0], join('C:\\scratch\\profile\\downloads', 'joy-media-export-1.mp4'));
});
