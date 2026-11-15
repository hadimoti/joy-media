import assert from 'node:assert/strict';
import test from 'node:test';
import { isAppEditorUrl } from './driver.mjs';

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
