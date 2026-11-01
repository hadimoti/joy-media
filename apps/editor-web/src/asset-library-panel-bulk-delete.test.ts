import { describe, expect, it } from 'vitest';
import { formatBulkDeleteStatus } from './AssetLibraryPanel.js';

describe('formatBulkDeleteStatus', () => {
  it('reports removed and already-absent items without implying an error', () => {
    expect(formatBulkDeleteStatus(1, 2, 0, undefined)).toBe('Deleted 1 of 2 selected media items.');
  });

  it('reports failed items and the first error after the removed count', () => {
    expect(formatBulkDeleteStatus(1, 2, 1, 'Catalog removal failed')).toBe(
      'Deleted 1 of 2 selected media items. 1 failed: Catalog removal failed.',
    );
  });
});
