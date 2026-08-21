import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  HumanInputRequest,
  ProductionApprovalV1,
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
import { CloseIcon, RefreshIcon } from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { ContactSheetApproval, type ContactSheetApprovalDecision } from './ContactSheetApproval.js';

export interface ProductionBoardRunStore {
  list(options?: { readonly limit?: number; readonly cursor?: string }): Promise<{
    readonly runs: readonly ProductionRunRecordV1[];
    readonly nextCursor?: string;
  }>;
  respondToApproval?(
    runId: string,
    response: RecordProductionApprovalResponseInput & {
      readonly expectedApprovalId?: string;
      readonly expectedRequestedSeq?: number;
    },
  ): Promise<
    RecordProductionApprovalResponseResult | { readonly ok: false; readonly reason: string }
  >;
  cancel?(
    runId: string,
    input: { readonly authority: ProductionRunAuthority; readonly expectedUpdatedSeq?: number },
  ): Promise<
    | { readonly ok: true; readonly record: ProductionRunRecordV1 }
    | { readonly ok: false; readonly reason: string }
  >;
}

export interface ProductionBoardPanelProps {
  readonly store: ProductionBoardRunStore;
  readonly authority: ProductionRunAuthority;
  readonly currentProjectRevision: string;
  readonly artifacts: ArtifactStore;
  readonly dataLanes: readonly DataLane[];
  readonly assets?: readonly BrowserAsset[];
  readonly onRetryRun?: (run: ProductionBoardRunProjection) => Promise<void>;
  readonly onOpenLink?: (href: string) => void;
}

type BoardLoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly records: readonly ProductionRunRecordV1[] }
  | { readonly kind: 'error'; readonly message: string };

const SECTION_TABS: readonly PanelTabSpec[] = [
  { id: 'brief', label: 'Brief' },
  { id: 'scenes', label: 'Scenes' },
  { id: 'assets', label: 'Assets' },
  { id: 'jobs', label: 'Jobs' },
  { id: 'approvals', label: 'Approvals' },
  { id: 'qa', label: 'QA' },
  { id: 'events', label: 'Events' },
];

export function ProductionBoardPanel({
  store,
  authority,
  currentProjectRevision,
  artifacts,
  dataLanes,
  assets = [],
  onRetryRun,
  onOpenLink,
}: ProductionBoardPanelProps) {
  const [loadState, setLoadState] = useState<BoardLoadState>({ kind: 'loading' });
  const [status, setStatus] = useState<string | undefined>(undefined);

  const refresh = useCallback(async () => {
    setLoadState({ kind: 'loading' });
    try {
      setLoadState({ kind: 'loaded', records: await loadProductionBoardRecords(store) });
      setStatus(undefined);
    } catch (error) {
      setLoadState({ kind: 'error', message: message(error) });
    }
  }, [store]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const model = useMemo(() => {
    if (loadState.kind !== 'loaded') return undefined;
    return buildProductionBoardModel({
      records: loadState.records,
      currentProjectRevision,
      artifacts,
      dataLanes,
      assets,
    });
  }, [artifacts, assets, currentProjectRevision, dataLanes, loadState]);

  const approve = async (
    run: ProductionBoardRunProjection,
    approval: ProductionApprovalV1,
    decision: ContactSheetApprovalDecision,
  ) => {
    if (approval === undefined || store.respondToApproval === undefined) return;
    const result = await store.respondToApproval(run.runId, {
      approvalId: approval.approvalId,
      approved: decision.approved,
      responseRef: decision.responseId,
      response: decision.response,
      ...(decision.rejectionReason === undefined
        ? {}
        : { rejectionReason: decision.rejectionReason }),
      authority,
      expectedApprovalId: approval.approvalId,
      expectedRequestedSeq: approval.requestedSeq,
    });
    if (result.ok === false) {
      setStatus(`Approval failed: ${result.reason}`);
      return;
    }
    setStatus(decision.approved ? 'Approval recorded.' : 'Rejection recorded.');
    await refresh();
  };

  const cancel = async (run: ProductionBoardRunProjection) => {
    if (store.cancel === undefined) return;
    const result = await store.cancel(run.runId, {
      authority,
      expectedUpdatedSeq: run.updatedSeq,
    });
    if (result.ok === false) {
      setStatus(`Cancel failed: ${result.reason}`);
      return;
    }
    setStatus('Run canceled.');
    await refresh();
  };

  const retry = async (run: ProductionBoardRunProjection) => {
    if (onRetryRun === undefined) return;
    await onRetryRun(run);
    setStatus('Retry requested.');
    await refresh();
  };

  return (
    <ProductionBoardPanelView
      loadState={loadState.kind}
      {...(loadState.kind === 'error' ? { errorMessage: loadState.message } : {})}
      {...(model === undefined ? {} : { model })}
      {...(status === undefined ? {} : { status })}
      onRefresh={() => void refresh()}
      {...{
        onApproval: (
          run: ProductionBoardRunProjection,
          approval: ProductionApprovalV1,
          decision: ContactSheetApprovalDecision,
        ) => void approve(run, approval, decision),
        onCancel: (run: ProductionBoardRunProjection) => void cancel(run),
        onRetry: (run: ProductionBoardRunProjection) => void retry(run),
      }}
      retryAvailable={onRetryRun !== undefined}
      {...(onOpenLink === undefined ? {} : { onOpenLink })}
    />
  );
}

export async function loadProductionBoardRecords(
  store: ProductionBoardRunStore,
): Promise<readonly ProductionRunRecordV1[]> {
  const records: ProductionRunRecordV1[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  do {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) throw new Error('Production Board pagination loop detected');
      seenCursors.add(cursor);
    }
    const page = await store.list({
      limit: 100,
      ...(cursor === undefined ? {} : { cursor }),
    });
    records.push(...page.runs);
    cursor = page.nextCursor;
  } while (cursor !== undefined);

  return records;
}

export function ProductionBoardPanelView({
  loadState,
  errorMessage,
  model,
  status,
  retryAvailable = false,
  onRefresh,
  onApproval,
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
  readonly onApproval?: (
    run: ProductionBoardRunProjection,
    approval: ProductionApprovalV1,
    decision: ContactSheetApprovalDecision,
  ) => void;
  readonly onCancel?: (run: ProductionBoardRunProjection) => void;
  readonly onRetry?: (run: ProductionBoardRunProjection) => void;
  readonly onOpenLink?: (href: string) => void;
}) {
  const [section, setSection] = useState<ProductionBoardSectionId>('brief');
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
  const selectedId = productionBoardPrimaryRunId(model ?? { runs: [] }, selectedRunId);
  const selectedRun = model?.runs.find((run) => run.runId === selectedId);

  const note =
    status ??
    (loadState === 'loading'
      ? 'Loading durable production runs…'
      : loadState === 'error'
        ? `Production Board unavailable: ${errorMessage ?? 'Unknown error'}`
        : model?.isEmpty
          ? 'No durable production runs yet.'
          : undefined);

  return (
    <PanelShell
      title="Production"
      iconUrl={panelTabIconUrl('production')}
      className="production-board-panel"
      tabs={SECTION_TABS}
      activeTab={section}
      onTabChange={(id) => setSection(id as ProductionBoardSectionId)}
      note={note}
      actions={
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh Production Board"
          title="Refresh"
          onClick={onRefresh}
        >
          <RefreshIcon />
        </button>
      }
    >
      {loadState === 'loading' && <p className="production-board-empty">Loading runs…</p>}
      {loadState === 'error' && (
        <p className="production-board-error">Unable to load production runs.</p>
      )}
      {loadState === 'loaded' && model !== undefined && model.isEmpty && (
        <p className="production-board-empty">Start a Workflow to create a durable run.</p>
      )}
      {loadState === 'loaded' && model !== undefined && !model.isEmpty && (
        <div
          className="production-board"
          tabIndex={0}
          role="listbox"
          aria-label="Production runs"
          aria-activedescendant={
            selectedId === undefined ? undefined : `production-run-${selectedId}`
          }
          onKeyDown={(event) => {
            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
            event.preventDefault();
            const next = productionBoardNextRunId(
              model.runs,
              selectedId,
              event.key === 'ArrowDown' ? 'next' : 'previous',
            );
            setSelectedRunId(next);
          }}
        >
          <div className="production-board-groups" aria-label="Status groups">
            {model.groups.map((group) => (
              <section key={group.state} className="production-board-group">
                <h4>
                  {group.label}
                  <span>{group.runs.length}</span>
                </h4>
                <div className="production-board-run-list">
                  {group.runs.map((run) => (
                    <button
                      key={run.runId}
                      id={`production-run-${run.runId}`}
                      type="button"
                      role="option"
                      aria-selected={run.runId === selectedId}
                      className="production-board-run-button"
                      onClick={() => setSelectedRunId(run.runId)}
                    >
                      <strong>{run.workflowId}</strong>
                      <span>{run.runId}</span>
                      <span className={`production-board-state is-${run.state}`}>{run.state}</span>
                    </button>
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
              {...(onApproval === undefined ? {} : { onApproval })}
              {...(onCancel === undefined ? {} : { onCancel })}
              {...(onRetry === undefined ? {} : { onRetry })}
              {...(onOpenLink === undefined ? {} : { onOpenLink })}
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
  onApproval,
  onCancel,
  onRetry,
  onOpenLink,
}: {
  readonly run: ProductionBoardRunProjection;
  readonly section: ProductionBoardSectionId;
  readonly retryAvailable: boolean;
  readonly onApproval?: (
    run: ProductionBoardRunProjection,
    approval: ProductionApprovalV1,
    decision: ContactSheetApprovalDecision,
  ) => void;
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
          <p>
            v{run.workflowVersion} · checkpoint {run.checkpointRevision} · updated seq{' '}
            {run.updatedSeq}
          </p>
        </div>
        <span className="production-board-authority">{run.authorityBadge}</span>
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
          type="button"
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
        {section === 'approvals' &&
          run.pendingApprovals.map((approval) => (
            <ContactSheetApproval
              key={approval.approvalId}
              request={requestFromApproval(approval)}
              approvalId={approval.approvalId}
              initialResponse={approval.response}
              {...(approval.rejectionReason === undefined
                ? {}
                : { initialRejectionReason: approval.rejectionReason })}
              storageKey={`${run.runId}:${approval.approvalId}`}
              {...(typeof window === 'undefined' ? {} : { storage: window.localStorage })}
              onSubmit={(decision) => onApproval?.(run, approval, decision)}
            />
          ))}
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
                  )}
                </div>
                {item.detail.length > 0 && <p>{item.detail}</p>}
                {item.links.length > 0 && (
                  <div className="production-board-links">
                    {item.links.map((link) => (
                      <a
                        key={`${link.kind}:${link.id}`}
                        href={link.href}
                        title={link.label}
                        onClick={(event) => {
                          if (onOpenLink === undefined) return;
                          event.preventDefault();
                          onOpenLink(link.href);
                        }}
                      >
                        {displayBoardLinkLabel(link)}
                      </a>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function requestFromApproval(approval: ProductionApprovalV1): HumanInputRequest {
  return {
    kind: approval.kind,
    prompt: approval.prompt,
    ...(approval.requestPayload === undefined ? {} : { payload: approval.requestPayload }),
  };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayBoardLinkLabel(link: { readonly kind: string; readonly label: string }): string {
  if (link.kind === 'artifact' && link.label.startsWith('Reference analysis ')) {
    return `View ${link.label.toLowerCase()}`;
  }
  return link.label;
}
