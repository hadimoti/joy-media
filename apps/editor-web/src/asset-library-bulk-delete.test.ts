import { describe, expect, it } from 'vitest';
import { summarizeBulkDeleteOutcomes } from './asset-library-bulk-delete.js';

describe('summarizeBulkDeleteOutcomes', () => {
  it('counts a selection where every item was removed', () => {
    expect(
      summarizeBulkDeleteOutcomes([
        { assetId: 'image-a', outcome: 'removed' },
        { assetId: 'image-b', outcome: 'removed' },
      ]),
    ).toMatchObject({
      removedCount: 2,
      absentCount: 0,
      failedCount: 0,
      firstErrorMessage: undefined,
      failedIds: [],
      status: 'Deleted 2 of 2 selected media items.',
    });
  });

  it('counts removed, absent, and failed outcomes independently', () => {
    expect(
      summarizeBulkDeleteOutcomes([
        { assetId: 'image-a', outcome: 'removed' },
        { assetId: 'image-b', outcome: 'absent' },
        { assetId: 'image-c', outcome: 'failed', message: 'Catalog is locked' },
      ]),
    ).toMatchObject({
      removedCount: 1,
      absentCount: 1,
      failedCount: 1,
      firstErrorMessage: 'Catalog is locked',
      failedIds: ['image-c'],
    });
  });

  it('retains every failed asset id for retry in original order', () => {
    expect(
      summarizeBulkDeleteOutcomes([
        { assetId: 'image-a', outcome: 'failed', message: 'first failure' },
        { assetId: 'image-b', outcome: 'removed' },
        { assetId: 'image-c', outcome: 'failed', message: 'second failure' },
      ]).failedIds,
    ).toEqual(['image-a', 'image-c']);
  });

  it('includes the failure count and first error in the status text', () => {
    expect(
      summarizeBulkDeleteOutcomes([
        { assetId: 'image-a', outcome: 'removed' },
        { assetId: 'image-b', outcome: 'failed', message: 'Catalog removal failed' },
        { assetId: 'image-c', outcome: 'failed', message: 'Another failure' },
      ]).status,
    ).toBe('Deleted 1 of 3 selected media items. 2 failed: Catalog removal failed.');
  });
});
