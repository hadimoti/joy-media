import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  assetImportOperationStatus,
  privateBackupBatchStatus,
  refreshCatalogThenReport,
  timelineAssetKind,
} from './AssetLibraryPanel.js';

describe('asset-to-timeline action contract', () => {
  it.each([
    ['video', 'video'],
    ['audio', 'audio'],
  ] as const)('accepts %s assets', (kind, expected) => {
    expect(timelineAssetKind(kind)).toBe(expected);
  });

  it.each(['image', 'model'] as const)('rejects %s assets', (kind) => {
    expect(timelineAssetKind(kind)).toBeUndefined();
  });
});

describe('asset-library privacy operation status', () => {
  it.each([
    ['disabled', 'photo.png is stored locally. Private backup is off for this project.'],
    ['uploaded', 'photo.png is stored locally and backed up privately.'],
    [
      'sync-state-unavailable',
      'photo.png is stored locally. Backup status could not be verified, so no upload was attempted.',
    ],
    ['upload-failed', 'photo.png is stored locally. Private backup failed: store offline'],
  ] as const)(
    'keeps the truthful %s import result after refresh',
    async (backupState, expected) => {
      let visibleStatus = 'importing';
      const refresh = vi.fn(async () => {
        visibleStatus = 'catalog refreshed';
      });
      const report = vi.fn((status: string) => {
        visibleStatus = status;
      });
      const operationStatus = assetImportOperationStatus('photo.png', 'image', {
        backupState,
        ...(backupState === 'upload-failed' ? { backupError: new Error('store offline') } : {}),
      });

      await refreshCatalogThenReport(refresh, report, operationStatus);

      expect(refresh).toHaveBeenCalledOnce();
      expect(report.mock.invocationCallOrder[0]).toBeGreaterThan(
        refresh.mock.invocationCallOrder[0]!,
      );
      expect(visibleStatus).toBe(expected);
    },
  );

  it('restores single and bulk private-backup results after catalog refresh', async () => {
    const statuses: string[] = [];
    const refresh = vi.fn(async () => {
      statuses.push('catalog status');
    });
    const report = (status: string) => statuses.push(status);

    await refreshCatalogThenReport(refresh, report, 'photo.png was backed up privately.');
    await refreshCatalogThenReport(refresh, report, privateBackupBatchStatus(2, 3, 1));

    expect(statuses).toEqual([
      'catalog status',
      'photo.png was backed up privately.',
      'catalog status',
      '2 of 3 selected images were backed up privately. 1 were blocked or failed.',
    ]);
  });

  it('keeps logout/read failures fail-closed and privacy copy local-first', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./AssetLibraryPanel.tsx', import.meta.url)),
      'utf8',
    );

    expect(source).toContain(
      'No media yet. Imports stay in this browser unless private backup is enabled.',
    );
    expect(source).toContain('aria-label="Back up selected images privately"');
    expect(source).not.toContain('Share selected images to cloud');
    expect(source).toMatch(/getStoredMediaToken[\s\S]{0,300}setSyncEnabled\(false\)/);
    expect(source).toMatch(/catch \(error\)[\s\S]{0,180}setSyncEnabled\(false\)/);
  });
});
