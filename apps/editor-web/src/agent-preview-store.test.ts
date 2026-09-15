import { describe, expect, it } from 'vitest';
import { createAgentPreviewStore, isAgentPreviewBundleReady } from './agent-preview-store.js';

describe('agent preview store', () => {
  it('publishes a fully prepared dual-surface bundle exactly once', () => {
    const store = createAgentPreviewStore();
    const snapshots: ReturnType<typeof store.getState>[] = [];
    store.subscribe(() => snapshots.push(store.getState()));

    const bundle = store.publish({
      runId: 'run-1',
      baseRevision: 'rev-1',
      timeline: {
        canonical: { clips: [] },
        preview: { clips: [{ id: 'c1', trackId: 't1', startUs: 0, durationUs: 1 }] },
      },
      document: {
        canonical: { id: 'project-1', title: 'canonical' } as never,
        preview: { id: 'project-1', title: 'staged' } as never,
      },
    });

    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.timeline?.preview.clips).toHaveLength(1);
    expect(snapshots[0]?.document?.preview).toEqual({ id: 'project-1', title: 'staged' });
    expect(snapshots[0]?.timeline?.bundleVersion).toBe(bundle.version);
    expect(snapshots[0]?.document?.bundleVersion).toBe(bundle.version);
    expect(snapshots[0]?.timeline).toBe(bundle.timeline);
    expect(snapshots[0]?.document).toBe(bundle.document);
    expect(store.getBundle()).toBe(bundle);
    expect(isAgentPreviewBundleReady(bundle)).toBe(false);

    store.clear('other-run');
    expect(store.getState().timeline?.runId).toBe('run-1');
    store.clear('run-1');
    expect(store.getState()).toEqual({ timeline: undefined, document: undefined });
    expect(store.getBundle()).toBeUndefined();
  });

  it('defensively isolates and deeply freezes every published plain-data surface', () => {
    const store = createAgentPreviewStore();
    const timelineCanonical = {
      clips: [
        {
          id: 'canonical-clip',
          trackId: 'track-1',
          startUs: 0,
          durationUs: 1,
          effectIds: ['effect-a'],
          properties: { opacity: 1 },
        },
      ],
    };
    const timelinePreview = {
      clips: [
        {
          id: 'preview-clip',
          trackId: 'track-1',
          startUs: 2,
          durationUs: 3,
          effectIds: ['effect-b'],
          properties: { opacity: 0.5 },
        },
      ],
    };
    const documentCanonical = { id: 'project-2', pluginData: { nested: { value: 'before' } } };
    const documentPreview = { id: 'project-2', pluginData: { nested: { value: 'after' } } };

    const bundle = store.publish({
      runId: 'run-2',
      baseRevision: 'rev-2',
      timeline: { canonical: timelineCanonical, preview: timelinePreview },
      document: { canonical: documentCanonical as never, preview: documentPreview as never },
    });

    timelineCanonical.clips[0]!.properties.opacity = 0;
    timelinePreview.clips[0]!.effectIds[0] = 'mutated-effect';
    documentCanonical.pluginData.nested.value = 'mutated-before';
    documentPreview.pluginData.nested.value = 'mutated-after';

    const state = store.getState();
    const storedTimeline = state.timeline!;
    const storedDocument = state.document!;
    const storedPreviewDocument = storedDocument.preview as unknown as {
      readonly pluginData: { readonly nested: { readonly value: string } };
    };

    expect(storedTimeline.canonical.clips[0]?.properties?.opacity).toBe(1);
    expect(storedTimeline.preview.clips[0]?.effectIds?.[0]).toBe('effect-b');
    expect(storedPreviewDocument.pluginData.nested.value).toBe('after');
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(bundle)).toBe(true);
    expect(Object.isFrozen(bundle.readiness)).toBe(true);
    expect(Object.isFrozen(storedTimeline.preview)).toBe(true);
    expect(Object.isFrozen(storedTimeline.preview.clips)).toBe(true);
    expect(Object.isFrozen(storedTimeline.preview.clips[0]!)).toBe(true);
    expect(Object.isFrozen(storedPreviewDocument.pluginData.nested)).toBe(true);

    expect(() => {
      (storedTimeline.preview.clips[0]!.properties as { opacity: number }).opacity = 0;
    }).toThrow(TypeError);
    expect(() => {
      (
        storedPreviewDocument as unknown as {
          pluginData: { nested: { value: string } };
        }
      ).pluginData.nested.value = 'tampered';
    }).toThrow(TypeError);
  });

  it('acknowledges only mapped surfaces without blocking or republishing unmapped ones', () => {
    const store = createAgentPreviewStore();
    let notifications = 0;
    store.subscribe(() => {
      notifications += 1;
    });
    const published = store.publish({
      runId: 'run-3',
      baseRevision: 'rev-3',
      timeline: {
        canonical: { clips: [] },
        preview: { clips: [] },
      },
    });

    expect(published.readiness).toEqual({ timeline: 'pending', document: 'unmapped' });
    expect(notifications).toBe(1);
    expect(isAgentPreviewBundleReady(published)).toBe(false);
    expect(isAgentPreviewBundleReady(undefined)).toBe(false);

    store.acknowledgeRender('run-3', published.version, 'document');
    store.acknowledgeRender('other-run', published.version, 'timeline');
    store.acknowledgeRender('run-3', published.version + 1, 'timeline');
    expect(notifications).toBe(1);
    expect(store.getBundle()).toBe(published);

    store.acknowledgeRender('run-3', published.version, 'timeline');
    const acknowledged = store.getBundle()!;
    expect(notifications).toBe(2);
    expect(acknowledged.version).toBe(published.version);
    expect(acknowledged.timeline).toBe(published.timeline);
    expect(acknowledged.readiness).toEqual({ timeline: 'acknowledged', document: 'unmapped' });
    expect(Object.isFrozen(acknowledged.readiness)).toBe(true);
    expect(isAgentPreviewBundleReady(acknowledged)).toBe(true);

    store.acknowledgeRender('run-3', published.version, 'timeline');
    expect(notifications).toBe(2);
  });

  it('refuses a late acknowledgement from an earlier bundle with the same run ID', () => {
    const store = createAgentPreviewStore();
    const initial = store.publish({
      runId: 'run-4',
      baseRevision: 'rev-4',
      timeline: { canonical: { clips: [] }, preview: { clips: [] } },
    });
    const replacement = store.publish({
      runId: 'run-4',
      baseRevision: 'rev-4',
      timeline: { canonical: { clips: [] }, preview: { clips: [] } },
    });

    store.acknowledgeRender('run-4', initial.version, 'timeline');
    expect(store.getBundle()).toBe(replacement);
    expect(store.getBundle()?.readiness.timeline).toBe('pending');

    store.acknowledgeRender('run-4', replacement.version, 'timeline');
    expect(store.getBundle()?.readiness.timeline).toBe('acknowledged');
  });
});
