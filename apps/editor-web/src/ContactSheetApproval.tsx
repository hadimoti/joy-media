import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { HumanInputRequest } from '@joy-media/workflow-engine';

export interface ContactSheetApprovalDecision {
  readonly approved: boolean;
  readonly response: unknown;
  readonly responseId: string;
  readonly rejectionReason?: string;
}

export interface ContactSheetApprovalProps {
  readonly request: HumanInputRequest;
  readonly approvalId?: string;
  readonly storageKey?: string;
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  readonly initialResponse?: unknown;
  readonly initialRejectionReason?: string;
  readonly onSubmit: (decision: ContactSheetApprovalDecision) => void;
  readonly onDismiss?: () => void;
}

export interface ContactSheetApprovalItem {
  readonly key: string;
  readonly title: string;
  readonly assetId?: string;
  readonly thumbnailRef?: string;
  readonly startUs?: number;
  readonly endUs?: number;
  readonly diff?: unknown;
  readonly raw: unknown;
}

export interface ContactSheetPersistedState {
  readonly selectedKeys?: readonly string[];
  readonly activeIndex?: number;
  readonly compareKey?: string;
  readonly rejectionReason?: string;
}

export type ContactSheetApprovalAction = 'approve' | 'reject';

export type ContactSheetApprovalDecisionResult =
  | { readonly ok: true; readonly decision: ContactSheetApprovalDecision }
  | { readonly ok: false; readonly validation: string };

export function ContactSheetApproval({
  request,
  approvalId,
  storageKey,
  storage,
  initialResponse,
  initialRejectionReason,
  onSubmit,
  onDismiss,
}: ContactSheetApprovalProps) {
  const items = useMemo(() => contactSheetApprovalItemsFor(request), [request]);
  const resolvedStorageKey = storageKey ?? approvalId;
  const persisted = useMemo(
    () => readContactSheetPersistedState(storage, resolvedStorageKey),
    [resolvedStorageKey, storage],
  );
  const initialSelection = useMemo(
    () => initialContactSheetSelectedKeys(request, items, initialResponse, persisted),
    [initialResponse, items, persisted, request],
  );
  const [selectedKeys, setSelectedKeys] = useState<ReadonlySet<string>>(
    () => new Set(initialSelection),
  );
  const [activeIndex, setActiveIndex] = useState(() =>
    clampIndex(persisted?.activeIndex ?? 0, items.length),
  );
  const [compareKey, setCompareKey] = useState<string | undefined>(persisted?.compareKey);
  const [rejectionReason, setRejectionReason] = useState(
    persisted?.rejectionReason ?? initialRejectionReason ?? '',
  );
  const [validation, setValidation] = useState<string | undefined>(undefined);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    if (storage === undefined || resolvedStorageKey === undefined) return;
    const state: ContactSheetPersistedState = {
      selectedKeys: [...selectedKeys],
      activeIndex,
      ...(compareKey === undefined ? {} : { compareKey }),
      ...(rejectionReason.length === 0 ? {} : { rejectionReason }),
    };
    storage.setItem(storageKeyFor(resolvedStorageKey), JSON.stringify(state));
  }, [activeIndex, compareKey, rejectionReason, resolvedStorageKey, selectedKeys, storage]);

  const selectedItems = items.filter((item) => selectedKeys.has(item.key));
  const activeItem = items[activeIndex];
  const comparedItem =
    compareKey === undefined ? undefined : items.find((item) => item.key === compareKey);

  function toggleKey(key: string): void {
    setSelectedKeys((current) => new Set(toggleContactSheetSelection([...current], key)));
    setValidation(undefined);
  }

  function focusItem(index: number): void {
    const next = clampIndex(index, items.length);
    setActiveIndex(next);
    itemRefs.current[next]?.focus();
  }

  function handleGridKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (items.length === 0) return;
    const nextIndex = nextContactSheetActiveIndex(event.key, activeIndex, items.length);
    if (nextIndex !== activeIndex) {
      event.preventDefault();
      focusItem(nextIndex);
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      const key = items[activeIndex]?.key;
      if (key !== undefined) toggleKey(key);
    }
  }

  function submitApproved(): void {
    submitDecision('approve');
  }

  function submitRejected(): void {
    submitDecision('reject');
  }

  function submitDecision(action: ContactSheetApprovalAction): void {
    const result = contactSheetApprovalDecisionFor(action, {
      kind: request.kind,
      approvalId,
      selectedItems,
      rejectionReason,
    });
    if (!result.ok) {
      setValidation(result.validation);
      return;
    }
    onSubmit(result.decision);
  }

  return (
    <section className="contact-sheet-approval" aria-label="Visual approval">
      <div className="contact-sheet-approval-head">
        <div>
          <h4>{request.prompt}</h4>
          <p>
            {selectedItems.length} of {items.length} selected
          </p>
        </div>
        <span title={approvalId ?? request.kind}>{request.kind}</span>
      </div>

      {items.length === 0 ? (
        <p className="empty-hint">This approval has no visual candidates to review.</p>
      ) : (
        <div
          className="contact-sheet-grid"
          role="listbox"
          aria-label="Approval candidates"
          aria-multiselectable="true"
          onKeyDown={handleGridKeyDown}
        >
          {items.map((item, index) => {
            const selected = selectedKeys.has(item.key);
            return (
              <button
                key={item.key}
                ref={(node) => {
                  itemRefs.current[index] = node;
                }}
                type="button"
                role="option"
                aria-selected={selected}
                tabIndex={index === activeIndex ? 0 : -1}
                className="contact-sheet-card"
                onClick={() => {
                  setActiveIndex(index);
                  toggleKey(item.key);
                }}
              >
                <span className="contact-sheet-thumb">
                  {item.thumbnailRef === undefined ? (
                    <span>Missing preview</span>
                  ) : (
                    <img src={item.thumbnailRef} alt="" />
                  )}
                </span>
                <strong>{item.title}</strong>
                <span>{item.assetId ?? 'No asset ref'}</span>
                <span>{formatTimeRange(item)}</span>
                <span>{selected ? 'Selected' : 'Not selected'}</span>
              </button>
            );
          })}
        </div>
      )}

      {request.kind === 'approve-render' && activeItem !== undefined && (
        <div className="contact-sheet-compare">
          <button
            type="button"
            className="icon-button icon-button-labeled"
            onClick={() => setCompareKey(compareKey === activeItem.key ? undefined : activeItem.key)}
          >
            Compare
          </button>
          {comparedItem !== undefined && (
            <pre aria-label="Render diff">{JSON.stringify(comparedItem.diff ?? comparedItem.raw, null, 2)}</pre>
          )}
        </div>
      )}

      <label className="contact-sheet-reason">
        Rejection reason
        <textarea
          value={rejectionReason}
          onChange={(event) => {
            setRejectionReason(event.currentTarget.value);
            setValidation(undefined);
          }}
        />
      </label>

      {validation !== undefined && (
        <p className="workflow-status-hint" role="alert">
          {validation}
        </p>
      )}

      <div className="workflow-run-actions">
        <button
          type="button"
          className="icon-button icon-button-labeled"
          onClick={submitApproved}
        >
          Approve selected
        </button>
        <button type="button" className="icon-button icon-button-labeled" onClick={submitRejected}>
          Reject
        </button>
        {onDismiss !== undefined && (
          <button type="button" className="icon-button" onClick={onDismiss}>
            Dismiss
          </button>
        )}
      </div>
    </section>
  );
}

export function contactSheetApprovalItemsFor(
  request: HumanInputRequest,
): readonly ContactSheetApprovalItem[] {
  const payload = asRecord(request.payload);
  const values =
    request.kind === 'choose-candidates'
      ? asArray(payload?.candidates ?? request.payload)
      : asArray(payload?.items ?? payload?.approved ?? request.payload);
  return values.map((value, index) => itemFrom(value, index));
}

function itemFrom(value: unknown, index: number): ContactSheetApprovalItem {
  const record = asRecord(value);
  const source = asRecord(record?.source);
  const asset = asRecord(record?.asset);
  const sourceAsset = asRecord(source?.asset);
  const timeRange = asRecord(record?.timeRange) ?? asRecord(source?.timeRange);
  const range = asRecord(record?.range) ?? asRecord(source?.range);
  const thumbnail = asRecord(record?.thumbnail) ?? asRecord(source?.thumbnail);
  const assetId = firstString(
    record?.assetId,
    record?.assetRef,
    record?.ref,
    asset?.assetId,
    asset?.id,
    asset?.ref,
    source?.assetId,
    source?.assetRef,
    source?.ref,
    sourceAsset?.assetId,
    sourceAsset?.id,
    sourceAsset?.ref,
  );
  const thumbnailRef = firstString(
    record?.thumbnailRef,
    record?.thumbnailUrl,
    record?.thumbnail,
    thumbnail?.ref,
    thumbnail?.url,
    record?.previewRef,
    record?.previewUrl,
    record?.proxyRef,
    source?.thumbnailRef,
    source?.thumbnailUrl,
    asRecord(source?.thumbnail)?.ref,
    asRecord(source?.thumbnail)?.url,
    source?.previewRef,
    source?.previewUrl,
    source?.proxyRef,
  );
  const startUs = firstNumber(
    record?.startUs,
    timeRange?.startUs,
    range?.startUs,
    source?.startUs,
    millisToMicros(record?.startMs),
    millisToMicros(timeRange?.startMs),
    millisToMicros(range?.startMs),
    millisToMicros(source?.startMs),
  );
  const endUs = firstNumber(
    record?.endUs,
    timeRange?.endUs,
    range?.endUs,
    source?.endUs,
    microsFromDuration(startUs, record?.durationUs),
    microsFromDuration(startUs, timeRange?.durationUs),
    microsFromDuration(startUs, range?.durationUs),
    microsFromDuration(startUs, source?.durationUs),
    millisToMicros(record?.endMs),
    millisToMicros(timeRange?.endMs),
    millisToMicros(range?.endMs),
    millisToMicros(source?.endMs),
    millisToMicrosFromDuration(startUs, record?.durationMs),
    millisToMicrosFromDuration(startUs, timeRange?.durationMs),
    millisToMicrosFromDuration(startUs, range?.durationMs),
    millisToMicrosFromDuration(startUs, source?.durationMs),
  );
  const title =
    firstString(record?.title, record?.name, record?.label, record?.id, assetId) ??
    `Candidate ${String(index + 1)}`;
  const key =
    firstString(record?.id, record?.candidateId, record?.itemId) ??
    [assetId, thumbnailRef, startUs, endUs, index].filter((part) => part !== undefined).join(':');
  return {
    key,
    title,
    ...(assetId === undefined ? {} : { assetId }),
    ...(thumbnailRef === undefined ? {} : { thumbnailRef }),
    ...(startUs === undefined ? {} : { startUs }),
    ...(endUs === undefined ? {} : { endUs }),
    ...(record?.diff === undefined ? {} : { diff: record.diff }),
    raw: value,
  };
}

export function initialContactSheetSelectedKeys(
  request: HumanInputRequest,
  items: readonly ContactSheetApprovalItem[],
  response: unknown,
  persisted: ContactSheetPersistedState | undefined,
): readonly string[] {
  if (persisted?.selectedKeys !== undefined) return persisted.selectedKeys;
  const responseRecord = asRecord(response);
  const responseItems =
    request.kind === 'choose-candidates'
      ? asArray(responseRecord?.candidates)
      : asArray(responseRecord?.approved);
  if (responseItems.length > 0) {
    const selected = new Set(responseItems.map((item, index) => itemFrom(item, index).key));
    return items.filter((item) => selected.has(item.key)).map((item) => item.key);
  }
  return request.kind === 'choose-candidates'
    ? items.slice(0, Math.min(2, items.length)).map((item) => item.key)
    : items.map((item) => item.key);
}

export function contactSheetResponseFor(
  kind: HumanInputRequest['kind'],
  selectedItems: readonly ContactSheetApprovalItem[],
): unknown {
  const selected = selectedItems.map((item) => item.raw);
  if (kind === 'choose-candidates') return { candidates: selected };
  if (kind === 'approve-render') return { approved: selected };
  return { approved: true, items: selected };
}

export function contactSheetApprovalDecisionFor(
  action: ContactSheetApprovalAction,
  input: {
    readonly kind: HumanInputRequest['kind'];
    readonly approvalId?: string;
    readonly selectedItems: readonly ContactSheetApprovalItem[];
    readonly rejectionReason?: string;
  },
): ContactSheetApprovalDecisionResult {
  if (action === 'approve') {
    if (input.selectedItems.length === 0) {
      return {
        ok: false,
        validation: 'Select at least one item to approve, or reject with a reason.',
      };
    }
    const response = contactSheetResponseFor(input.kind, input.selectedItems);
    return {
      ok: true,
      decision: {
        approved: true,
        response,
        responseId: contactSheetResponseIdFor(input.approvalId, response),
      },
    };
  }

  const reason = input.rejectionReason?.trim() ?? '';
  if (reason.length === 0) {
    return { ok: false, validation: 'Add a rejection reason before rejecting.' };
  }
  const response = {
    approved: false,
    rejected: true,
    rejectionReason: reason,
    selectedRefs: input.selectedItems.map((item) => publicItemRef(item)),
  };
  return {
    ok: true,
    decision: {
      approved: false,
      response,
      responseId: contactSheetResponseIdFor(input.approvalId, response),
      rejectionReason: reason,
    },
  };
}

export function nextContactSheetActiveIndex(
  key: string,
  activeIndex: number,
  length: number,
): number {
  if (length <= 0) return 0;
  if (key === 'ArrowRight' || key === 'ArrowDown') return clampIndex(activeIndex + 1, length);
  if (key === 'ArrowLeft' || key === 'ArrowUp') return clampIndex(activeIndex - 1, length);
  if (key === 'Home') return 0;
  if (key === 'End') return length - 1;
  return clampIndex(activeIndex, length);
}

export function toggleContactSheetSelection(
  selectedKeys: readonly string[],
  key: string,
): readonly string[] {
  return selectedKeys.includes(key)
    ? selectedKeys.filter((selected) => selected !== key)
    : [...selectedKeys, key];
}

function publicItemRef(item: ContactSheetApprovalItem): Record<string, unknown> {
  return {
    key: item.key,
    title: item.title,
    ...(item.assetId === undefined ? {} : { assetId: item.assetId }),
    ...(item.thumbnailRef === undefined ? {} : { thumbnailRef: item.thumbnailRef }),
    ...(item.startUs === undefined ? {} : { startUs: item.startUs }),
    ...(item.endUs === undefined ? {} : { endUs: item.endUs }),
  };
}

function formatTimeRange(item: ContactSheetApprovalItem): string {
  if (item.startUs === undefined && item.endUs === undefined) return 'No time range';
  return `${formatUs(item.startUs ?? 0)}-${formatUs(item.endUs ?? item.startUs ?? 0)}`;
}

function formatUs(value: number): string {
  const totalSeconds = Math.max(0, Math.round(value / 1_000_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}

export function contactSheetResponseIdFor(approvalId: string | undefined, response: unknown): string {
  return `approval-response:${approvalId ?? 'unbound'}:${hashString(canonicalJson(response))}`;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashString(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(36);
}

export function readContactSheetPersistedState(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  key: string | undefined,
): ContactSheetPersistedState | undefined {
  if (storage === undefined || key === undefined) return undefined;
  try {
    const raw = storage.getItem(storageKeyFor(key));
    if (raw === null) return undefined;
    const parsed = JSON.parse(raw) as ContactSheetPersistedState;
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function storageKeyFor(key: string): string {
  return `joy-media.contact-sheet-approval:${key}`;
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === 'string' && value.length > 0);
}

function firstNumber(...values: readonly unknown[]): number | undefined {
  return values.find((value): value is number => typeof value === 'number' && Number.isFinite(value));
}

function millisToMicros(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1_000) : undefined;
}

function microsFromDuration(startUs: number | undefined, durationUs: unknown): number | undefined {
  return startUs !== undefined && typeof durationUs === 'number' && Number.isFinite(durationUs)
    ? startUs + durationUs
    : undefined;
}

function millisToMicrosFromDuration(
  startUs: number | undefined,
  durationMs: unknown,
): number | undefined {
  return startUs !== undefined && typeof durationMs === 'number' && Number.isFinite(durationMs)
    ? startUs + Math.round(durationMs * 1_000)
    : undefined;
}
