# Review package: 8a9d629..bd35ab8

## Commits
bd35ab8 feat(workflows): add durable visual candidate approvals

## Files changed
 apps/editor-web/src/ContactSheetApproval.test.tsx  | 236 +++++++++
 apps/editor-web/src/ContactSheetApproval.tsx       | 556 +++++++++++++++++++++
 apps/editor-web/src/ProductionBoardPanel.tsx       |  87 ++--
 apps/editor-web/src/WorkflowsPanel.tsx             | 102 +---
 .../editor-web/src/browser-production-run-store.ts |  13 +-
 apps/editor-web/src/workflow-runner.ts             |  15 +
 packages/workflow-engine/src/production-run.ts     |  43 +-
 7 files changed, 918 insertions(+), 134 deletions(-)

## Diff
diff --git a/apps/editor-web/src/ContactSheetApproval.test.tsx b/apps/editor-web/src/ContactSheetApproval.test.tsx
new file mode 100644
index 0000000..a022c27
--- /dev/null
+++ b/apps/editor-web/src/ContactSheetApproval.test.tsx
@@ -0,0 +1,236 @@
+import { renderToStaticMarkup } from 'react-dom/server';
+import { describe, expect, it } from 'vitest';
+import type { HumanInputRequest } from '@joy-media/workflow-engine';
+import {
+  ContactSheetApproval,
+  contactSheetApprovalDecisionFor,
+  contactSheetApprovalItemsFor,
+  contactSheetResponseIdFor,
+  initialContactSheetSelectedKeys,
+  nextContactSheetActiveIndex,
+  readContactSheetPersistedState,
+  toggleContactSheetSelection,
+} from './ContactSheetApproval.js';
+
+describe('ContactSheetApproval', () => {
+  it('renders thumbnail-backed candidates with extracted time ranges and selection count', () => {
+    const request = chooseCandidatesRequest();
+    const items = contactSheetApprovalItemsFor(request);
+    const markup = renderToStaticMarkup(
+      <ContactSheetApproval request={request} onSubmit={() => undefined} />,
+    );
+
+    expect(items.slice(0, 2)).toMatchObject([
+      {
+        key: 'candidate-a',
+        title: 'Hook A',
+        assetId: 'asset-a',
+        thumbnailRef: 'thumb-a.jpg',
+        startUs: 1_000_000,
+        endUs: 3_500_000,
+      },
+      {
+        key: 'candidate-b',
+        title: 'Hook B',
+        assetId: 'asset-b',
+        thumbnailRef: 'thumb-b.jpg',
+        startUs: 4_000_000,
+        endUs: 5_500_000,
+      },
+    ]);
+    expect(markup).toContain('Choose your hook shots');
+    expect(markup).toContain('2 of 3 selected');
+    expect(markup).toContain('thumb-a.jpg');
+    expect(markup).toContain('0:01-0:04');
+    expect(markup).toContain('0:04-0:06');
+  });
+
+  it('renders approve-render reviews with compare affordance and diff-backed items', () => {
+    const request: HumanInputRequest = {
+      kind: 'approve-render',
+      prompt: 'Review final render candidates',
+      payload: {
+        items: [
+          {
+            id: 'render-a',
+            title: 'Render A',
+            assetId: 'render-asset-a',
+            thumbnailRef: 'render-a.jpg',
+            startUs: 12_000_000,
+            endUs: 14_500_000,
+            diff: { changedPixels: 42 },
+          },
+        ],
+      },
+    };
+
+    const items = contactSheetApprovalItemsFor(request);
+    const markup = renderToStaticMarkup(
+      <ContactSheetApproval request={request} onSubmit={() => undefined} />,
+    );
+
+    expect(items[0]?.diff).toEqual({ changedPixels: 42 });
+    expect(markup).toContain('Compare');
+    expect(markup).toContain('Review final render candidates');
+    expect(markup).toContain('render-a.jpg');
+    expect(markup).toContain('0:12-0:15');
+  });
+
+  it('defaults selections from response data and persisted reload state', () => {
+    const request = chooseCandidatesRequest();
+    const items = contactSheetApprovalItemsFor(request);
+    const responseSelected = initialContactSheetSelectedKeys(
+      request,
+      items,
+      { candidates: [rawCandidate('candidate-c', 'Hook C', 7_000_000, 8_000_000)] },
+      undefined,
+    );
+    expect(responseSelected).toEqual(['candidate-c']);
+
+    const storage = memoryStorage({
+      'joy-media.contact-sheet-approval:approval-1': JSON.stringify({
+        selectedKeys: ['candidate-b'],
+        activeIndex: 1,
+        compareKey: 'candidate-c',
+        rejectionReason: 'Need safer opening',
+      }),
+    });
+    expect(readContactSheetPersistedState(storage, 'approval-1')).toEqual({
+      selectedKeys: ['candidate-b'],
+      activeIndex: 1,
+      compareKey: 'candidate-c',
+      rejectionReason: 'Need safer opening',
+    });
+    expect(
+      initialContactSheetSelectedKeys(request, items, undefined, {
+        selectedKeys: ['candidate-b'],
+      }),
+    ).toEqual(['candidate-b']);
+  });
+
+  it('validates approve-none and reject-without-reason decisions', () => {
+    expect(
+      contactSheetApprovalDecisionFor('approve', {
+        kind: 'choose-candidates',
+        approvalId: 'approval-1',
+        selectedItems: [],
+      }),
+    ).toEqual({
+      ok: false,
+      validation: 'Select at least one item to approve, or reject with a reason.',
+    });
+
+    expect(
+      contactSheetApprovalDecisionFor('reject', {
+        kind: 'choose-candidates',
+        approvalId: 'approval-1',
+        selectedItems: [],
+        rejectionReason: '   ',
+      }),
+    ).toEqual({
+      ok: false,
+      validation: 'Add a rejection reason before rejecting.',
+    });
+  });
+
+  it('binds response ids to exact approved and rejected payloads', () => {
+    const selectedItems = contactSheetApprovalItemsFor(chooseCandidatesRequest()).slice(0, 2);
+    const approved = contactSheetApprovalDecisionFor('approve', {
+      kind: 'choose-candidates',
+      approvalId: 'approval-42',
+      selectedItems,
+    });
+    expect(approved).toMatchObject({
+      ok: true,
+      decision: {
+        approved: true,
+        response: { candidates: selectedItems.map((item) => item.raw) },
+      },
+    });
+    if (!approved.ok) expect.unreachable('approved decision should succeed');
+    expect(approved.decision.responseId).toBe(
+      contactSheetResponseIdFor('approval-42', approved.decision.response),
+    );
+
+    const rejected = contactSheetApprovalDecisionFor('reject', {
+      kind: 'approve-render',
+      approvalId: 'approval-42',
+      selectedItems: selectedItems.slice(0, 1),
+      rejectionReason: 'Timing still feels abrupt',
+    });
+    expect(rejected).toMatchObject({
+      ok: true,
+      decision: {
+        approved: false,
+        rejectionReason: 'Timing still feels abrupt',
+        response: {
+          approved: false,
+          rejected: true,
+          rejectionReason: 'Timing still feels abrupt',
+          selectedRefs: [
+            {
+              key: 'candidate-a',
+              title: 'Hook A',
+              assetId: 'asset-a',
+              thumbnailRef: 'thumb-a.jpg',
+              startUs: 1_000_000,
+              endUs: 3_500_000,
+            },
+          ],
+        },
+      },
+    });
+    if (!rejected.ok) expect.unreachable('rejected decision should succeed');
+    expect(rejected.decision.responseId).toBe(
+      contactSheetResponseIdFor('approval-42', rejected.decision.response),
+    );
+  });
+
+  it('supports keyboard-style active-index movement and selection toggles', () => {
+    expect(nextContactSheetActiveIndex('ArrowRight', 0, 3)).toBe(1);
+    expect(nextContactSheetActiveIndex('ArrowDown', 1, 3)).toBe(2);
+    expect(nextContactSheetActiveIndex('End', 0, 3)).toBe(2);
+    expect(nextContactSheetActiveIndex('ArrowLeft', 0, 3)).toBe(0);
+    expect(nextContactSheetActiveIndex('Home', 2, 3)).toBe(0);
+    expect(toggleContactSheetSelection(['candidate-a'], 'candidate-b')).toEqual([
+      'candidate-a',
+      'candidate-b',
+    ]);
+    expect(toggleContactSheetSelection(['candidate-a', 'candidate-b'], 'candidate-a')).toEqual([
+      'candidate-b',
+    ]);
+  });
+});
+
+function chooseCandidatesRequest(): HumanInputRequest {
+  return {
+    kind: 'choose-candidates',
+    prompt: 'Choose your hook shots',
+    payload: {
+      candidates: [
+        rawCandidate('candidate-a', 'Hook A', 1_000_000, 3_500_000),
+        rawCandidate('candidate-b', 'Hook B', 4_000_000, 5_500_000),
+        rawCandidate('candidate-c', 'Hook C', 7_000_000, 8_000_000),
+      ],
+    },
+  };
+}
+
+function rawCandidate(id: string, title: string, startUs: number, endUs: number) {
+  return {
+    id,
+    title,
+    assetId: id.replace('candidate', 'asset'),
+    thumbnailRef: id.replace('candidate', 'thumb') + '.jpg',
+    startUs,
+    endUs,
+  };
+}
+
+function memoryStorage(seed: Record<string, string>): Pick<Storage, 'getItem' | 'setItem'> {
+  const values = new Map(Object.entries(seed));
+  return {
+    getItem: (key) => values.get(key) ?? null,
+    setItem: (key, value) => values.set(key, value),
+  };
+}
diff --git a/apps/editor-web/src/ContactSheetApproval.tsx b/apps/editor-web/src/ContactSheetApproval.tsx
new file mode 100644
index 0000000..7054882
--- /dev/null
+++ b/apps/editor-web/src/ContactSheetApproval.tsx
@@ -0,0 +1,556 @@
+import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
+import type { HumanInputRequest } from '@joy-media/workflow-engine';
+
+export interface ContactSheetApprovalDecision {
+  readonly approved: boolean;
+  readonly response: unknown;
+  readonly responseId: string;
+  readonly rejectionReason?: string;
+}
+
+export interface ContactSheetApprovalProps {
+  readonly request: HumanInputRequest;
+  readonly approvalId?: string;
+  readonly storageKey?: string;
+  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
+  readonly initialResponse?: unknown;
+  readonly initialRejectionReason?: string;
+  readonly onSubmit: (decision: ContactSheetApprovalDecision) => void;
+  readonly onDismiss?: () => void;
+}
+
+export interface ContactSheetApprovalItem {
+  readonly key: string;
+  readonly title: string;
+  readonly assetId?: string;
+  readonly thumbnailRef?: string;
+  readonly startUs?: number;
+  readonly endUs?: number;
+  readonly diff?: unknown;
+  readonly raw: unknown;
+}
+
+export interface ContactSheetPersistedState {
+  readonly selectedKeys?: readonly string[];
+  readonly activeIndex?: number;
+  readonly compareKey?: string;
+  readonly rejectionReason?: string;
+}
+
+export type ContactSheetApprovalAction = 'approve' | 'reject';
+
+export type ContactSheetApprovalDecisionResult =
+  | { readonly ok: true; readonly decision: ContactSheetApprovalDecision }
+  | { readonly ok: false; readonly validation: string };
+
+export function ContactSheetApproval({
+  request,
+  approvalId,
+  storageKey,
+  storage,
+  initialResponse,
+  initialRejectionReason,
+  onSubmit,
+  onDismiss,
+}: ContactSheetApprovalProps) {
+  const items = useMemo(() => contactSheetApprovalItemsFor(request), [request]);
+  const resolvedStorageKey = storageKey ?? approvalId;
+  const persisted = useMemo(
+    () => readContactSheetPersistedState(storage, resolvedStorageKey),
+    [resolvedStorageKey, storage],
+  );
+  const initialSelection = useMemo(
+    () => initialContactSheetSelectedKeys(request, items, initialResponse, persisted),
+    [initialResponse, items, persisted, request],
+  );
+  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
+    () => new Set(initialSelection),
+  );
+  const [activeIndex, setActiveIndex] = useState(() =>
+    clampIndex(persisted?.activeIndex ?? 0, items.length),
+  );
+  const [compareKey, setCompareKey] = useState<string | undefined>(persisted?.compareKey);
+  const [rejectionReason, setRejectionReason] = useState(
+    persisted?.rejectionReason ?? initialRejectionReason ?? '',
+  );
+  const [validation, setValidation] = useState<string | undefined>(undefined);
+  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
+
+  useEffect(() => {
+    if (storage === undefined || resolvedStorageKey === undefined) return;
+    const state: ContactSheetPersistedState = {
+      selectedKeys: [...selectedKeys],
+      activeIndex,
+      ...(compareKey === undefined ? {} : { compareKey }),
+      ...(rejectionReason.length === 0 ? {} : { rejectionReason }),
+    };
+    storage.setItem(storageKeyFor(resolvedStorageKey), JSON.stringify(state));
+  }, [activeIndex, compareKey, rejectionReason, resolvedStorageKey, selectedKeys, storage]);
+
+  const selectedItems = items.filter((item) => selectedKeys.has(item.key));
+  const activeItem = items[activeIndex];
+  const comparedItem =
+    compareKey === undefined ? undefined : items.find((item) => item.key === compareKey);
+
+  function toggleKey(key: string): void {
+    setSelectedKeys((current) => new Set(toggleContactSheetSelection([...current], key)));
+    setValidation(undefined);
+  }
+
+  function focusItem(index: number): void {
+    const next = clampIndex(index, items.length);
+    setActiveIndex(next);
+    itemRefs.current[next]?.focus();
+  }
+
+  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
+    if (items.length === 0) return;
+    const nextIndex = nextContactSheetActiveIndex(event.key, activeIndex, items.length);
+    if (nextIndex !== activeIndex) {
+      event.preventDefault();
+      focusItem(nextIndex);
+      return;
+    }
+    if (event.key === ' ' || event.key === 'Enter') {
+      event.preventDefault();
+      const key = items[activeIndex]?.key;
+      if (key !== undefined) toggleKey(key);
+    }
+  }
+
+  function submitApproved(): void {
+    submitDecision('approve');
+  }
+
+  function submitRejected(): void {
+    submitDecision('reject');
+  }
+
+  function submitDecision(action: ContactSheetApprovalAction): void {
+    const result = contactSheetApprovalDecisionFor(action, {
+      kind: request.kind,
+      approvalId,
+      selectedItems,
+      rejectionReason,
+    });
+    if (!result.ok) {
+      setValidation(result.validation);
+      return;
+    }
+    onSubmit(result.decision);
+  }
+
+  return (
+    <section className="contact-sheet-approval" aria-label="Visual approval">
+      <div className="contact-sheet-approval-head">
+        <div>
+          <h4>{request.prompt}</h4>
+          <p>
+            {selectedItems.length} of {items.length} selected
+          </p>
+        </div>
+        <span title={approvalId ?? request.kind}>{request.kind}</span>
+      </div>
+
+      {items.length === 0 ? (
+        <p className="empty-hint">This approval has no visual candidates to review.</p>
+      ) : (
+        <div
+          className="contact-sheet-grid"
+          role="listbox"
+          aria-label="Approval candidates"
+          aria-multiselectable="true"
+          onKeyDown={handleGridKeyDown}
+        >
+          {items.map((item, index) => {
+            const selected = selectedKeys.has(item.key);
+            return (
+              <button
+                key={item.key}
+                ref={(node) => {
+                  itemRefs.current[index] = node;
+                }}
+                type="button"
+                role="option"
+                aria-selected={selected}
+                tabIndex={index === activeIndex ? 0 : -1}
+                className="contact-sheet-card"
+                onClick={() => {
+                  setActiveIndex(index);
+                  toggleKey(item.key);
+                }}
+              >
+                <span className="contact-sheet-thumb">
+                  {item.thumbnailRef === undefined ? (
+                    <span>Missing preview</span>
+                  ) : (
+                    <img src={item.thumbnailRef} alt="" />
+                  )}
+                </span>
+                <strong>{item.title}</strong>
+                <span>{item.assetId ?? 'No asset ref'}</span>
+                <span>{formatTimeRange(item)}</span>
+                <span>{selected ? 'Selected' : 'Not selected'}</span>
+              </button>
+            );
+          })}
+        </div>
+      )}
+
+      {request.kind === 'approve-render' && activeItem !== undefined && (
+        <div className="contact-sheet-compare">
+          <button
+            type="button"
+            className="icon-button icon-button-labeled"
+            onClick={() => setCompareKey(compareKey === activeItem.key ? undefined : activeItem.key)}
+          >
+            Compare
+          </button>
+          {comparedItem !== undefined && (
+            <pre aria-label="Render diff">{JSON.stringify(comparedItem.diff ?? comparedItem.raw, null, 2)}</pre>
+          )}
+        </div>
+      )}
+
+      <label className="contact-sheet-reason">
+        Rejection reason
+        <textarea
+          value={rejectionReason}
+          onChange={(event) => {
+            setRejectionReason(event.currentTarget.value);
+            setValidation(undefined);
+          }}
+        />
+      </label>
+
+      {validation !== undefined && (
+        <p className="workflow-status-hint" role="alert">
+          {validation}
+        </p>
+      )}
+
+      <div className="workflow-run-actions">
+        <button
+          type="button"
+          className="icon-button icon-button-labeled"
+          onClick={submitApproved}
+        >
+          Approve selected
+        </button>
+        <button type="button" className="icon-button icon-button-labeled" onClick={submitRejected}>
+          Reject
+        </button>
+        {onDismiss !== undefined && (
+          <button type="button" className="icon-button" onClick={onDismiss}>
+            Dismiss
+          </button>
+        )}
+      </div>
+    </section>
+  );
+}
+
+export function contactSheetApprovalItemsFor(
+  request: HumanInputRequest,
+): readonly ContactSheetApprovalItem[] {
+  const payload = asRecord(request.payload);
+  const values =
+    request.kind === 'choose-candidates'
+      ? asArray(payload?.candidates ?? request.payload)
+      : asArray(payload?.items ?? payload?.approved ?? request.payload);
+  return values.map((value, index) => itemFrom(value, index));
+}
+
+function itemFrom(value: unknown, index: number): ContactSheetApprovalItem {
+  const record = asRecord(value);
+  const source = asRecord(record?.source);
+  const asset = asRecord(record?.asset);
+  const sourceAsset = asRecord(source?.asset);
+  const timeRange = asRecord(record?.timeRange) ?? asRecord(source?.timeRange);
+  const range = asRecord(record?.range) ?? asRecord(source?.range);
+  const thumbnail = asRecord(record?.thumbnail) ?? asRecord(source?.thumbnail);
+  const assetId = firstString(
+    record?.assetId,
+    record?.assetRef,
+    record?.ref,
+    asset?.assetId,
+    asset?.id,
+    asset?.ref,
+    source?.assetId,
+    source?.assetRef,
+    source?.ref,
+    sourceAsset?.assetId,
+    sourceAsset?.id,
+    sourceAsset?.ref,
+  );
+  const thumbnailRef = firstString(
+    record?.thumbnailRef,
+    record?.thumbnailUrl,
+    record?.thumbnail,
+    thumbnail?.ref,
+    thumbnail?.url,
+    record?.previewRef,
+    record?.previewUrl,
+    record?.proxyRef,
+    source?.thumbnailRef,
+    source?.thumbnailUrl,
+    asRecord(source?.thumbnail)?.ref,
+    asRecord(source?.thumbnail)?.url,
+    source?.previewRef,
+    source?.previewUrl,
+    source?.proxyRef,
+  );
+  const startUs = firstNumber(
+    record?.startUs,
+    timeRange?.startUs,
+    range?.startUs,
+    source?.startUs,
+    millisToMicros(record?.startMs),
+    millisToMicros(timeRange?.startMs),
+    millisToMicros(range?.startMs),
+    millisToMicros(source?.startMs),
+  );
+  const endUs = firstNumber(
+    record?.endUs,
+    timeRange?.endUs,
+    range?.endUs,
+    source?.endUs,
+    microsFromDuration(startUs, record?.durationUs),
+    microsFromDuration(startUs, timeRange?.durationUs),
+    microsFromDuration(startUs, range?.durationUs),
+    microsFromDuration(startUs, source?.durationUs),
+    millisToMicros(record?.endMs),
+    millisToMicros(timeRange?.endMs),
+    millisToMicros(range?.endMs),
+    millisToMicros(source?.endMs),
+    millisToMicrosFromDuration(startUs, record?.durationMs),
+    millisToMicrosFromDuration(startUs, timeRange?.durationMs),
+    millisToMicrosFromDuration(startUs, range?.durationMs),
+    millisToMicrosFromDuration(startUs, source?.durationMs),
+  );
+  const title =
+    firstString(record?.title, record?.name, record?.label, record?.id, assetId) ??
+    `Candidate ${String(index + 1)}`;
+  const key =
+    firstString(record?.id, record?.candidateId, record?.itemId) ??
+    [assetId, thumbnailRef, startUs, endUs, index].filter((part) => part !== undefined).join(':');
+  return {
+    key,
+    title,
+    ...(assetId === undefined ? {} : { assetId }),
+    ...(thumbnailRef === undefined ? {} : { thumbnailRef }),
+    ...(startUs === undefined ? {} : { startUs }),
+    ...(endUs === undefined ? {} : { endUs }),
+    ...(record?.diff === undefined ? {} : { diff: record.diff }),
+    raw: value,
+  };
+}
+
+export function initialContactSheetSelectedKeys(
+  request: HumanInputRequest,
+  items: readonly ContactSheetApprovalItem[],
+  response: unknown,
+  persisted: ContactSheetPersistedState | undefined,
+): readonly string[] {
+  if (persisted?.selectedKeys !== undefined) return persisted.selectedKeys;
+  const responseRecord = asRecord(response);
+  const responseItems =
+    request.kind === 'choose-candidates'
+      ? asArray(responseRecord?.candidates)
+      : asArray(responseRecord?.approved);
+  if (responseItems.length > 0) {
+    const selected = new Set(responseItems.map((item, index) => itemFrom(item, index).key));
+    return items.filter((item) => selected.has(item.key)).map((item) => item.key);
+  }
+  return request.kind === 'choose-candidates'
+    ? items.slice(0, Math.min(2, items.length)).map((item) => item.key)
+    : items.map((item) => item.key);
+}
+
+export function contactSheetResponseFor(
+  kind: HumanInputRequest['kind'],
+  selectedItems: readonly ContactSheetApprovalItem[],
+): unknown {
+  const selected = selectedItems.map((item) => item.raw);
+  if (kind === 'choose-candidates') return { candidates: selected };
+  if (kind === 'approve-render') return { approved: selected };
+  return { approved: true, items: selected };
+}
+
+export function contactSheetApprovalDecisionFor(
+  action: ContactSheetApprovalAction,
+  input: {
+    readonly kind: HumanInputRequest['kind'];
+    readonly approvalId?: string;
+    readonly selectedItems: readonly ContactSheetApprovalItem[];
+    readonly rejectionReason?: string;
+  },
+): ContactSheetApprovalDecisionResult {
+  if (action === 'approve') {
+    if (input.selectedItems.length === 0) {
+      return {
+        ok: false,
+        validation: 'Select at least one item to approve, or reject with a reason.',
+      };
+    }
+    const response = contactSheetResponseFor(input.kind, input.selectedItems);
+    return {
+      ok: true,
+      decision: {
+        approved: true,
+        response,
+        responseId: contactSheetResponseIdFor(input.approvalId, response),
+      },
+    };
+  }
+
+  const reason = input.rejectionReason?.trim() ?? '';
+  if (reason.length === 0) {
+    return { ok: false, validation: 'Add a rejection reason before rejecting.' };
+  }
+  const response = {
+    approved: false,
+    rejected: true,
+    rejectionReason: reason,
+    selectedRefs: input.selectedItems.map((item) => publicItemRef(item)),
+  };
+  return {
+    ok: true,
+    decision: {
+      approved: false,
+      response,
+      responseId: contactSheetResponseIdFor(input.approvalId, response),
+      rejectionReason: reason,
+    },
+  };
+}
+
+export function nextContactSheetActiveIndex(
+  key: string,
+  activeIndex: number,
+  length: number,
+): number {
+  if (length <= 0) return 0;
+  if (key === 'ArrowRight' || key === 'ArrowDown') return clampIndex(activeIndex + 1, length);
+  if (key === 'ArrowLeft' || key === 'ArrowUp') return clampIndex(activeIndex - 1, length);
+  if (key === 'Home') return 0;
+  if (key === 'End') return length - 1;
+  return clampIndex(activeIndex, length);
+}
+
+export function toggleContactSheetSelection(
+  selectedKeys: readonly string[],
+  key: string,
+): readonly string[] {
+  return selectedKeys.includes(key)
+    ? selectedKeys.filter((selected) => selected !== key)
+    : [...selectedKeys, key];
+}
+
+function publicItemRef(item: ContactSheetApprovalItem): Record<string, unknown> {
+  return {
+    key: item.key,
+    title: item.title,
+    ...(item.assetId === undefined ? {} : { assetId: item.assetId }),
+    ...(item.thumbnailRef === undefined ? {} : { thumbnailRef: item.thumbnailRef }),
+    ...(item.startUs === undefined ? {} : { startUs: item.startUs }),
+    ...(item.endUs === undefined ? {} : { endUs: item.endUs }),
+  };
+}
+
+function formatTimeRange(item: ContactSheetApprovalItem): string {
+  if (item.startUs === undefined && item.endUs === undefined) return 'No time range';
+  return `${formatUs(item.startUs ?? 0)}-${formatUs(item.endUs ?? item.startUs ?? 0)}`;
+}
+
+function formatUs(value: number): string {
+  const totalSeconds = Math.max(0, Math.round(value / 1_000_000));
+  const minutes = Math.floor(totalSeconds / 60);
+  const seconds = totalSeconds % 60;
+  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
+}
+
+export function contactSheetResponseIdFor(approvalId: string | undefined, response: unknown): string {
+  return `approval-response:${approvalId ?? 'unbound'}:${hashString(canonicalJson(response))}`;
+}
+
+function canonicalJson(value: unknown): string {
+  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
+  if (value !== null && typeof value === 'object') {
+    return `{${Object.entries(value as Record<string, unknown>)
+      .sort(([left], [right]) => left.localeCompare(right))
+      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
+      .join(',')}}`;
+  }
+  return JSON.stringify(value);
+}
+
+function hashString(value: string): string {
+  let hash = 2_166_136_261;
+  for (let index = 0; index < value.length; index += 1) {
+    hash ^= value.charCodeAt(index);
+    hash = Math.imul(hash, 16_777_619);
+  }
+  return (hash >>> 0).toString(36);
+}
+
+export function readContactSheetPersistedState(
+  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
+  key: string | undefined,
+): ContactSheetPersistedState | undefined {
+  if (storage === undefined || key === undefined) return undefined;
+  try {
+    const raw = storage.getItem(storageKeyFor(key));
+    if (raw === null) return undefined;
+    const parsed = JSON.parse(raw) as ContactSheetPersistedState;
+    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
+  } catch {
+    return undefined;
+  }
+}
+
+function storageKeyFor(key: string): string {
+  return `joy-media.contact-sheet-approval:${key}`;
+}
+
+function clampIndex(index: number, length: number): number {
+  if (length <= 0) return 0;
+  return Math.min(Math.max(index, 0), length - 1);
+}
+
+function asRecord(value: unknown): Record<string, unknown> | undefined {
+  return value !== null && typeof value === 'object' && !Array.isArray(value)
+    ? (value as Record<string, unknown>)
+    : undefined;
+}
+
+function asArray(value: unknown): readonly unknown[] {
+  return Array.isArray(value) ? value : [];
+}
+
+function firstString(...values: readonly unknown[]): string | undefined {
+  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
+}
+
+function firstNumber(...values: readonly unknown[]): number | undefined {
+  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
+}
+
+function millisToMicros(value: unknown): number | undefined {
+  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1_000) : undefined;
+}
+
+function microsFromDuration(startUs: number | undefined, durationUs: unknown): number | undefined {
+  return startUs !== undefined && typeof durationUs === 'number' && Number.isFinite(durationUs)
+    ? startUs + durationUs
+    : undefined;
+}
+
+function millisToMicrosFromDuration(
+  startUs: number | undefined,
+  durationMs: unknown,
+): number | undefined {
+  return startUs !== undefined && typeof durationMs === 'number' && Number.isFinite(durationMs)
+    ? startUs + Math.round(durationMs * 1_000)
+    : undefined;
+}
diff --git a/apps/editor-web/src/ProductionBoardPanel.tsx b/apps/editor-web/src/ProductionBoardPanel.tsx
index 914a341..e15eb29 100644
--- a/apps/editor-web/src/ProductionBoardPanel.tsx
+++ b/apps/editor-web/src/ProductionBoardPanel.tsx
@@ -1,31 +1,34 @@
 import { useCallback, useEffect, useMemo, useState } from 'react';
 import type {
+  HumanInputRequest,
+  ProductionApprovalV1,
   ProductionRunAuthority,
   ProductionRunRecordV1,
   RecordProductionApprovalResponseInput,
   RecordProductionApprovalResponseResult,
 } from '@joy-media/workflow-engine';
 import type { ArtifactStore } from '@joy-media/commands';
 import type { DataLane } from './data-lanes.js';
 import type { BrowserAsset } from './control-plane-client.js';
 import {
   buildProductionBoardModel,
   productionBoardNextRunId,
   productionBoardPrimaryRunId,
   type ProductionBoardModel,
   type ProductionBoardRunProjection,
   type ProductionBoardSectionId,
 } from './production-board-model.js';
-import { CheckIcon, CloseIcon, RefreshIcon } from './icons.js';
+import { CloseIcon, RefreshIcon } from './icons.js';
 import { PanelShell, type PanelTabSpec } from './PanelShell.js';
 import { panelTabIconUrl } from './panel-tab-icons.js';
+import { ContactSheetApproval, type ContactSheetApprovalDecision } from './ContactSheetApproval.js';
 
 export interface ProductionBoardRunStore {
   list(options?: { readonly limit?: number; readonly cursor?: string }): Promise<{
     readonly runs: readonly ProductionRunRecordV1[];
     readonly nextCursor?: string;
   }>;
   respondToApproval?(
     runId: string,
     response: RecordProductionApprovalResponseInput & {
       readonly expectedApprovalId?: string;
@@ -100,36 +103,43 @@ export function ProductionBoardPanel({
     if (loadState.kind !== 'loaded') return undefined;
     return buildProductionBoardModel({
       records: loadState.records,
       currentProjectRevision,
       artifacts,
       dataLanes,
       assets,
     });
   }, [artifacts, assets, currentProjectRevision, dataLanes, loadState]);
 
-  const approve = async (run: ProductionBoardRunProjection, approved: boolean) => {
-    const approval = run.pendingApprovals[0];
+  const approve = async (
+    run: ProductionBoardRunProjection,
+    approval: ProductionApprovalV1,
+    decision: ContactSheetApprovalDecision,
+  ) => {
     if (approval === undefined || store.respondToApproval === undefined) return;
     const result = await store.respondToApproval(run.runId, {
       approvalId: approval.approvalId,
-      approved,
-      responseRef: `${run.runId}:${approval.approvalId}:${approved ? 'approved' : 'rejected'}`,
+      approved: decision.approved,
+      responseRef: decision.responseId,
+      response: decision.response,
+      ...(decision.rejectionReason === undefined
+        ? {}
+        : { rejectionReason: decision.rejectionReason }),
       authority,
       expectedApprovalId: approval.approvalId,
       expectedRequestedSeq: approval.requestedSeq,
     });
     if (result.ok === false) {
       setStatus(`Approval failed: ${result.reason}`);
       return;
     }
-    setStatus(approved ? 'Approval recorded.' : 'Rejection recorded.');
+    setStatus(decision.approved ? 'Approval recorded.' : 'Rejection recorded.');
     await refresh();
   };
 
   const cancel = async (run: ProductionBoardRunProjection) => {
     if (store.cancel === undefined) return;
     const result = await store.cancel(run.runId, {
       authority,
       expectedUpdatedSeq: run.updatedSeq,
     });
     if (result.ok === false) {
@@ -147,22 +157,21 @@ export function ProductionBoardPanel({
     await refresh();
   };
 
   return (
     <ProductionBoardPanelView
       loadState={loadState.kind}
       errorMessage={loadState.kind === 'error' ? loadState.message : undefined}
       model={model}
       status={status}
       onRefresh={() => void refresh()}
-      onApprove={(run) => void approve(run, true)}
-      onReject={(run) => void approve(run, false)}
+      onApproval={(run, approval, decision) => void approve(run, approval, decision)}
       onCancel={(run) => void cancel(run)}
       onRetry={(run) => void retry(run)}
       retryAvailable={onRetryRun !== undefined}
       onOpenLink={onOpenLink}
     />
   );
 }
 
 export async function loadProductionBoardRecords(
   store: ProductionBoardRunStore,
@@ -187,34 +196,36 @@ export async function loadProductionBoardRecords(
   return records;
 }
 
 export function ProductionBoardPanelView({
   loadState,
   errorMessage,
   model,
   status,
   retryAvailable = false,
   onRefresh,
-  onApprove,
-  onReject,
+  onApproval,
   onCancel,
   onRetry,
   onOpenLink,
 }: {
   readonly loadState: 'loading' | 'loaded' | 'error';
   readonly errorMessage?: string;
   readonly model?: ProductionBoardModel;
   readonly status?: string;
   readonly retryAvailable?: boolean;
   readonly onRefresh?: () => void;
-  readonly onApprove?: (run: ProductionBoardRunProjection) => void;
-  readonly onReject?: (run: ProductionBoardRunProjection) => void;
+  readonly onApproval?: (
+    run: ProductionBoardRunProjection,
+    approval: ProductionApprovalV1,
+    decision: ContactSheetApprovalDecision,
+  ) => void;
   readonly onCancel?: (run: ProductionBoardRunProjection) => void;
   readonly onRetry?: (run: ProductionBoardRunProjection) => void;
   readonly onOpenLink?: (href: string) => void;
 }) {
   const [section, setSection] = useState<ProductionBoardSectionId>('brief');
   const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
   const selectedId = productionBoardPrimaryRunId(model ?? { runs: [] }, selectedRunId);
   const selectedRun = model?.runs.find((run) => run.runId === selectedId);
 
   const note =
@@ -300,48 +311,49 @@ export function ProductionBoardPanelView({
                   ))}
                 </div>
               </section>
             ))}
           </div>
           {selectedRun !== undefined && (
             <RunDetails
               run={selectedRun}
               section={section}
               retryAvailable={retryAvailable}
-              onApprove={onApprove}
-              onReject={onReject}
+              onApproval={onApproval}
               onCancel={onCancel}
               onRetry={onRetry}
               onOpenLink={onOpenLink}
             />
           )}
         </div>
       )}
     </PanelShell>
   );
 }
 
 function RunDetails({
   run,
   section,
   retryAvailable,
-  onApprove,
-  onReject,
+  onApproval,
   onCancel,
   onRetry,
   onOpenLink,
 }: {
   readonly run: ProductionBoardRunProjection;
   readonly section: ProductionBoardSectionId;
   readonly retryAvailable: boolean;
-  readonly onApprove?: (run: ProductionBoardRunProjection) => void;
-  readonly onReject?: (run: ProductionBoardRunProjection) => void;
+  readonly onApproval?: (
+    run: ProductionBoardRunProjection,
+    approval: ProductionApprovalV1,
+    decision: ContactSheetApprovalDecision,
+  ) => void;
   readonly onCancel?: (run: ProductionBoardRunProjection) => void;
   readonly onRetry?: (run: ProductionBoardRunProjection) => void;
   readonly onOpenLink?: (href: string) => void;
 }) {
   const active = run.sections[section];
   return (
     <section className="production-board-detail" aria-label={`Production run ${run.runId}`}>
       <div className="production-board-detail-head">
         <div>
           <h4>{run.workflowId}</h4>
@@ -354,38 +366,20 @@ function RunDetails({
       </div>
       {run.staleRevisionConflict && (
         <p className="production-board-conflict" role="alert">
           Stale project revision: this run parked on {run.projectRevision}.
         </p>
       )}
       {run.actions.disabledReason !== undefined && (
         <p className="production-board-action-note">{run.actions.disabledReason}</p>
       )}
       <div className="production-board-actions" aria-label="Run actions">
-        <button
-          type="button"
-          className="icon-button icon-button-labeled"
-          disabled={!run.actions.canApprove}
-          onClick={() => onApprove?.(run)}
-        >
-          <CheckIcon />
-          Approve
-        </button>
-        <button
-          type="button"
-          className="icon-button icon-button-labeled"
-          disabled={!run.actions.canReject}
-          onClick={() => onReject?.(run)}
-        >
-          <CloseIcon />
-          Reject
-        </button>
         <button
           type="button"
           className="icon-button icon-button-labeled"
           disabled={!run.actions.canRetry || !retryAvailable}
           onClick={() => onRetry?.(run)}
         >
           <RefreshIcon />
           Retry
         </button>
         <button
@@ -393,20 +387,33 @@ function RunDetails({
           className="icon-button icon-button-labeled"
           disabled={!run.actions.canCancel}
           onClick={() => onCancel?.(run)}
         >
           <CloseIcon />
           Cancel
         </button>
       </div>
       <div className="production-board-section">
         <h4>{active.label}</h4>
+        {section === 'approvals' &&
+          run.pendingApprovals.map((approval) => (
+            <ContactSheetApproval
+              key={approval.approvalId}
+              request={requestFromApproval(approval)}
+              approvalId={approval.approvalId}
+              initialResponse={approval.response}
+              initialRejectionReason={approval.rejectionReason}
+              storageKey={`${run.runId}:${approval.approvalId}`}
+              storage={typeof window === 'undefined' ? undefined : window.localStorage}
+              onSubmit={(decision) => onApproval?.(run, approval, decision)}
+            />
+          ))}
         {active.items.length === 0 ? (
           <p className="production-board-empty">No {active.label.toLowerCase()} projection yet.</p>
         ) : (
           <ul>
             {active.items.map((item) => (
               <li key={item.id}>
                 <div className="production-board-item-main">
                   <strong>{item.title}</strong>
                   {item.state !== undefined && (
                     <span className="production-board-node-state">{item.state}</span>
@@ -432,13 +439,21 @@ function RunDetails({
                 )}
               </li>
             ))}
           </ul>
         )}
       </div>
     </section>
   );
 }
 
+function requestFromApproval(approval: ProductionApprovalV1): HumanInputRequest {
+  return {
+    kind: approval.kind,
+    prompt: approval.prompt,
+    ...(approval.requestPayload === undefined ? {} : { payload: approval.requestPayload }),
+  };
+}
+
 function message(error: unknown): string {
   return error instanceof Error ? error.message : String(error);
 }
diff --git a/apps/editor-web/src/WorkflowsPanel.tsx b/apps/editor-web/src/WorkflowsPanel.tsx
index ccb66ee..30c0753 100644
--- a/apps/editor-web/src/WorkflowsPanel.tsx
+++ b/apps/editor-web/src/WorkflowsPanel.tsx
@@ -10,39 +10,39 @@ import {
 } from './workflow-recorder.js';
 import {
   loadFirstPartyWorkflows,
   getFirstPartyWorkflowVersion,
   detectDerivedFrom,
 } from './first-party-workflows.js';
 import type { WorkflowRunOutcome } from './workflow-runner.js';
 import { PlayIcon, RefreshIcon, TrashIcon, BadgeIcon } from './icons.js';
 import { PanelShell, type PanelTabSpec } from './PanelShell.js';
 import { panelTabIconUrl } from './panel-tab-icons.js';
+import { ContactSheetApproval, type ContactSheetApprovalDecision } from './ContactSheetApproval.js';
 
 const TABS: readonly PanelTabSpec[] = [
   { id: 'saved', label: 'Saved' },
   { id: 'system', label: 'System' },
 ];
 
 export interface WorkflowInputParameter {
   readonly name: string;
   readonly type: 'string' | 'number';
   readonly description: string;
   readonly default?: unknown;
 }
 
 interface ApprovalState {
   readonly runId: string;
   readonly workflowId: string;
   readonly nodeId: string;
   readonly request: HumanInputRequest;
-  readonly selected: ReadonlySet<string>;
   readonly approvalId?: string;
   readonly approvalRequestedSeq?: number;
   readonly approvalExpiresAtSeq?: number;
 }
 
 export function parametersFromSchema(
   schema: Record<string, unknown>,
   selectedClip:
     | {
         readonly trackId: string;
@@ -85,29 +85,20 @@ export function parametersFromSchema(
       type,
       description:
         name === 'asset'
           ? ((propertySchema.description as string | undefined) ?? 'Opaque source video asset id')
           : ((propertySchema.description as string | undefined) ?? name),
       default: defaultValue,
     };
   });
 }
 
-function candidateKey(candidate: unknown, index: number): string {
-  if (typeof candidate === 'object' && candidate !== null) {
-    const record = candidate as Record<string, unknown>;
-    if (typeof record.title === 'string') return record.title;
-    if (typeof record.id === 'string') return record.id;
-  }
-  return `candidate-${String(index)}`;
-}
-
 export function WorkflowsPanel({
   session,
   selectedClipIds,
   playheadUs,
   onRun,
   onResume,
 }: {
   readonly session: EditorSession;
   readonly selectedClipIds: readonly string[];
   readonly playheadUs: number;
@@ -148,30 +139,25 @@ export function WorkflowsPanel({
       if (clip !== undefined) return { trackId: track.id, clip };
     }
     return undefined;
   })();
 
   const systemWorkflows = loadFirstPartyWorkflows();
   const systemWorkflowVersion = getFirstPartyWorkflowVersion();
 
   function applyOutcome(outcome: WorkflowRunOutcome): void {
     if (outcome.status === 'waiting_for_input') {
-      const payload = outcome.request.payload as { candidates?: readonly unknown[] } | undefined;
-      const candidates = payload?.candidates ?? [];
       setApproval({
         runId: outcome.runId,
         workflowId: outcome.workflowId,
         nodeId: outcome.nodeId,
         request: outcome.request,
-        selected: new Set(
-          candidates.map((candidate, index) => candidateKey(candidate, index)).slice(0, 2),
-        ),
         ...(outcome.approvalId === undefined ? {} : { approvalId: outcome.approvalId }),
         ...(outcome.approvalRequestedSeq === undefined
           ? {}
           : { approvalRequestedSeq: outcome.approvalRequestedSeq }),
         ...(outcome.approvalExpiresAtSeq === undefined
           ? {}
           : { approvalExpiresAtSeq: outcome.approvalExpiresAtSeq }),
       });
       setStatusMessage(`Awaiting approval: ${outcome.request.kind}`);
       return;
@@ -216,59 +202,36 @@ export function WorkflowsPanel({
       }
       inputs[parameter.name] = parameter.type === 'number' ? Number(raw) : raw;
     }
     const workflowId = runModal.workflowId;
     setRunModal(undefined);
     setRunInputs({});
     const outcome = await onRun(workflowId, inputs);
     applyOutcome(outcome);
   }
 
-  async function submitApproval() {
+  async function submitApprovalDecision(decision: ContactSheetApprovalDecision) {
     if (approval === undefined) return;
-    const payload = approval.request.payload as
-      { candidates?: readonly unknown[]; items?: readonly unknown[] } | undefined;
-    let humanInputs: Record<string, unknown>;
-
-    if (approval.request.kind === 'choose-candidates') {
-      const candidates = (payload?.candidates ?? []).filter((candidate, index) =>
-        approval.selected.has(candidateKey(candidate, index)),
-      );
-      humanInputs = { [approval.nodeId]: { candidates } };
-    } else if (approval.request.kind === 'approve-render') {
-      humanInputs = { [approval.nodeId]: { approved: payload?.items ?? [] } };
-    } else {
-      humanInputs = { [approval.nodeId]: { approved: true } };
-    }
+    const humanInputs: Record<string, unknown> = { [approval.nodeId]: decision.response };
 
     const outcome = await onResume(approval.runId, humanInputs, {
       ...(approval.approvalId === undefined ? {} : { approvalId: approval.approvalId }),
       ...(approval.approvalRequestedSeq === undefined
         ? {}
         : { approvalRequestedSeq: approval.approvalRequestedSeq }),
       ...(approval.approvalExpiresAtSeq === undefined
         ? {}
         : { approvalExpiresAtSeq: approval.approvalExpiresAtSeq }),
     });
     applyOutcome(outcome);
   }
 
-  function toggleCandidate(key: string) {
-    setApproval((current) => {
-      if (current === undefined) return current;
-      const next = new Set(current.selected);
-      if (next.has(key)) next.delete(key);
-      else next.add(key);
-      return { ...current, selected: next };
-    });
-  }
-
   function renderRecordedRow(recorded: RecordedWorkflow) {
     const derivedFrom = detectDerivedFrom(recorded);
     const hasInputs =
       Object.keys(
         (extractWorkflowInputs(recorded.workflow.nodes).properties as Record<string, unknown>) ??
           {},
       ).length > 0;
     return (
       <li key={recorded.workflow.id} className="workflow-row">
         <div className="workflow-row-main">
@@ -335,26 +298,20 @@ export function WorkflowsPanel({
             aria-label={`Run ${entry.workflow.name}`}
             title={`Run with inputs`}
           >
             <PlayIcon />
           </button>
         </div>
       </li>
     );
   }
 
-  const approvalCandidates =
-    approval?.request.kind === 'choose-candidates'
-      ? (((approval.request.payload as { candidates?: readonly unknown[] } | undefined)
-          ?.candidates ?? []) as readonly unknown[])
-      : [];
-
   const isEmpty = workflows.length === 0 && systemWorkflows.length === 0;
 
   return (
     <PanelShell
       title="Workflows"
       iconUrl={panelTabIconUrl('workflows')}
       className="workflows-panel"
       tabs={TABS}
       activeTab={tab}
       onTabChange={setTab}
@@ -407,64 +364,29 @@ export function WorkflowsPanel({
               aria-label="Cancel"
             >
               <TrashIcon />
             </button>
           </div>
         </div>
       )}
 
       {approval !== undefined && (
         <div className="workflow-run-modal" role="dialog" aria-label="Workflow approval">
-          <h4>{approval.request.prompt}</h4>
-          {approval.request.kind === 'choose-candidates' ? (
-            <ul className="workflow-candidate-list">
-              {approvalCandidates.map((candidate, index) => {
-                const key = candidateKey(candidate, index);
-                const title =
-                  typeof candidate === 'object' && candidate !== null && 'title' in candidate
-                    ? String((candidate as { title: unknown }).title)
-                    : key;
-                return (
-                  <li key={key}>
-                    <label className="workflow-candidate-option">
-                      <input
-                        type="checkbox"
-                        checked={approval.selected.has(key)}
-                        onChange={() => toggleCandidate(key)}
-                      />
-                      <span>{title}</span>
-                    </label>
-                  </li>
-                );
-              })}
-            </ul>
-          ) : (
-            <p className="empty-hint">Review the {approval.request.kind} request and continue.</p>
-          )}
-          <div className="workflow-run-actions">
-            <button
-              className="icon-button icon-button-labeled"
-              onClick={() => void submitApproval()}
-              title="Continue workflow"
-            >
-              <PlayIcon />
-              Continue
-            </button>
-            <button
-              className="icon-button"
-              onClick={() => setApproval(undefined)}
-              title="Dismiss"
-              aria-label="Dismiss approval"
-            >
-              <TrashIcon />
-            </button>
-          </div>
+          <ContactSheetApproval
+            key={`${approval.runId}:${approval.nodeId}:${approval.approvalId ?? 'local'}`}
+            request={approval.request}
+            approvalId={approval.approvalId}
+            storageKey={`${approval.runId}:${approval.nodeId}:${approval.approvalId ?? 'local'}`}
+            storage={typeof window === 'undefined' ? undefined : window.localStorage}
+            onSubmit={(decision) => void submitApprovalDecision(decision)}
+            onDismiss={() => setApproval(undefined)}
+          />
         </div>
       )}
 
       {tab === 'saved' && (
         <ul className="workflow-list">{workflows.map((wf) => renderRecordedRow(wf))}</ul>
       )}
 
       {tab === 'system' && (
         <>
           <div className="workflow-section-header">
diff --git a/apps/editor-web/src/browser-production-run-store.ts b/apps/editor-web/src/browser-production-run-store.ts
index bce79fb..07afd4f 100644
--- a/apps/editor-web/src/browser-production-run-store.ts
+++ b/apps/editor-web/src/browser-production-run-store.ts
@@ -185,20 +185,21 @@ export class BrowserProductionRunStore implements ProductionRunStore {
       actor: update.authority,
       checkpointRevision,
       message: `checkpoint revision ${String(checkpointRevision)}`,
     });
     const nextApprovals = update.dashboard?.approvals.map((approval) => ({
       approvalVersion: PRODUCTION_APPROVAL_VERSION,
       approvalId: approval.approvalId,
       nodeId: approval.nodeId,
       kind: approval.kind,
       prompt: approval.prompt,
+      ...(approval.requestPayload === undefined ? {} : { requestPayload: approval.requestPayload }),
       state: approval.state,
       requestedSeq: withEvent.updatedSeq,
     }));
     const record: ProductionRunRecordV1 = {
       ...withEvent,
       checkpointRevision,
       checkpoint: sanitizeCheckpoint(update.checkpoint),
       nodes: update.dashboard?.nodes ?? current.nodes,
       approvals:
         nextApprovals === undefined
@@ -351,21 +352,23 @@ export class BrowserProductionRunStore implements ProductionRunStore {
     };
     this.storage.setItem(this.#storageKey, JSON.stringify(database));
   }
 }
 
 function mergeApprovals(
   current: readonly ProductionApprovalV1[],
   next: readonly ProductionApprovalV1[],
 ): readonly ProductionApprovalV1[] {
   const nextById = new Map(next.map((approval) => [approval.approvalId, approval]));
-  const merged = current.map((approval) => nextById.get(approval.approvalId) ?? approval);
+  const merged = current.map((approval) =>
+    approval.state === 'pending' ? (nextById.get(approval.approvalId) ?? approval) : approval,
+  );
   const currentIds = new Set(current.map((approval) => approval.approvalId));
   return [...merged, ...next.filter((approval) => !currentIds.has(approval.approvalId))];
 }
 
 function eventTypeForState(state: ProductionRunStateV1): ProductionRunEventTypeV1 {
   switch (state) {
     case 'queued':
       return 'run.queued';
     case 'running':
       return 'run.checkpointed';
@@ -389,20 +392,23 @@ function sanitizeCheckpoint(checkpoint: RunCheckpoint): RunCheckpoint {
       attempts: node.attempts,
       deterministic: node.deterministic,
       ...(node.failureCode === undefined ? {} : { failureCode: node.failureCode }),
       ...(node.output === undefined ? {} : { output: node.output }),
       ...(node.pendingRequest === undefined
         ? {}
         : {
             pendingRequest: {
               kind: node.pendingRequest.kind,
               prompt: node.pendingRequest.prompt,
+              ...(node.pendingRequest.payload === undefined
+                ? {}
+                : { payload: node.pendingRequest.payload }),
             },
           }),
       ...(node.resolvedInput === undefined ? {} : { resolvedInput: node.resolvedInput }),
     };
   }
   return {
     checkpointVersion: checkpoint.checkpointVersion,
     runId: checkpoint.runId,
     workflowId: checkpoint.workflowId,
     workflowVersion: checkpoint.workflowVersion,
@@ -466,25 +472,20 @@ function assertNoPrivatePayload(value: unknown, path: readonly string[]): void {
     return;
   }
   if (value === null || typeof value !== 'object') {
     return;
   }
   if (Array.isArray(value)) {
     value.forEach((item, index) => assertNoPrivatePayload(item, [...path, String(index)]));
     return;
   }
   for (const [key, child] of Object.entries(value)) {
-    if (key === 'payload' && child !== undefined) {
-      throw new Error(
-        `raw media is not allowed in local production run records (${[...path, key].join('.')})`,
-      );
-    }
     assertNoPrivatePayload(child, [...path, key]);
   }
 }
 
 function isPrivateLocalPath(value: string): boolean {
   return (
     /^[A-Za-z]:[\\/]/.test(value) ||
     /^\\\\/.test(value) ||
     /^file:\/\//i.test(value) ||
     /^\/(?:Users|home|Volumes|private|tmp|var|mnt|opt)\//.test(value)
diff --git a/apps/editor-web/src/workflow-runner.ts b/apps/editor-web/src/workflow-runner.ts
index be3e8a7..6b2b6e8 100644
--- a/apps/editor-web/src/workflow-runner.ts
+++ b/apps/editor-web/src/workflow-runner.ts
@@ -637,20 +637,22 @@ export async function resumeWorkflow(
 type ApprovalResponseResult =
   { readonly ok: true } | { readonly ok: false; readonly reason: string };
 
 interface ApprovalStoreWithPolicy extends ProductionRunStore {
   respondToApproval(
     runId: string,
     response: {
       readonly approvalId: string;
       readonly approved: boolean;
       readonly responseRef: string;
+      readonly response?: unknown;
+      readonly rejectionReason?: string;
       readonly authority: ProductionRunAuthority;
       readonly expectedApprovalId?: string;
       readonly expectedRequestedSeq?: number;
       readonly expiresAtSeq?: number;
     },
   ): Promise<
     | { readonly ok: true; readonly duplicate: boolean; readonly record: ProductionRunRecordV1 }
     | { readonly ok: false; readonly reason: string }
   >;
 }
@@ -668,20 +670,25 @@ async function recordApprovalResponse(
     readonly authority: ProductionRunAuthority;
     readonly humanInputs: Readonly<Record<string, unknown>>;
     readonly expectedApprovalId?: string;
     readonly expiresAtSeq?: number;
   },
 ): Promise<ApprovalResponseResult> {
   const response = {
     approvalId: approval.approvalId,
     approved: input.approved,
     responseRef: approvalResponseRef(record, approval, input.humanInputs),
+    response: input.humanInputs[approval.nodeId],
+    ...(() => {
+      const reason = approvalRejectionReason(input.humanInputs[approval.nodeId]);
+      return reason === undefined ? {} : { rejectionReason: reason };
+    })(),
     authority: input.authority,
   };
   const result = hasPolicyApprovalResponse(store)
     ? await store.respondToApproval(record.runId, {
         ...response,
         ...(input.expectedApprovalId === undefined
           ? {}
           : { expectedApprovalId: input.expectedApprovalId }),
         expectedRequestedSeq: approval.requestedSeq,
         ...(input.expiresAtSeq === undefined ? {} : { expiresAtSeq: input.expiresAtSeq }),
@@ -709,11 +716,19 @@ function approvalResponseRef(
 
 function approvalInputApproved(input: unknown): boolean {
   if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
     const approved = (input as { readonly approved?: unknown }).approved;
     const rejected = (input as { readonly rejected?: unknown }).rejected;
     if (approved === false || rejected === true) return false;
   }
   return true;
 }
 
+function approvalRejectionReason(input: unknown): string | undefined {
+  if (input !== null && typeof input === 'object' && !Array.isArray(input)) {
+    const reason = (input as { readonly rejectionReason?: unknown }).rejectionReason;
+    if (typeof reason === 'string' && reason.trim().length > 0) return reason.trim();
+  }
+  return undefined;
+}
+
 export { resolveWorkflow };
diff --git a/packages/workflow-engine/src/production-run.ts b/packages/workflow-engine/src/production-run.ts
index 4972ea8..83fa726 100644
--- a/packages/workflow-engine/src/production-run.ts
+++ b/packages/workflow-engine/src/production-run.ts
@@ -56,24 +56,27 @@ export interface ProductionRunEventV1 {
   readonly failureCode?: string;
   readonly message?: string;
 }
 
 export interface ProductionApprovalV1 {
   readonly approvalVersion: typeof PRODUCTION_APPROVAL_VERSION;
   readonly approvalId: string;
   readonly nodeId: string;
   readonly kind: HumanInputRequestKind;
   readonly prompt: string;
+  readonly requestPayload?: unknown;
   readonly state: ProductionApprovalStateV1;
   readonly requestedSeq: number;
   readonly respondedSeq?: number;
   readonly responseRef?: string;
+  readonly response?: unknown;
+  readonly rejectionReason?: string;
   readonly authority?: ProductionRunAuthority;
 }
 
 export interface ProductionRunPublicLogEntryV1 {
   readonly seq: number;
   readonly nodeId: string;
   readonly attempt: number;
   readonly level: RunLogLevel;
   readonly message: string;
 }
@@ -141,33 +144,41 @@ export interface AppendProductionRunEventInput {
   readonly approvalId?: string;
   readonly checkpointRevision?: number;
   readonly failureCode?: string;
   readonly message?: string;
 }
 
 export interface RecordProductionApprovalResponseInput {
   readonly approvalId: string;
   readonly approved: boolean;
   readonly responseRef: string;
+  readonly response?: unknown;
+  readonly rejectionReason?: string;
   readonly authority: ProductionRunAuthority;
 }
 
 export type RecordProductionApprovalResponseResult =
   | { readonly ok: true; readonly duplicate: boolean; readonly record: ProductionRunRecordV1 }
   | { readonly ok: false; readonly reason: 'approval-not-found' | 'approval-conflict' };
 
 export interface ProductionRunBoardApprovalV1 {
   readonly approvalId: string;
   readonly nodeId: string;
   readonly kind: HumanInputRequestKind;
   readonly prompt: string;
+  readonly requestPayload?: unknown;
   readonly state: ProductionApprovalStateV1;
+  readonly requestedSeq: number;
+  readonly respondedSeq?: number;
+  readonly responseRef?: string;
+  readonly response?: unknown;
+  readonly rejectionReason?: string;
 }
 
 export interface ProductionRunBoardRunV1 {
   readonly runId: string;
   readonly workflowId: string;
   readonly workflowVersion: string;
   readonly projectRevision: string;
   readonly state: ProductionRunStateV1;
   readonly checkpointRevision: number;
   readonly links: ProductionRunLinksV1;
@@ -331,32 +342,39 @@ export function recordProductionApprovalResponse(
   record: ProductionRunRecordV1,
   input: RecordProductionApprovalResponseInput,
 ): RecordProductionApprovalResponseResult {
   const approval = record.approvals.find((candidate) => candidate.approvalId === input.approvalId);
   if (approval === undefined) {
     return { ok: false, reason: 'approval-not-found' };
   }
 
   const nextState: ProductionApprovalStateV1 = input.approved ? 'approved' : 'rejected';
   if (approval.state !== 'pending') {
-    if (approval.state === nextState && approval.responseRef === input.responseRef) {
+    if (
+      approval.state === nextState &&
+      approval.responseRef === input.responseRef &&
+      jsonEqual(approval.response, input.response) &&
+      approval.rejectionReason === input.rejectionReason
+    ) {
       return { ok: true, duplicate: true, record };
     }
     return { ok: false, reason: 'approval-conflict' };
   }
 
   const seq = nextSequence(record);
   const updatedApproval: ProductionApprovalV1 = {
     ...approval,
     state: nextState,
     respondedSeq: seq,
     responseRef: input.responseRef,
+    ...(input.response === undefined ? {} : { response: input.response }),
+    ...(input.rejectionReason === undefined ? {} : { rejectionReason: input.rejectionReason }),
     authority: input.authority,
   };
   const event = createProductionRunEvent(
     seq,
     {
       type: 'approval.responded',
       state: record.state,
       actor: input.authority,
       nodeId: approval.nodeId,
       approvalId: approval.approvalId,
@@ -403,21 +421,31 @@ export function buildProductionRunBoardSnapshot(
       projectRevision: record.projectRevision,
       state: record.state,
       checkpointRevision: record.checkpointRevision,
       links: record.links,
       counts: nodeCounts(record.nodes),
       approvals: record.approvals.map((approval) => ({
         approvalId: approval.approvalId,
         nodeId: approval.nodeId,
         kind: approval.kind,
         prompt: approval.prompt,
+        ...(approval.requestPayload === undefined
+          ? {}
+          : { requestPayload: approval.requestPayload }),
         state: approval.state,
+        requestedSeq: approval.requestedSeq,
+        ...(approval.respondedSeq === undefined ? {} : { respondedSeq: approval.respondedSeq }),
+        ...(approval.responseRef === undefined ? {} : { responseRef: approval.responseRef }),
+        ...(approval.response === undefined ? {} : { response: approval.response }),
+        ...(approval.rejectionReason === undefined
+          ? {}
+          : { rejectionReason: approval.rejectionReason }),
       })),
       nodes: record.nodes,
       lastEventSeq: record.events.at(-1)?.seq ?? 0,
     };
   });
   return {
     snapshotVersion: PRODUCTION_RUN_BOARD_SNAPSHOT_VERSION,
     counts,
     runs,
   };
@@ -470,20 +498,21 @@ export class InMemoryProductionRunStore implements ProductionRunStore {
         ...(update.authority === undefined ? {} : { actor: update.authority }),
       },
       checkpointRevision,
     );
     const nextApprovals = update.dashboard?.approvals.map((approval) => ({
       approvalVersion: PRODUCTION_APPROVAL_VERSION,
       approvalId: approval.approvalId,
       nodeId: approval.nodeId,
       kind: approval.kind,
       prompt: approval.prompt,
+      ...(approval.requestPayload === undefined ? {} : { requestPayload: approval.requestPayload }),
       state: approval.state,
       requestedSeq: event.seq,
     }));
     const record: ProductionRunRecordV1 = {
       ...current,
       state,
       checkpointRevision,
       checkpoint: sanitizeCheckpoint(update.checkpoint),
       events: [...current.events, event],
       nodes: update.dashboard?.nodes ?? current.nodes,
@@ -512,25 +541,31 @@ export class InMemoryProductionRunStore implements ProductionRunStore {
     }
     return result;
   }
 }
 
 function mergeProductionApprovals(
   current: readonly ProductionApprovalV1[],
   next: readonly ProductionApprovalV1[],
 ): readonly ProductionApprovalV1[] {
   const nextById = new Map(next.map((approval) => [approval.approvalId, approval]));
-  const merged = current.map((approval) => nextById.get(approval.approvalId) ?? approval);
+  const merged = current.map((approval) =>
+    approval.state === 'pending' ? (nextById.get(approval.approvalId) ?? approval) : approval,
+  );
   const currentIds = new Set(current.map((approval) => approval.approvalId));
   return [...merged, ...next.filter((approval) => !currentIds.has(approval.approvalId))];
 }
 
+function jsonEqual(left: unknown, right: unknown): boolean {
+  return JSON.stringify(left) === JSON.stringify(right);
+}
+
 function createProductionRunEvent(
   seq: number,
   input: AppendProductionRunEventInput,
   fallbackCheckpointRevision: number,
 ): ProductionRunEventV1 {
   return {
     eventVersion: PRODUCTION_RUN_EVENT_VERSION,
     seq,
     type: input.type,
     state: input.state,
@@ -616,20 +651,23 @@ function approvalsFromDashboard(
       return [];
     }
     const approvalId = approvalIdForNode(dashboard.runId, node);
     return [
       {
         approvalVersion: PRODUCTION_APPROVAL_VERSION,
         approvalId,
         nodeId: node.nodeId,
         kind: node.pendingRequest.kind,
         prompt: node.pendingRequest.prompt,
+        ...(node.pendingRequest.payload === undefined
+          ? {}
+          : { requestPayload: node.pendingRequest.payload }),
         state: 'pending',
         requestedSeq: requestedSeqByApprovalId.get(approvalId) ?? 1,
       },
     ];
   });
 }
 
 function nodesFromDashboard(
   dashboard: RunDashboard,
   approvals: readonly ProductionApprovalV1[],
@@ -725,12 +763,13 @@ function sanitizeCheckpoint(checkpoint: RunCheckpoint): RunCheckpoint {
     projectRevision: checkpoint.projectRevision,
     state: checkpoint.state,
     nodes,
   };
 }
 
 function sanitizeHumanInputRequest(request: HumanInputRequest): HumanInputRequest {
   return {
     kind: request.kind,
     prompt: request.prompt,
+    ...(request.payload === undefined ? {} : { payload: request.payload }),
   };
 }
