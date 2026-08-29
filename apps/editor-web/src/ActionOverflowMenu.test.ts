import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionOverflowMenu } from './ActionOverflowMenu.js';

describe('timeline overflow contract', () => {
  it('documents the stable priority order for compact panels', () => {
    expect(['add-track', 'marker', 'duplicate', 'delete', 'flow']).toEqual([
      'add-track',
      'marker',
      'duplicate',
      'delete',
      'flow',
    ]);
  });

  it('keeps the compact overflow trigger visibly discoverable', () => {
    const markup = renderToStaticMarkup(createElement(ActionOverflowMenu, { items: [] }));

    expect(markup).toContain('action-overflow-trigger-label');
    expect(markup).toContain('>More</span>');
    expect(markup).toContain('aria-label="More timeline actions"');
  });
});
