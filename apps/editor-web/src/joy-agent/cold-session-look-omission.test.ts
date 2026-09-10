/**
 * P1-R1 — truthful omission reporting for the cold-session `looks` context
 * domain (review corrections 1 & 2).
 *
 * The P1 patch (`070e254c`) added a project-scoped `looks` domain but its
 * sanitizer under-reported: nested caps (`entityBindings`, `controlValues`,
 * `createdEntityIds`, override/missing lists) truncated silently; dropped unsafe
 * list entries were invisible; an over-long identifier was truncated into a
 * *different* id and still surfaced; a malformed runtime shape either threw a
 * `TypeError` or was misread positionally; and a rejected `packTitle` vanished
 * with no signal. A reader could then not tell an *incomplete* projection from
 * an *empty* project.
 *
 * Cases 1-9 fail against `070e254c` and pass after the correction. Case 10 is a
 * hardening guard (the pre-fix `> MAX_LOOK_INSTANCES` count rule already forced
 * the label in that scenario; the fix makes per-chunk preservation explicit).
 *
 * Genuine-reopen cases cross the real persistence → hydration → context → host
 * boundary: a value is written through `EditorSession.synchronizeLookInstances`
 * and read back by a brand-new `EditorSession` before the context is built.
 * Boundary-fuzz cases construct the malformed `JoyAgentContextSnapshotInput`
 * directly — that IS the sanitizer boundary, and such shapes cannot be
 * persisted (`validateLookInstancesDocument` rejects them).
 */

import { describe, expect, it } from 'vitest';
import { buildReferenceSpikeProject } from '@joy-media/test-fixtures';
import { editorialClean } from '@joy-media/motion-core';
import type { LookInstance, LookInstancesDocument } from '@joy-media/project-schema';
import { INITIAL_EDITOR_PROJECT } from '../editor-project.js';
import { EditorSession } from '../editor-session.js';
import {
  createJoyAgentContextSnapshot,
  createJoyAgentPagedContext,
  type JoyAgentContextSnapshotInput,
  type JoyAgentLookInstanceContext,
} from './context-snapshot.js';
import { createJoyAgentHostRpcMethods } from './tool-bridge.js';
import { buildJoyAgentContextInput } from './context-input.js';
import type {
  HostRpcHandlerContext,
  HostRpcJson,
  HostRpcMethod,
  HostRpcMethods,
} from './host-rpc.js';

const PROJECT_ID = buildReferenceSpikeProject().id;

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  };
}

function newSession(store: ReturnType<typeof memoryStorage>) {
  return new EditorSession(store.storage, buildReferenceSpikeProject(), INITIAL_EDITOR_PROJECT);
}

function baseInstance(overrides: Partial<LookInstance> = {}): LookInstance {
  return {
    id: 'look-omit-0001-1111-2222-333333333333',
    definitionId: editorialClean.id,
    definitionVersion: editorialClean.version,
    compositionId: 'root',
    entityBindings: { headline: 'intro-title' },
    controlValues: {},
    overriddenBindingIds: [],
    createdEntityIds: [],
    ...overrides,
  };
}

function lookDoc(instances: readonly LookInstance[]): LookInstancesDocument {
  return {
    id: PROJECT_ID,
    schemaVersion: 1,
    instances: Object.fromEntries(instances.map((i) => [i.id, i])),
  };
}

function handlerContext(): HostRpcHandlerContext {
  return {
    run: { runId: 'omit-run', epoch: 1 },
    requestId: 'req-1',
    signal: new AbortController().signal,
    deadlineAt: Date.now() + 5_000,
  };
}

async function readContext(methods: HostRpcMethods, args: HostRpcJson): Promise<HostRpcJson> {
  const method = methods.read_project_context as unknown as HostRpcMethod<HostRpcJson, HostRpcJson>;
  return method.parseResult(await method.execute(method.parseArgs(args), handlerContext()));
}

/**
 * Reopen from storage bytes and build the host method map a cold run would.
 * The Look projection that lands in the context is the production builder
 * `buildJoyAgentContextInput` — there is no test-local replica. A genuine
 * persistence → hydration → context → host boundary is the only path this
 * suite exercises.
 */
function reopenMethods(store: ReturnType<typeof memoryStorage>): HostRpcMethods {
  const session = newSession(store);
  const input = buildJoyAgentContextInput({ session, selectedClipIds: [], playheadUs: 0 });
  return createJoyAgentHostRpcMethods({ context: createJoyAgentPagedContext(input) });
}

/**
 * Convenience for the cases that want the paged context directly (without
 * the host-RPC layer). Mirrors `reopenMethods` minus the host-method step —
 * still uses the production `buildJoyAgentContextInput`.
 */
function reopenPagedContext(store: ReturnType<typeof memoryStorage>) {
  const session = newSession(store);
  return createJoyAgentPagedContext(
    buildJoyAgentContextInput({ session, selectedClipIds: [], playheadUs: 0 }),
  );
}

const IDENTITY: Pick<JoyAgentContextSnapshotInput, 'projectId' | 'revision'> = {
  projectId: 'local-editor-project',
  revision: 'local-revision:v1:omit:looks=1',
};

function looksRecord(
  overrides: Partial<JoyAgentLookInstanceContext> = {},
): JoyAgentLookInstanceContext {
  return {
    instanceId: 'look-omit-0001-1111-2222-333333333333',
    definitionId: 'editorial-clean',
    definitionVersion: 1,
    compositionId: 'root',
    packStatus: 'known',
    packTitle: 'Editorial Clean',
    packLatestVersion: 1,
    entityBindings: { headline: 'intro-title' },
    missingBindingIds: [],
    orphaned: false,
    overriddenBindingIds: [],
    controlValues: {},
    createdEntityIds: [],
    ...overrides,
  };
}

async function looksPage(methods: HostRpcMethods): Promise<{
  readonly overview: Record<string, HostRpcJson>;
  readonly page: Record<string, HostRpcJson>;
}> {
  const overview = (await readContext(methods, { domain: 'overview' })) as Record<
    string,
    HostRpcJson
  >;
  const page = (await readContext(methods, { domain: 'looks', cursor: 0, pageSize: 32 })) as Record<
    string,
    HostRpcJson
  >;
  return { overview, page };
}

describe('P1-R1 — Look-context omission is truthful', () => {
  it('case 1 — entityBindings beyond the nested cap: truncation is reported (genuine reopen)', () => {
    const store = memoryStorage();
    const bindings: Record<string, string> = {};
    for (let i = 0; i < 40; i += 1) bindings[`b${String(i).padStart(2, '0')}`] = `obj${i}`;
    newSession(store).synchronizeLookInstances(
      lookDoc([baseInstance({ entityBindings: bindings })]),
    );

    const paged = reopenPagedContext(store);
    expect(Object.keys(paged.lookInstances[0]!.entityBindings).length).toBe(32);
    expect(paged.omitted).toContain('lookInstances');
  });

  it('case 2 — controlValues beyond the nested cap: truncation is reported (genuine reopen)', async () => {
    const store = memoryStorage();
    const controlValues: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) controlValues[`c${String(i).padStart(2, '0')}`] = i / 100;
    newSession(store).synchronizeLookInstances(lookDoc([baseInstance({ controlValues })]));

    const { overview, page } = await looksPage(reopenMethods(store));
    expect(overview.lookInstanceCount).toBe(1); // the record itself survives
    expect(overview.omitted).toContain('lookInstances'); // ...but discovery is incomplete
    expect(page.omitted).toContain('lookInstances');
    const items = page.items as Record<string, HostRpcJson>[];
    expect(Object.keys(items[0]!.controlValues as object).length).toBe(32);
  });

  it('case 3 — createdEntityIds beyond the nested cap: truncation is reported (genuine reopen)', () => {
    const store = memoryStorage();
    const createdEntityIds = Array.from({ length: 70 }, (_, i) => `made-${i}`);
    newSession(store).synchronizeLookInstances(lookDoc([baseInstance({ createdEntityIds })]));

    const paged = reopenPagedContext(store);
    expect(paged.lookInstances[0]!.createdEntityIds.length).toBe(64);
    expect(paged.omitted).toContain('lookInstances');
  });

  it('case 4 — a dropped unsafe override entry is reported, not silently filtered', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [
        looksRecord({
          entityBindings: { headline: 'intro-title', accent: 'product-image' },
          overriddenBindingIds: ['headline', 'C:\\Users\\secret\\thing'],
        }),
      ],
    });
    expect(snapshot.lookInstances?.[0]?.overriddenBindingIds).toEqual(['headline']);
    expect(snapshot.omitted).toContain('lookInstances');
  });

  it('case 5 — an over-long identifier is rejected with an omission, never truncated into a different id', () => {
    const longComposition = `root-${'x'.repeat(400)}`;
    const paged = createJoyAgentPagedContext({
      ...IDENTITY,
      lookInstances: [looksRecord({ compositionId: longComposition })],
    });
    // The record is dropped whole — no 128-char slice of `longComposition` is
    // surfaced as if it were the real composition id.
    expect(paged.lookInstances).toEqual([]);
    expect(paged.omitted).toContain('lookInstances');
    expect(JSON.stringify(paged.lookInstances)).not.toContain('xxxx');
  });

  it('case 6 — a truncated binding target is dropped (with omission); the rest of the record survives', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [
        looksRecord({
          entityBindings: {
            headline: 'intro-title',
            accent: `entity-${'y'.repeat(400)}`,
          },
        }),
      ],
    });
    expect(snapshot.lookInstances?.[0]?.entityBindings).toEqual({ headline: 'intro-title' });
    expect(snapshot.omitted).toContain('lookInstances');
    expect(JSON.stringify(snapshot.lookInstances)).not.toContain('yyyy');
  });

  it('case 7 — a malformed list shape does not throw; it is reported and neutralised', () => {
    const build = () =>
      createJoyAgentPagedContext({
        ...IDENTITY,
        lookInstances: [looksRecord({ overriddenBindingIds: 'headline' as unknown as string[] })],
      });
    expect(build).not.toThrow();
    const paged = build();
    expect(paged.lookInstances[0]!.overriddenBindingIds).toEqual([]);
    expect(paged.omitted).toContain('lookInstances');
  });

  it('case 8 — a map field supplied as an array is reported, not read positionally', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [
        looksRecord({
          entityBindings: ['intro-title', 'product-image'] as unknown as Record<string, string>,
        }),
      ],
    });
    expect(snapshot.lookInstances?.[0]?.entityBindings).toEqual({});
    expect(snapshot.lookInstances?.[0]?.instanceId).toBe('look-omit-0001-1111-2222-333333333333');
    expect(snapshot.omitted).toContain('lookInstances');
  });

  it('case 9 — a rejected packTitle is reported, not silently dropped', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [looksRecord({ packTitle: 'C:\\Users\\secret\\pack' })],
    });
    expect(snapshot.lookInstances?.[0]).not.toHaveProperty('packTitle');
    expect(JSON.stringify(snapshot.lookInstances)).not.toContain('C:\\Users');
    expect(snapshot.omitted).toContain('lookInstances');
  });

  it('case 10 (hardening) — a field truncated only in a later page chunk is still reported', () => {
    // 66 pristine instances; only the two in the second chunk carry an
    // over-cap controlValues map. Every chunk's omission is preserved.
    const controlValues: Record<string, number> = {};
    for (let i = 0; i < 40; i += 1) controlValues[`c${String(i).padStart(2, '0')}`] = i;
    const instances = Array.from({ length: 66 }, (_, i) =>
      looksRecord({
        instanceId: `look-omit-${String(i).padStart(4, '0')}-1111-2222-333333333333`,
        ...(i >= 64 ? { controlValues } : {}),
      }),
    );
    const paged = createJoyAgentPagedContext({ ...IDENTITY, lookInstances: instances });
    expect(paged.lookInstances.length).toBe(66);
    expect(paged.omitted).toContain('lookInstances');

    // Control: exactly 64 pristine instances raise no Look omission at all.
    const pristine = Array.from({ length: 64 }, (_, i) =>
      looksRecord({
        instanceId: `look-omit-${String(i).padStart(4, '0')}-1111-2222-333333333333`,
      }),
    );
    const clean = createJoyAgentPagedContext({ ...IDENTITY, lookInstances: pristine });
    expect(clean.lookInstances.length).toBe(64);
    expect(clean.omitted).not.toContain('lookInstances');
  });

  it('case 11 — oversized input: the serialized byte and record caps hold with a report', async () => {
    // 5000 well-formed records (> JOY_AGENT_HOST_CONTEXT_MAX_RECORDS = 4096, and
    // far past the 60 000-byte model-snapshot budget).
    const instances = Array.from({ length: 5_000 }, (_, i) =>
      looksRecord({
        instanceId: `look-omit-${String(i).padStart(6, '0')}-2222-333333333333`,
      }),
    );
    const paged = createJoyAgentPagedContext({ ...IDENTITY, lookInstances: instances });
    // model snapshot: byte-bounded at MAX_CONTEXT_BYTES (60_000)
    expect(Buffer.byteLength(JSON.stringify(paged.snapshot), 'utf8')).toBeLessThanOrEqual(60_000);
    expect((paged.snapshot.lookInstances ?? []).length).toBeLessThan(5_000);
    // host paged view: hard record cap
    expect(paged.lookInstances.length).toBeLessThanOrEqual(4_096);
    // Every individual host page must fit the real transport byte cap
    // (HOST_RPC_MAX_PAYLOAD_BYTES = 65 536). Page size defaults to 32 in
    // `tool-bridge.ts` (`MAX_HOST_PAGE_SIZE = 32`); the transport enforces the
    // cap per page, not over the entire retained array. Build the per-page
    // payload the same way the host RPC publishes it and assert each one fits.
    const methods = createJoyAgentHostRpcMethods({ context: paged });
    const pageSize = 32;
    let cursor = 0;
    let observedPages = 0;
    for (let guard = 0; guard < 1_000; guard += 1) {
      const page = (await readContext(methods, {
        domain: 'looks',
        cursor,
        pageSize,
      })) as Record<string, HostRpcJson>;
      observedPages += 1;
      const items = page.items as Record<string, HostRpcJson>[];
      expect(items.length).toBeLessThanOrEqual(pageSize);
      // The byte cap is a *response* cap, not a per-item cap. Assert it on
      // the published page envelope.
      expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(65_536);
      if (page.nextCursor === undefined) break;
      cursor = page.nextCursor as number;
    }
    expect(observedPages).toBeGreaterThan(1);
    expect(paged.omitted).toEqual(
      expect.arrayContaining(['lookInstances', 'host-look-instances-cap']),
    );
  });

  it('case 12 (Rem 1 boundary) — every nested Look cap reports the reserved omission label, including text-length rejection', () => {
    // Pack title that exceeds the 160-char cap must be rejected (not silently
    // truncated into a different string). Previously `safeText` would slice it
    // down and surface the truncated fragment as if it were the real title.
    const overLongPackTitle = `Editorial Clean ${'x'.repeat(200)}`;
    // Control-values *text* value that exceeds the 120-char cap must be
    // rejected too — `safeText` previously truncated it; the boundary-aware
    // helper now refuses it so a reader can tell an incomplete projection
    // from an empty one.
    const overLongControlText = `label ${'y'.repeat(200)}`.trim();
    const tooManyOverrides = Array.from({ length: 70 }, (_, i) => `binding-${i}`);
    // `sanitizeLookIdList` filters `missingBindingIds` against the known
    // binding-id set (a model-facing missing-id that isn't in `entityBindings`
    // is dropped as redundant). Generate the missing ids from the actual
    // binding keys so the truncation behavior is observable in the snapshot.
    const knownBindingKeys = Array.from({ length: 41 }, (_, i) => `b${String(i).padStart(2, '0')}`);
    const tooManyMissing = Array.from({ length: 40 }, (_, i) => knownBindingKeys[i]!);

    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [
        looksRecord({
          // 41 bindings — over MAX_LOOK_BINDINGS = 32.
          entityBindings: Object.fromEntries(knownBindingKeys.map((key, i) => [key, `obj-${i}`])),
          // 40 controls (over MAX_LOOK_CONTROL_VALUES = 32) — the LAST entry is
          // a text value that is also over the 120-char cap. Both must be
          // reported.
          controlValues: {
            ...Object.fromEntries(
              Array.from({ length: 39 }, (_, i) => [`c${String(i).padStart(2, '0')}`, i / 100]),
            ),
            accent: overLongControlText,
          },
          overriddenBindingIds: tooManyOverrides,
          missingBindingIds: tooManyMissing,
          packTitle: overLongPackTitle,
        }),
      ],
    });

    // Every field that triggered a cap reports the reserved `'lookInstances'`
    // label exactly once, in the projection's `omitted` array.
    expect(snapshot.omitted).toContain('lookInstances');

    const kept = snapshot.lookInstances?.[0] as Record<string, unknown> | undefined;
    expect(kept).toBeDefined();
    // No truncated pack title leaks back as the model-facing string.
    expect(JSON.stringify(snapshot)).not.toContain('xxxx');
    // No truncated control text leaks back as the model-facing string.
    expect(JSON.stringify(snapshot)).not.toContain('yyyy');
    // Numeric controls survive; the over-cap text entry is dropped.
    expect(Object.keys((kept as { controlValues: Record<string, unknown> }).controlValues)).toEqual(
      Array.from({ length: 32 }, (_, i) => `c${String(i).padStart(2, '0')}`),
    );
    expect((kept as { controlValues: Record<string, unknown> }).controlValues).not.toHaveProperty(
      'accent',
    );
    // Overrides and missing lists truncate to their caps.
    expect((kept as { overriddenBindingIds: unknown[] }).overriddenBindingIds).toHaveLength(64);
    expect((kept as { missingBindingIds: unknown[] }).missingBindingIds).toHaveLength(32);
    // Pack title is dropped entirely when it does not fit — the helper does
    // not surface a shortened fragment in its place.
    expect(kept).not.toHaveProperty('packTitle');
    expect(JSON.stringify(snapshot)).not.toContain(overLongPackTitle);
  });
});

/**
 * P1-R2 — discriminating tests for the text-omission repair (review
 * correction 3). Each branch of `safeTextReporting` is exercised in
 * isolation so the omission label is attributable to a single input shape.
 * The previous helper dropped non-string, blank/trimmed-empty, and
 * whitespace-only values without recording the `lookInstances` omission —
 * a silent loss indistinguishable from an empty project. These cases pin
 * every branch independently.
 *
 * Every fixture below uses a *pristine* enclosing record (first 32 controls,
 * one well-formed binding, valid id/version, known pack status) so any
 * emitted `lookInstances` label can only come from the targeted text field.
 * "Deliberately malformed" raw fixtures here refer only to the intentionally
 * bad values under test, never to the surrounding record.
 */
describe('P1-R2 — safeTextReporting branches report omission independently', () => {
  // 121-char value: one over the 120-char cap for control text.
  const OVERLONG_CONTROL_TEXT = `label ${'y'.repeat(120)}`;
  // 161-char value: one over the 160-char cap for pack title.
  const OVERLONG_PACK_TITLE = `Editorial Clean ${'x'.repeat(160)}`;
  // 120-char control value that sits exactly on the cap and must survive.
  const BOUNDARY_CONTROL_TEXT = `b ${'y'.repeat(118)}`; // length 120 after trim
  // 160-char pack title that sits exactly on the cap and must survive.
  const BOUNDARY_PACK_TITLE = `T ${'x'.repeat(158)}`; // length 160 after trim

  function pristineRecord(
    overrides: Partial<JoyAgentLookInstanceContext> = {},
  ): JoyAgentLookInstanceContext {
    // Exactly 32 control entries (the cap). Any text branch added below
    // is targeted at one specific key so the omission label is attributable
    // to that branch and nothing else.
    const controlValues: Record<string, number | string | boolean> = {};
    for (let i = 0; i < 32; i += 1) controlValues[`c${String(i).padStart(2, '0')}`] = i / 100;
    return looksRecord({
      entityBindings: { headline: 'intro-title' },
      controlValues,
      packTitle: 'Editorial Clean',
      ...overrides,
    });
  }

  it('overlength control text inside the first 32 controls: omission reported, entry dropped, no fragment leaks', () => {
    // Exactly 32 control entries total; the overlength text REPLACES one of
    // them so the entries-cap branch never fires. Any omission must come
    // from the `safeTextReporting` overlength branch on the text value.
    const controlValues: Record<string, number | string | boolean> = {};
    for (let i = 0; i < 31; i += 1) controlValues[`c${String(i).padStart(2, '0')}`] = i / 100;
    controlValues.accent = OVERLONG_CONTROL_TEXT;

    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [pristineRecord({ controlValues, packTitle: 'Editorial Clean' })],
    });
    const kept = snapshot.lookInstances?.[0] as
      { controlValues: Record<string, unknown>; packTitle?: string } | undefined;
    expect(kept).toBeDefined();
    // The overlength text entry must be dropped — never a shortened fragment.
    expect(kept!.controlValues).not.toHaveProperty('accent');
    expect(Object.keys(kept!.controlValues)).toHaveLength(31);
    // Surrounding controls are untouched.
    expect(kept!.controlValues.c00).toBe(0);
    expect(kept!.controlValues.c30).toBe(30 / 100);
    // The omitted label is set for the overlength branch.
    expect(snapshot.omitted).toContain('lookInstances');
    // No `yyyy…` fragment of the overlength text leaks back to the reader.
    expect(JSON.stringify(snapshot)).not.toContain('yyyy');
  });

  it('overlength pack title on an otherwise pristine record: omission reported, field dropped', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [pristineRecord({ packTitle: OVERLONG_PACK_TITLE })],
    });
    const kept = snapshot.lookInstances?.[0] as Record<string, unknown> | undefined;
    expect(kept).toBeDefined();
    // The pack title must be dropped — never surfaced as a 160-char slice.
    expect(kept).not.toHaveProperty('packTitle');
    expect(snapshot.omitted).toContain('lookInstances');
    expect(JSON.stringify(snapshot)).not.toContain(OVERLONG_PACK_TITLE);
    expect(JSON.stringify(snapshot)).not.toContain('xxxx');
  });

  it('malformed (non-string) control value: omission reported, no throw, entry dropped', () => {
    // Exactly 32 control entries total; the malformed value REPLACES one of
    // them so the entries-cap branch never fires. Any omission must come
    // from the `safeTextReporting` text branch on the malformed value.
    const controlValues: Record<string, number | string | boolean> = {};
    for (let i = 0; i < 31; i += 1) controlValues[`c${String(i).padStart(2, '0')}`] = i / 100;
    controlValues.accent = { nested: 'object' } as unknown as number; // deliberately malformed

    const build = () =>
      createJoyAgentContextSnapshot({
        ...IDENTITY,
        lookInstances: [pristineRecord({ controlValues, packTitle: 'Editorial Clean' })],
      });
    expect(build).not.toThrow();
    const snapshot = build();
    const kept = snapshot.lookInstances?.[0] as
      { controlValues: Record<string, unknown> } | undefined;
    expect(kept).toBeDefined();
    expect(kept!.controlValues).not.toHaveProperty('accent');
    expect(Object.keys(kept!.controlValues)).toHaveLength(31);
    expect(snapshot.omitted).toContain('lookInstances');
  });

  it('blank (empty / whitespace-only) control value: omission reported, entry dropped', () => {
    // Exactly 32 control entries total; the whitespace value REPLACES one of
    // them so the entries-cap branch never fires.
    const controlValues: Record<string, number | string | boolean> = {};
    for (let i = 0; i < 31; i += 1) controlValues[`c${String(i).padStart(2, '0')}`] = i / 100;
    controlValues.accent = '   '; // whitespace-only — must be reported, not silently lost

    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [pristineRecord({ controlValues, packTitle: 'Editorial Clean' })],
    });
    const kept = snapshot.lookInstances?.[0] as
      { controlValues: Record<string, unknown> } | undefined;
    expect(kept).toBeDefined();
    expect(kept!.controlValues).not.toHaveProperty('accent');
    expect(snapshot.omitted).toContain('lookInstances');
  });

  it('malformed (non-string) packTitle: omission reported, field dropped', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [pristineRecord({ packTitle: 12345 as unknown as string })],
    });
    const kept = snapshot.lookInstances?.[0] as Record<string, unknown> | undefined;
    expect(kept).toBeDefined();
    expect(kept).not.toHaveProperty('packTitle');
    expect(snapshot.omitted).toContain('lookInstances');
  });

  it('blank (empty / whitespace-only) packTitle: omission reported, field dropped', () => {
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [pristineRecord({ packTitle: '   \t  ' })],
    });
    const kept = snapshot.lookInstances?.[0] as Record<string, unknown> | undefined;
    expect(kept).toBeDefined();
    expect(kept).not.toHaveProperty('packTitle');
    expect(snapshot.omitted).toContain('lookInstances');
  });

  it('valid boundary-length control text (120 chars) survives without an omission label', () => {
    // Sanity-check the boundary so a future over-tightening of the cap is caught.
    expect(BOUNDARY_CONTROL_TEXT.length).toBe(120);
    const controlValues: Record<string, number | string | boolean> = {};
    for (let i = 0; i < 31; i += 1) controlValues[`c${String(i).padStart(2, '0')}`] = i / 100;
    controlValues.accent = BOUNDARY_CONTROL_TEXT; // exactly 120 chars

    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [pristineRecord({ controlValues, packTitle: 'Editorial Clean' })],
    });
    const kept = snapshot.lookInstances?.[0] as
      { controlValues: Record<string, unknown>; packTitle?: string } | undefined;
    expect(kept).toBeDefined();
    expect(kept!.controlValues.accent).toBe(BOUNDARY_CONTROL_TEXT);
    expect(kept!.packTitle).toBe('Editorial Clean');
    expect(snapshot.omitted).not.toContain('lookInstances');
  });

  it('valid boundary-length packTitle (160 chars) survives without an omission label', () => {
    expect(BOUNDARY_PACK_TITLE.length).toBe(160);
    const snapshot = createJoyAgentContextSnapshot({
      ...IDENTITY,
      lookInstances: [pristineRecord({ packTitle: BOUNDARY_PACK_TITLE })],
    });
    const kept = snapshot.lookInstances?.[0] as Record<string, unknown> | undefined;
    expect(kept).toBeDefined();
    expect(kept!.packTitle).toBe(BOUNDARY_PACK_TITLE);
    expect(snapshot.omitted).not.toContain('lookInstances');
  });
});
