import { describe, expect, it } from 'vitest';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';
import type { ControlPlaneProjectBinding } from './project-control-plane.js';
import { coordinateJoyCodePlan } from './joy-code-request-coordinator.js';

const document: JoyProjectV1 = { schemaVersion: 1, id: 'editor-1', title: 'Project', createdAt: '2026-08-20T00:00:00.000Z', updatedAt: '2026-08-20T00:00:00.000Z', rootCompositionId: 'c', settings: { defaultLocale: 'en' }, compositions: { c: { id: 'c', name: 'Main', width: 1920, height: 1080, pixelAspectRatio: { num: 1, den: 1 }, frameRate: { num: 30, den: 1 }, durationUs: 1_000_000, background: '#00000000', tracks: [] } }, assets: {}, variables: {}, markers: [], visualObjects: {}, captionDocuments: {}, pluginData: {} };
const binding: ControlPlaneProjectBinding = { editorProjectId: 'editor-1', controlPlaneProjectId: 'control-1', title: 'Project' };
const storage: BrowserKeyValueStore = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
const request = { projectId: 'editor-1', snapshotRevisionId: 'rev-1', prompt: 'trim', selection: { clipIds: [] } };

describe('Joy Code request coordinator', () => {
  it('rejects parity mismatch without syncing or calling the planner', async () => {
    let calls = 0;
    const result = await coordinateJoyCodePlan(binding, document, 'rev-1', { ...request, projectId: 'other' }, storage, async () => { calls += 1; return { projectId: 'control-1', revisionId: 'rev-1' }; }, async () => { calls += 1; throw new Error('should not call'); });
    expect(result.kind).toBe('parity-failure'); expect(calls).toBe(0);
  });
  it('maps sync conflict to stale and never calls the planner', async () => {
    let called = false;
    const result = await coordinateJoyCodePlan(binding, document, 'rev-1', request, storage, async () => { const error = Object.assign(new Error('stale'), { status: 409, code: 'DOCUMENT_REVISION_CONFLICT' }); throw error; }, async () => { called = true; throw new Error('should not call'); });
    expect(result.kind).toBe('stale'); expect(called).toBe(false);
  });
});
