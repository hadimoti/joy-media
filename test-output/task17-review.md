# Review package: b50a2bf..c3d042a

## Commits
c3d042a feat(editor): add the durable JOY Production Board

## Files changed
 apps/editor-web/src/App.tsx                        |  30 ++
 apps/editor-web/src/ProductionBoardPanel.test.tsx  | 199 ++++++++++
 apps/editor-web/src/ProductionBoardPanel.tsx       | 421 ++++++++++++++++++++
 apps/editor-web/src/app.css                        | 240 +++++++++++
 apps/editor-web/src/dock-layout.ts                 |   3 +-
 apps/editor-web/src/panel-tab-icons.ts             |   2 +
 apps/editor-web/src/production-board-model.test.ts | 294 ++++++++++++++
 apps/editor-web/src/production-board-model.ts      | 442 +++++++++++++++++++++
 apps/editor-web/src/workspace.ts                   |   2 +
 docs/TASK17-IMPLEMENTER-REPORT-2026-08-22.md       |  38 ++
 10 files changed, 1670 insertions(+), 1 deletion(-)

## Diff
diff --git a/apps/editor-web/src/App.tsx b/apps/editor-web/src/App.tsx
index acbbed6..601c8a0 100644
--- a/apps/editor-web/src/App.tsx
+++ b/apps/editor-web/src/App.tsx
@@ -127,20 +127,21 @@ import {
   AgentPanel,
   type AgentPanelCommand,
   type AgentPanelCommandType,
   type KiloCodeAttachedAsset,
 } from './AgentPanel.js';
 import { openJoyCodeOpfsAssetCache } from './joycode-opfs-assets.js';
 import { AgentSettingsDialog } from './AgentSettingsDialog.js';
 import { loadAgentSettings, saveAgentSettings, type AgentSettings } from './agent-settings.js';
 import { HistoryPanel } from './HistoryPanel.js';
 import { WorkflowsPanel } from './WorkflowsPanel.js';
+import { ProductionBoardPanel } from './ProductionBoardPanel.js';
 import { BrowserProductionRunStore } from './browser-production-run-store.js';
 import { PluginsPanel } from './PluginsPanel.js';
 import { TemplatesPanel } from './TemplatesPanel.js';
 import { buildContentTemplateTransaction } from './content-template-transaction.js';
 import { createEditorPluginHost } from './plugin-host.js';
 import { createAgentCommandBus } from './agent-command-bus.js';
 import { createProductionFirstPartyLibrary } from './first-party-handlers.js';
 import { resumeWorkflow, runWorkflow } from './workflow-runner.js';
 import {
   getOrCreateControlPlaneProjectBinding,
@@ -2839,20 +2840,49 @@ function EditorWorkspace({
                 status: 'failed' as const,
                 workflowId: 'unknown',
                 runId,
                 error: error instanceof Error ? error.message : String(error),
               };
             }
           }}
         />
       );
     }
+    if (api.id === 'production') {
+      return (
+        <ProductionBoardPanel
+          store={productionRunStore}
+          authority={workflowAuthority}
+          currentProjectRevision={context.session.projectRevisionId}
+          artifacts={context.artifacts ?? { artifacts: {}, versions: {} }}
+          dataLanes={context.dataLanes ?? []}
+          assets={Object.values(monitorAssetCatalog.assets)}
+          onOpenLink={(href) => {
+            if (href.startsWith('#data-lane:') || href.startsWith('#artifact:')) {
+              context.activatePanel('timeline');
+              return;
+            }
+            if (href.startsWith('#asset:')) {
+              context.activatePanel('media');
+              return;
+            }
+            if (
+              href.startsWith('#job:') ||
+              href.startsWith('#provider:') ||
+              href.startsWith('#report:')
+            ) {
+              context.activatePanel('jobs');
+            }
+          }}
+        />
+      );
+    }
     if (api.id === 'plugins') {
       return <PluginsPanel pluginHost={context.pluginHost} onChange={context.bumpPluginRevision} />;
     }
     if (api.id === 'templates') {
       return (
         <TemplatesPanel
           session={context.session}
           selectedClipIds={state.selectedIds}
           playheadUs={state.playheadUs}
           onApplyTemplate={(seeded) => {
diff --git a/apps/editor-web/src/ProductionBoardPanel.test.tsx b/apps/editor-web/src/ProductionBoardPanel.test.tsx
new file mode 100644
index 0000000..ef946a5
--- /dev/null
+++ b/apps/editor-web/src/ProductionBoardPanel.test.tsx
@@ -0,0 +1,199 @@
+import { renderToStaticMarkup } from 'react-dom/server';
+import { describe, expect, it } from 'vitest';
+import type { ArtifactStore } from '@joy-media/commands';
+import type { ProductionRunRecordV1 } from '@joy-media/workflow-engine';
+import { ProductionBoardPanelView } from './ProductionBoardPanel.js';
+import { buildProductionBoardModel } from './production-board-model.js';
+
+const emptyArtifacts: ArtifactStore = { artifacts: {}, versions: {} };
+
+describe('ProductionBoardPanel', () => {
+  it('renders loading, error, and empty states', () => {
+    expect(renderToStaticMarkup(<ProductionBoardPanelView loadState="loading" />)).toContain(
+      'Loading runs',
+    );
+    expect(
+      renderToStaticMarkup(
+        <ProductionBoardPanelView loadState="error" errorMessage="network down" />,
+      ),
+    ).toContain('Production Board unavailable: network down');
+    expect(
+      renderToStaticMarkup(
+        <ProductionBoardPanelView
+          loadState="loaded"
+          model={buildProductionBoardModel({
+            records: [],
+            currentProjectRevision: 'rev-1',
+            artifacts: emptyArtifacts,
+            dataLanes: [],
+          })}
+        />,
+      ),
+    ).toContain('Start a Workflow');
+  });
+
+  it('renders status groups, authority badge, sections, and action availability', () => {
+    const model = buildProductionBoardModel({
+      records: [
+        run({
+          state: 'parked',
+          approvals: [
+            {
+              approvalVersion: 1,
+              approvalId: 'approval-1',
+              nodeId: 'scene-candidates',
+              kind: 'choose-candidates',
+              prompt: 'Choose candidates',
+              state: 'pending',
+              requestedSeq: 2,
+            },
+          ],
+          nodes: [
+            node({
+              nodeId: 'scene-candidates',
+              type: 'scene.candidates',
+              category: 'scene',
+              state: 'waiting_for_input',
+              pendingApprovalId: 'approval-1',
+            }),
+          ],
+        }),
+      ],
+      currentProjectRevision: 'rev-1',
+      artifacts: emptyArtifacts,
+      dataLanes: [],
+    });
+
+    const markup = renderToStaticMarkup(
+      <ProductionBoardPanelView loadState="loaded" model={model} retryAvailable />,
+    );
+
+    expect(markup).toContain('Needs review');
+    expect(markup).toContain('Producer · owner');
+    expect(markup).toContain('Brief/Input');
+    expect(markup).toContain('Approve');
+    expect(markup).toContain('>Approve</button>');
+    expect(markup).toContain('>Reject</button>');
+    expect(markup).toContain('disabled=""><svg');
+  });
+
+  it('renders stale revision conflicts and artifact/provider/report links', () => {
+    const artifacts: ArtifactStore = {
+      artifacts: {
+        'artifact-1': {
+          id: 'artifact-1',
+          kind: 'renderOutput',
+          schemaVersion: 1,
+          revision: 1,
+          label: 'Verified delivery',
+          contentRef: { type: 'asset', assetId: 'asset-1' },
+          binding: { type: 'none' },
+          provenance: {
+            sourceArtifactIds: [],
+            inputHashes: [],
+            createdBy: { type: 'agent', id: 'joy-code' },
+            workflowNodeId: 'delivery-qa',
+          },
+          createdAt: '2026-08-22T00:00:00.000Z',
+          updatedAt: '2026-08-22T00:00:00.000Z',
+        },
+      },
+      versions: {},
+    };
+    const model = buildProductionBoardModel({
+      records: [
+        run({
+          projectRevision: 'old-rev',
+          links: {
+            providerRunId: 'provider-1',
+            reportId: 'report-1',
+            artifactIds: ['artifact-1'],
+          },
+        }),
+      ],
+      currentProjectRevision: 'rev-1',
+      artifacts,
+      dataLanes: [
+        {
+          id: 'lane:generation',
+          kind: 'generation',
+          label: 'Generated',
+          items: [
+            {
+              id: 'artifact:artifact-1',
+              label: 'Verified delivery',
+              kind: 'generation',
+              artifactId: 'artifact-1',
+              versionCount: 0,
+              pinned: false,
+              stale: true,
+              detail: 'rev 1',
+            },
+          ],
+        },
+      ],
+    });
+
+    const markup = renderToStaticMarkup(
+      <ProductionBoardPanelView loadState="loaded" model={model} />,
+    );
+
+    expect(markup).toContain('Stale project revision');
+    expect(markup).toContain('Project revision changed since this run parked');
+    expect(markup).toContain('Provider provider-1');
+    expect(markup).toContain('Report report-1');
+    expect(markup).toContain('Artifact Verified delivery');
+    expect(markup).toContain('Generated lane');
+  });
+});
+
+function run(overrides: Partial<ProductionRunRecordV1> = {}): ProductionRunRecordV1 {
+  const state = overrides.state ?? 'parked';
+  return {
+    recordVersion: 1,
+    runId: 'run-1',
+    workflowId: 'joy.workflow.production',
+    workflowVersion: '1.0.0',
+    projectRevision: 'rev-1',
+    state,
+    checkpointRevision: 1,
+    workflowInputs: { brief: 'make a short' },
+    links: {},
+    events: [
+      {
+        eventVersion: 1,
+        seq: 1,
+        type: 'run.queued',
+        state: 'queued',
+        checkpointRevision: 0,
+        actor: { principalId: 'owner-1', role: 'owner', displayName: 'Producer' },
+      },
+      {
+        eventVersion: 1,
+        seq: 2,
+        type: 'run.parked',
+        state,
+        checkpointRevision: 1,
+      },
+    ],
+    approvals: [],
+    nodes: [],
+    createdSeq: 1,
+    updatedSeq: 2,
+    ...overrides,
+  };
+}
+
+function node(
+  overrides: Partial<ProductionRunRecordV1['nodes'][number]> &
+    Pick<ProductionRunRecordV1['nodes'][number], 'nodeId' | 'type' | 'category' | 'state'>,
+): ProductionRunRecordV1['nodes'][number] {
+  return {
+    attempts: 1,
+    deterministic: true,
+    reused: false,
+    logs: [],
+    artifactIds: [],
+    ...overrides,
+  };
+}
diff --git a/apps/editor-web/src/ProductionBoardPanel.tsx b/apps/editor-web/src/ProductionBoardPanel.tsx
new file mode 100644
index 0000000..9263ef1
--- /dev/null
+++ b/apps/editor-web/src/ProductionBoardPanel.tsx
@@ -0,0 +1,421 @@
+import { useCallback, useEffect, useMemo, useState } from 'react';
+import type {
+  ProductionRunAuthority,
+  ProductionRunRecordV1,
+  RecordProductionApprovalResponseInput,
+  RecordProductionApprovalResponseResult,
+} from '@joy-media/workflow-engine';
+import type { ArtifactStore } from '@joy-media/commands';
+import type { DataLane } from './data-lanes.js';
+import type { BrowserAsset } from './control-plane-client.js';
+import {
+  buildProductionBoardModel,
+  productionBoardNextRunId,
+  productionBoardPrimaryRunId,
+  type ProductionBoardModel,
+  type ProductionBoardRunProjection,
+  type ProductionBoardSectionId,
+} from './production-board-model.js';
+import { CheckIcon, CloseIcon, RefreshIcon } from './icons.js';
+import { PanelShell, type PanelTabSpec } from './PanelShell.js';
+import { panelTabIconUrl } from './panel-tab-icons.js';
+
+export interface ProductionBoardRunStore {
+  list(options?: {
+    readonly limit?: number;
+  }): Promise<{ readonly runs: readonly ProductionRunRecordV1[] }>;
+  respondToApproval?(
+    runId: string,
+    response: RecordProductionApprovalResponseInput & {
+      readonly expectedApprovalId?: string;
+      readonly expectedRequestedSeq?: number;
+    },
+  ): Promise<
+    RecordProductionApprovalResponseResult | { readonly ok: false; readonly reason: string }
+  >;
+  cancel?(
+    runId: string,
+    input: { readonly authority: ProductionRunAuthority; readonly expectedUpdatedSeq?: number },
+  ): Promise<
+    | { readonly ok: true; readonly record: ProductionRunRecordV1 }
+    | { readonly ok: false; readonly reason: string }
+  >;
+}
+
+export interface ProductionBoardPanelProps {
+  readonly store: ProductionBoardRunStore;
+  readonly authority: ProductionRunAuthority;
+  readonly currentProjectRevision: string;
+  readonly artifacts: ArtifactStore;
+  readonly dataLanes: readonly DataLane[];
+  readonly assets?: readonly BrowserAsset[];
+  readonly onRetryRun?: (run: ProductionBoardRunProjection) => Promise<void>;
+  readonly onOpenLink?: (href: string) => void;
+}
+
+type BoardLoadState =
+  | { readonly kind: 'loading' }
+  | { readonly kind: 'loaded'; readonly records: readonly ProductionRunRecordV1[] }
+  | { readonly kind: 'error'; readonly message: string };
+
+const SECTION_TABS: readonly PanelTabSpec[] = [
+  { id: 'brief', label: 'Brief' },
+  { id: 'scenes', label: 'Scenes' },
+  { id: 'assets', label: 'Assets' },
+  { id: 'jobs', label: 'Jobs' },
+  { id: 'approvals', label: 'Approvals' },
+  { id: 'qa', label: 'QA' },
+  { id: 'events', label: 'Events' },
+];
+
+export function ProductionBoardPanel({
+  store,
+  authority,
+  currentProjectRevision,
+  artifacts,
+  dataLanes,
+  assets = [],
+  onRetryRun,
+  onOpenLink,
+}: ProductionBoardPanelProps) {
+  const [loadState, setLoadState] = useState<BoardLoadState>({ kind: 'loading' });
+  const [status, setStatus] = useState<string | undefined>(undefined);
+
+  const refresh = useCallback(async () => {
+    setLoadState({ kind: 'loading' });
+    try {
+      const result = await store.list({ limit: 100 });
+      setLoadState({ kind: 'loaded', records: result.runs });
+      setStatus(undefined);
+    } catch (error) {
+      setLoadState({ kind: 'error', message: message(error) });
+    }
+  }, [store]);
+
+  useEffect(() => {
+    void refresh();
+  }, [refresh]);
+
+  const model = useMemo(() => {
+    if (loadState.kind !== 'loaded') return undefined;
+    return buildProductionBoardModel({
+      records: loadState.records,
+      currentProjectRevision,
+      artifacts,
+      dataLanes,
+      assets,
+    });
+  }, [artifacts, assets, currentProjectRevision, dataLanes, loadState]);
+
+  const approve = async (run: ProductionBoardRunProjection, approved: boolean) => {
+    const approval = run.pendingApprovals[0];
+    if (approval === undefined || store.respondToApproval === undefined) return;
+    const result = await store.respondToApproval(run.runId, {
+      approvalId: approval.approvalId,
+      approved,
+      responseRef: `${run.runId}:${approval.approvalId}:${approved ? 'approved' : 'rejected'}`,
+      authority,
+      expectedApprovalId: approval.approvalId,
+      expectedRequestedSeq: approval.requestedSeq,
+    });
+    if (result.ok === false) {
+      setStatus(`Approval failed: ${result.reason}`);
+      return;
+    }
+    setStatus(approved ? 'Approval recorded.' : 'Rejection recorded.');
+    await refresh();
+  };
+
+  const cancel = async (run: ProductionBoardRunProjection) => {
+    if (store.cancel === undefined) return;
+    const result = await store.cancel(run.runId, {
+      authority,
+      expectedUpdatedSeq: run.updatedSeq,
+    });
+    if (result.ok === false) {
+      setStatus(`Cancel failed: ${result.reason}`);
+      return;
+    }
+    setStatus('Run canceled.');
+    await refresh();
+  };
+
+  const retry = async (run: ProductionBoardRunProjection) => {
+    if (onRetryRun === undefined) return;
+    await onRetryRun(run);
+    setStatus('Retry requested.');
+    await refresh();
+  };
+
+  return (
+    <ProductionBoardPanelView
+      loadState={loadState.kind}
+      errorMessage={loadState.kind === 'error' ? loadState.message : undefined}
+      model={model}
+      status={status}
+      onRefresh={() => void refresh()}
+      onApprove={(run) => void approve(run, true)}
+      onReject={(run) => void approve(run, false)}
+      onCancel={(run) => void cancel(run)}
+      onRetry={(run) => void retry(run)}
+      retryAvailable={onRetryRun !== undefined}
+      onOpenLink={onOpenLink}
+    />
+  );
+}
+
+export function ProductionBoardPanelView({
+  loadState,
+  errorMessage,
+  model,
+  status,
+  retryAvailable = false,
+  onRefresh,
+  onApprove,
+  onReject,
+  onCancel,
+  onRetry,
+  onOpenLink,
+}: {
+  readonly loadState: 'loading' | 'loaded' | 'error';
+  readonly errorMessage?: string;
+  readonly model?: ProductionBoardModel;
+  readonly status?: string;
+  readonly retryAvailable?: boolean;
+  readonly onRefresh?: () => void;
+  readonly onApprove?: (run: ProductionBoardRunProjection) => void;
+  readonly onReject?: (run: ProductionBoardRunProjection) => void;
+  readonly onCancel?: (run: ProductionBoardRunProjection) => void;
+  readonly onRetry?: (run: ProductionBoardRunProjection) => void;
+  readonly onOpenLink?: (href: string) => void;
+}) {
+  const [section, setSection] = useState<ProductionBoardSectionId>('brief');
+  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(undefined);
+  const selectedId = productionBoardPrimaryRunId(model ?? { runs: [] }, selectedRunId);
+  const selectedRun = model?.runs.find((run) => run.runId === selectedId);
+
+  const note =
+    status ??
+    (loadState === 'loading'
+      ? 'Loading durable production runs…'
+      : loadState === 'error'
+        ? `Production Board unavailable: ${errorMessage ?? 'Unknown error'}`
+        : model?.isEmpty
+          ? 'No durable production runs yet.'
+          : undefined);
+
+  return (
+    <PanelShell
+      title="Production"
+      iconUrl={panelTabIconUrl('production')}
+      className="production-board-panel"
+      tabs={SECTION_TABS}
+      activeTab={section}
+      onTabChange={(id) => setSection(id as ProductionBoardSectionId)}
+      note={note}
+      actions={
+        <button
+          type="button"
+          className="icon-button"
+          aria-label="Refresh Production Board"
+          title="Refresh"
+          onClick={onRefresh}
+        >
+          <RefreshIcon />
+        </button>
+      }
+    >
+      {loadState === 'loading' && <p className="production-board-empty">Loading runs…</p>}
+      {loadState === 'error' && (
+        <p className="production-board-error">Unable to load production runs.</p>
+      )}
+      {loadState === 'loaded' && model !== undefined && model.isEmpty && (
+        <p className="production-board-empty">Start a Workflow to create a durable run.</p>
+      )}
+      {loadState === 'loaded' && model !== undefined && !model.isEmpty && (
+        <div
+          className="production-board"
+          tabIndex={0}
+          role="listbox"
+          aria-label="Production runs"
+          aria-activedescendant={
+            selectedId === undefined ? undefined : `production-run-${selectedId}`
+          }
+          onKeyDown={(event) => {
+            if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
+            event.preventDefault();
+            const next = productionBoardNextRunId(
+              model.runs,
+              selectedId,
+              event.key === 'ArrowDown' ? 'next' : 'previous',
+            );
+            setSelectedRunId(next);
+          }}
+        >
+          <div className="production-board-groups" aria-label="Status groups">
+            {model.groups.map((group) => (
+              <section key={group.state} className="production-board-group">
+                <h4>
+                  {group.label}
+                  <span>{group.runs.length}</span>
+                </h4>
+                <div className="production-board-run-list">
+                  {group.runs.map((run) => (
+                    <button
+                      key={run.runId}
+                      id={`production-run-${run.runId}`}
+                      type="button"
+                      role="option"
+                      aria-selected={run.runId === selectedId}
+                      className="production-board-run-button"
+                      onClick={() => setSelectedRunId(run.runId)}
+                    >
+                      <strong>{run.workflowId}</strong>
+                      <span>{run.runId}</span>
+                      <span className={`production-board-state is-${run.state}`}>{run.state}</span>
+                    </button>
+                  ))}
+                </div>
+              </section>
+            ))}
+          </div>
+          {selectedRun !== undefined && (
+            <RunDetails
+              run={selectedRun}
+              section={section}
+              retryAvailable={retryAvailable}
+              onApprove={onApprove}
+              onReject={onReject}
+              onCancel={onCancel}
+              onRetry={onRetry}
+              onOpenLink={onOpenLink}
+            />
+          )}
+        </div>
+      )}
+    </PanelShell>
+  );
+}
+
+function RunDetails({
+  run,
+  section,
+  retryAvailable,
+  onApprove,
+  onReject,
+  onCancel,
+  onRetry,
+  onOpenLink,
+}: {
+  readonly run: ProductionBoardRunProjection;
+  readonly section: ProductionBoardSectionId;
+  readonly retryAvailable: boolean;
+  readonly onApprove?: (run: ProductionBoardRunProjection) => void;
+  readonly onReject?: (run: ProductionBoardRunProjection) => void;
+  readonly onCancel?: (run: ProductionBoardRunProjection) => void;
+  readonly onRetry?: (run: ProductionBoardRunProjection) => void;
+  readonly onOpenLink?: (href: string) => void;
+}) {
+  const active = run.sections[section];
+  return (
+    <section className="production-board-detail" aria-label={`Production run ${run.runId}`}>
+      <div className="production-board-detail-head">
+        <div>
+          <h4>{run.workflowId}</h4>
+          <p>
+            v{run.workflowVersion} · checkpoint {run.checkpointRevision} · updated seq{' '}
+            {run.updatedSeq}
+          </p>
+        </div>
+        <span className="production-board-authority">{run.authorityBadge}</span>
+      </div>
+      {run.staleRevisionConflict && (
+        <p className="production-board-conflict" role="alert">
+          Stale project revision: this run parked on {run.projectRevision}.
+        </p>
+      )}
+      {run.actions.disabledReason !== undefined && (
+        <p className="production-board-action-note">{run.actions.disabledReason}</p>
+      )}
+      <div className="production-board-actions" aria-label="Run actions">
+        <button
+          type="button"
+          className="icon-button icon-button-labeled"
+          disabled={!run.actions.canApprove}
+          onClick={() => onApprove?.(run)}
+        >
+          <CheckIcon />
+          Approve
+        </button>
+        <button
+          type="button"
+          className="icon-button icon-button-labeled"
+          disabled={!run.actions.canReject}
+          onClick={() => onReject?.(run)}
+        >
+          <CloseIcon />
+          Reject
+        </button>
+        <button
+          type="button"
+          className="icon-button icon-button-labeled"
+          disabled={!run.actions.canRetry || !retryAvailable}
+          onClick={() => onRetry?.(run)}
+        >
+          <RefreshIcon />
+          Retry
+        </button>
+        <button
+          type="button"
+          className="icon-button icon-button-labeled"
+          disabled={!run.actions.canCancel}
+          onClick={() => onCancel?.(run)}
+        >
+          <CloseIcon />
+          Cancel
+        </button>
+      </div>
+      <div className="production-board-section">
+        <h4>{active.label}</h4>
+        {active.items.length === 0 ? (
+          <p className="production-board-empty">No {active.label.toLowerCase()} projection yet.</p>
+        ) : (
+          <ul>
+            {active.items.map((item) => (
+              <li key={item.id}>
+                <div className="production-board-item-main">
+                  <strong>{item.title}</strong>
+                  {item.state !== undefined && (
+                    <span className="production-board-node-state">{item.state}</span>
+                  )}
+                </div>
+                {item.detail.length > 0 && <p>{item.detail}</p>}
+                {item.links.length > 0 && (
+                  <div className="production-board-links">
+                    {item.links.map((link) => (
+                      <a
+                        key={`${link.kind}:${link.id}`}
+                        href={link.href}
+                        onClick={(event) => {
+                          if (onOpenLink === undefined) return;
+                          event.preventDefault();
+                          onOpenLink(link.href);
+                        }}
+                      >
+                        {link.label}
+                      </a>
+                    ))}
+                  </div>
+                )}
+              </li>
+            ))}
+          </ul>
+        )}
+      </div>
+    </section>
+  );
+}
+
+function message(error: unknown): string {
+  return error instanceof Error ? error.message : String(error);
+}
diff --git a/apps/editor-web/src/app.css b/apps/editor-web/src/app.css
index fe11a4b..d6f79b7 100644
--- a/apps/editor-web/src/app.css
+++ b/apps/editor-web/src/app.css
@@ -2706,20 +2706,260 @@ label {
   white-space: nowrap;
   cursor: pointer;
 }
 .jobs-pair-submit:hover:not(:disabled) {
   background: #35353a;
 }
 .jobs-pair-submit:disabled {
   opacity: 0.35;
   cursor: not-allowed;
 }
+
+/* ─── Production Board ───────────────────────────────────────────────────── */
+
+.production-board-panel .joy-panel-body {
+  gap: 0.45rem;
+}
+
+.production-board {
+  min-height: 0;
+  display: grid;
+  grid-template-columns: minmax(8rem, 0.78fr) minmax(0, 1.22fr);
+  gap: 0.45rem;
+  overflow: hidden;
+}
+
+.production-board-groups,
+.production-board-detail {
+  min-width: 0;
+  min-height: 0;
+  overflow-y: auto;
+  scrollbar-width: thin;
+}
+
+.production-board-groups {
+  display: flex;
+  flex-direction: column;
+  gap: 0.45rem;
+}
+
+.production-board-group,
+.production-board-section {
+  display: grid;
+  gap: 0.35rem;
+}
+
+.production-board-group h4,
+.production-board-section h4 {
+  display: flex;
+  align-items: center;
+  justify-content: space-between;
+  gap: 0.5rem;
+  margin: 0;
+  color: var(--joy-text-muted);
+  font-size: 0.66rem;
+  font-weight: 650;
+}
+
+.production-board-group h4 span {
+  color: var(--joy-text-faint);
+  font-variant-numeric: tabular-nums;
+}
+
+.production-board-run-list {
+  display: grid;
+  gap: 0.25rem;
+}
+
+.production-board-run-button {
+  min-width: 0;
+  display: grid;
+  grid-template-columns: minmax(0, 1fr) auto;
+  gap: 0.12rem 0.35rem;
+  padding: 0.42rem 0.45rem;
+  border: 1px solid var(--joy-border);
+  border-radius: var(--radius-sm);
+  background: var(--joy-bg-inset);
+  color: var(--joy-text);
+  font: inherit;
+  font-size: 0.66rem;
+  text-align: start;
+  cursor: pointer;
+}
+
+.production-board-run-button:hover,
+.production-board-run-button[aria-selected='true'] {
+  border-color: color-mix(in srgb, var(--joy-accent) 45%, var(--joy-border));
+  background: var(--joy-bg-hover);
+}
+
+.production-board-run-button strong,
+.production-board-run-button span:first-of-type {
+  min-width: 0;
+  overflow: hidden;
+  text-overflow: ellipsis;
+  white-space: nowrap;
+}
+
+.production-board-run-button span:first-of-type {
+  grid-column: 1 / -1;
+  color: var(--joy-text-faint);
+  font-family: var(--joy-font-mono);
+  font-size: 0.58rem;
+}
+
+.production-board-state,
+.production-board-node-state,
+.production-board-authority {
+  display: inline-flex;
+  align-items: center;
+  min-height: 1.05rem;
+  padding: 0 0.35rem;
+  border: 1px solid var(--joy-border-subtle);
+  border-radius: var(--radius-xs);
+  background: var(--joy-bg-control);
+  color: var(--joy-text-muted);
+  font-size: 0.56rem;
+  line-height: 1;
+  white-space: nowrap;
+}
+
+.production-board-state.is-parked {
+  color: var(--joy-accent);
+}
+
+.production-board-state.is-failed,
+.production-board-error,
+.production-board-conflict {
+  color: var(--joy-danger);
+}
+
+.production-board-state.is-succeeded {
+  color: var(--joy-success);
+}
+
+.production-board-detail {
+  display: flex;
+  flex-direction: column;
+  gap: 0.45rem;
+}
+
+.production-board-detail-head {
+  display: grid;
+  grid-template-columns: minmax(0, 1fr) auto;
+  gap: 0.45rem;
+  align-items: start;
+  padding-bottom: 0.45rem;
+  border-bottom: 1px solid var(--joy-border-subtle);
+}
+
+.production-board-detail-head h4,
+.production-board-detail-head p,
+.production-board-section p,
+.production-board-empty,
+.production-board-error,
+.production-board-conflict,
+.production-board-action-note {
+  margin: 0;
+}
+
+.production-board-detail-head h4 {
+  color: var(--joy-text);
+  font-size: 0.78rem;
+}
+
+.production-board-detail-head p,
+.production-board-section p,
+.production-board-empty,
+.production-board-action-note {
+  color: var(--joy-text-faint);
+  font-size: 0.64rem;
+}
+
+.production-board-conflict,
+.production-board-action-note {
+  padding: 0.36rem 0.45rem;
+  border: 1px solid color-mix(in srgb, var(--joy-danger) 40%, var(--joy-border));
+  border-radius: var(--radius-sm);
+  background: color-mix(in srgb, var(--joy-danger) 10%, transparent);
+  font-size: 0.64rem;
+}
+
+.production-board-actions {
+  display: flex;
+  flex-wrap: wrap;
+  gap: 0.25rem;
+}
+
+.production-board-actions .icon-button-labeled {
+  width: auto;
+  min-width: 4.6rem;
+  padding: 0 0.45rem;
+  gap: 0.3rem;
+}
+
+.production-board-section ul {
+  display: grid;
+  gap: 0.3rem;
+  margin: 0;
+  padding: 0;
+  list-style: none;
+}
+
+.production-board-section li {
+  display: grid;
+  gap: 0.22rem;
+  padding: 0.45rem;
+  border: 1px solid var(--joy-border-subtle);
+  border-radius: var(--radius-sm);
+  background: var(--joy-bg-inset);
+}
+
+.production-board-item-main {
+  display: flex;
+  align-items: center;
+  gap: 0.35rem;
+  min-width: 0;
+}
+
+.production-board-item-main strong {
+  min-width: 0;
+  flex: 1;
+  overflow: hidden;
+  color: var(--joy-text);
+  font-size: 0.68rem;
+  text-overflow: ellipsis;
+  white-space: nowrap;
+}
+
+.production-board-links {
+  display: flex;
+  flex-wrap: wrap;
+  gap: 0.25rem;
+}
+
+.production-board-links a {
+  color: var(--joy-accent);
+  font-size: 0.61rem;
+  text-decoration: none;
+}
+
+.production-board-links a:hover {
+  text-decoration: underline;
+}
+
+@container (max-width: 420px) {
+  .production-board {
+    grid-template-columns: 1fr;
+  }
+}
+
 .jobs-section {
   display: grid;
   gap: 0.4rem;
   min-width: 0;
 }
 .jobs-section-head {
   display: flex;
   align-items: baseline;
   justify-content: space-between;
   gap: 0.5rem;
diff --git a/apps/editor-web/src/dock-layout.ts b/apps/editor-web/src/dock-layout.ts
index f7aa201..cdfd97a 100644
--- a/apps/editor-web/src/dock-layout.ts
+++ b/apps/editor-web/src/dock-layout.ts
@@ -28,21 +28,21 @@
  */
 
 import { PANEL_IDS, type PanelId } from './workspace.js';
 import { panelLabel } from './panel-tab-icons.js';
 
 export type EditorViewMode = 'vertical' | 'widescreen';
 
 export const VIEW_MODE_KEY = 'joy-media.view-mode.v1';
 
 /** Per-mode Dockview JSON keys (bump when a seed changes). */
-export const DOCK_LAYOUT_VERSION = 9;
+export const DOCK_LAYOUT_VERSION = 10;
 
 /** @deprecated Prefer `dockLayoutKey(mode)` — kept for migration of v8 saves. */
 export const DOCK_LAYOUT_KEY = 'joy-media.dockview.v8';
 
 export const SUPERSEDED_DOCK_LAYOUT_KEYS: readonly string[] = [
   'joy-media.dockview.v1',
   'joy-media.dockview.v2',
   'joy-media.dockview.v3',
   'joy-media.dockview.v4',
   'joy-media.dockview.v5',
@@ -68,20 +68,21 @@ const BROWSER_GROUP = [
   'plugins',
 ] as const;
 
 const CONTEXT_GROUP = [
   'inspector',
   'motion',
   'history',
   'jobs',
   'diagnostics',
   'workflows',
+  'production',
   'camera',
 ] as const;
 
 export interface ViewModeStorage {
   getItem(key: string): string | null;
   setItem(key: string, value: string): void;
   removeItem(key: string): void;
 }
 
 export function dockLayoutKey(mode: EditorViewMode): string {
diff --git a/apps/editor-web/src/panel-tab-icons.ts b/apps/editor-web/src/panel-tab-icons.ts
index c39125d..f4469be 100644
--- a/apps/editor-web/src/panel-tab-icons.ts
+++ b/apps/editor-web/src/panel-tab-icons.ts
@@ -16,20 +16,21 @@ export const PANEL_LABELS: Readonly<Record<PanelId, string>> = {
   camera: 'Camera',
   audio: 'Audio',
   effects: 'Effects',
   transitions: 'Transitions',
   color: 'Color',
   history: 'History',
   diagnostics: 'Diagnostics',
   jobs: 'Jobs',
   agent: 'Joy Code',
   workflows: 'Workflows',
+  production: 'Production',
   plugins: 'Plugins',
   templates: 'Templates',
 };
 
 /**
  * Dockview panel tab glyphs. Prefer uploaded `ui/` 24×24 PNGs where they map
  * cleanly; fall back to the older black-on-transparent set. Masked with
  * `currentColor` so active/inactive tab colors from DESIGN.md §1 apply.
  */
 export const PANEL_TAB_ICONS: Readonly<Partial<Record<PanelId, string>>> = {
@@ -43,20 +44,21 @@ export const PANEL_TAB_ICONS: Readonly<Partial<Record<PanelId, string>>> = {
   motion: iconUrl('ui/motion_24x24.png'),
   camera: iconUrl('camera.png'),
   effects: iconUrl('ui/effects-org_24x24.png'),
   transitions: iconUrl('ui/blend_24x24.png'),
   color: iconUrl('ui/contrast_24x24.png'),
   history: iconUrl('history2.png'),
   diagnostics: iconUrl('diagnostic.png'),
   jobs: iconUrl('job.png'),
   agent: iconUrl('ui/agent-ai_24x24.png'),
   workflows: iconUrl('workflow.png'),
+  production: iconUrl('job.png'),
   plugins: iconUrl('plugin.png'),
   templates: iconUrl('24_templates.png'),
 };
 
 /** Inline SVG tab icons (preferred over PNG masks when present). */
 export const PANEL_TAB_SVG_ICONS: Readonly<Partial<Record<PanelId, ComponentType>>> = {
   audio: SpeakerOnIcon,
   timeline: TimelineClassicIcon,
 };
 
diff --git a/apps/editor-web/src/production-board-model.test.ts b/apps/editor-web/src/production-board-model.test.ts
new file mode 100644
index 0000000..73b32cc
--- /dev/null
+++ b/apps/editor-web/src/production-board-model.test.ts
@@ -0,0 +1,294 @@
+import { describe, expect, it } from 'vitest';
+import type { ArtifactStore } from '@joy-media/commands';
+import type { ProductionRunRecordV1 } from '@joy-media/workflow-engine';
+import {
+  buildProductionBoardModel,
+  productionBoardNextRunId,
+  productionBoardPrimaryRunId,
+} from './production-board-model.js';
+
+const artifacts: ArtifactStore = {
+  artifacts: {
+    'artifact-scene-1': {
+      id: 'artifact-scene-1',
+      kind: 'generatedMedia',
+      schemaVersion: 1,
+      revision: 2,
+      label: 'Opening b-roll',
+      contentRef: { type: 'asset', assetId: 'asset-video-1' },
+      binding: { type: 'range', startUs: 0, durationUs: 2_000_000 },
+      provenance: {
+        sourceArtifactIds: [],
+        inputHashes: ['hash-1'],
+        createdBy: { type: 'agent', id: 'joy-code' },
+        workflowNodeId: 'asset-broll',
+        jobId: 'job-1',
+        providerId: 'runway',
+        modelId: 'gen-3',
+        cost: { amount: '0.42', currency: 'USD' },
+      },
+      createdAt: '2026-08-22T00:00:00.000Z',
+      updatedAt: '2026-08-22T00:01:00.000Z',
+    },
+  },
+  versions: {},
+};
+
+describe('production board model', () => {
+  it('returns an empty projection when no production runs exist', () => {
+    const model = buildProductionBoardModel({
+      records: [],
+      currentProjectRevision: 'rev-1',
+      artifacts,
+      dataLanes: [],
+    });
+
+    expect(model.isEmpty).toBe(true);
+    expect(model.groups).toEqual([]);
+  });
+
+  it('groups runs by production status and keeps events sequenced', () => {
+    const model = buildProductionBoardModel({
+      records: [
+        run({ runId: 'failed-run', state: 'failed', updatedSeq: 4 }),
+        run({ runId: 'parked-run', state: 'parked', updatedSeq: 8 }),
+      ],
+      currentProjectRevision: 'rev-1',
+      artifacts,
+      dataLanes: [],
+    });
+
+    expect(model.counts).toMatchObject({ parked: 1, failed: 1 });
+    expect(model.groups.map((group) => group.state)).toEqual(['parked', 'failed']);
+    expect(model.runs[0]?.runId).toBe('parked-run');
+    expect(model.runs[0]?.sections.events.items.map((event) => event.title)).toEqual([
+      '001 · run.queued',
+      '008 · run.parked',
+    ]);
+  });
+
+  it('projects board sections, artifact links, provider links, report links, data lanes, and authority badges', () => {
+    const model = buildProductionBoardModel({
+      records: [
+        run({
+          state: 'parked',
+          links: {
+            jobId: 'job-1',
+            providerRunId: 'provider-run-1',
+            reportId: 'report-1',
+            artifactIds: ['artifact-scene-1'],
+          },
+          approvals: [
+            {
+              approvalVersion: 1,
+              approvalId: 'approval-1',
+              nodeId: 'scene-candidates',
+              kind: 'choose-candidates',
+              prompt: 'Pick two scenes',
+              state: 'pending',
+              requestedSeq: 2,
+            },
+          ],
+          nodes: [
+            node({
+              nodeId: 'scene-candidates',
+              type: 'scene.candidates',
+              category: 'scene',
+              state: 'waiting_for_input',
+              pendingApprovalId: 'approval-1',
+            }),
+            node({
+              nodeId: 'asset-broll',
+              type: 'media.broll',
+              category: 'asset',
+              state: 'succeeded',
+              artifactIds: ['artifact-scene-1'],
+            }),
+            node({
+              nodeId: 'delivery-qa',
+              type: 'render.inspect',
+              category: 'qa',
+              state: 'succeeded',
+            }),
+          ],
+        }),
+      ],
+      currentProjectRevision: 'rev-1',
+      artifacts,
+      dataLanes: [
+        {
+          id: 'lane:generation',
+          kind: 'generation',
+          label: 'Generated',
+          items: [
+            {
+              id: 'artifact:artifact-scene-1',
+              label: 'Opening b-roll',
+              kind: 'generation',
+              artifactId: 'artifact-scene-1',
+              versionCount: 0,
+              pinned: false,
+              stale: false,
+              detail: 'rev 2',
+            },
+          ],
+        },
+      ],
+      assets: [
+        {
+          id: 'asset-video-1',
+          projectId: 'project-1',
+          kind: 'video',
+          displayName: 'opening.mov',
+          sha256: 'a'.repeat(64),
+          bytes: 123,
+          descriptor: { mimeType: 'video/quicktime' },
+          createdAt: 1,
+        },
+      ],
+    });
+
+    const projected = model.runs[0]!;
+    expect(projected.authorityBadge).toBe('Producer · owner');
+    expect(projected.sections.brief.items[0]?.detail).toContain('topic');
+    expect(projected.sections.scenes.items).toHaveLength(1);
+    expect(projected.sections.assets.items).toHaveLength(1);
+    expect(projected.sections.qa.items).toHaveLength(1);
+    expect(projected.sections.approvals.items[0]).toMatchObject({
+      title: 'Pick two scenes',
+      state: 'pending',
+    });
+    expect(projected.sections.jobs.items.map((item) => item.detail).join(' ')).toContain(
+      '0.42 USD',
+    );
+    expect(projected.links.map((link) => `${link.kind}:${link.id}`)).toEqual([
+      'job:job-1',
+      'provider:provider-run-1',
+      'report:report-1',
+      'asset:asset-video-1',
+      'artifact:artifact-scene-1',
+      'data-lane:artifact:artifact-scene-1',
+    ]);
+  });
+
+  it('models approval, retry, cancel, and stale-revision conflict availability', () => {
+    const parked = buildProductionBoardModel({
+      records: [
+        run({
+          state: 'parked',
+          approvals: [
+            {
+              approvalVersion: 1,
+              approvalId: 'approval-1',
+              nodeId: 'n1',
+              kind: 'approve-render',
+              prompt: 'Approve render',
+              state: 'pending',
+              requestedSeq: 2,
+            },
+          ],
+        }),
+      ],
+      currentProjectRevision: 'rev-1',
+      artifacts,
+      dataLanes: [],
+    }).runs[0]!;
+
+    expect(parked.actions).toMatchObject({
+      canApprove: true,
+      canReject: true,
+      canCancel: true,
+      canRetry: false,
+    });
+
+    const failed = buildProductionBoardModel({
+      records: [run({ state: 'failed' })],
+      currentProjectRevision: 'rev-1',
+      artifacts,
+      dataLanes: [],
+    }).runs[0]!;
+    expect(failed.actions).toMatchObject({ canRetry: true, canCancel: false });
+
+    const stale = buildProductionBoardModel({
+      records: [run({ state: 'parked', projectRevision: 'old-rev' })],
+      currentProjectRevision: 'rev-1',
+      artifacts,
+      dataLanes: [],
+    }).runs[0]!;
+    expect(stale.staleRevisionConflict).toBe(true);
+    expect(stale.actions).toMatchObject({
+      canApprove: false,
+      canReject: false,
+      canCancel: false,
+    });
+    expect(stale.actions.disabledReason).toContain('Project revision changed');
+  });
+
+  it('supports keyboard-style run selection helpers', () => {
+    const runs = [{ runId: 'a' }, { runId: 'b' }, { runId: 'c' }];
+
+    expect(productionBoardPrimaryRunId({ runs }, 'b')).toBe('b');
+    expect(productionBoardPrimaryRunId({ runs }, 'missing')).toBe('a');
+    expect(productionBoardNextRunId(runs, 'a', 'next')).toBe('b');
+    expect(productionBoardNextRunId(runs, 'a', 'previous')).toBe('c');
+  });
+});
+
+function run(overrides: Partial<ProductionRunRecordV1> = {}): ProductionRunRecordV1 {
+  const state = overrides.state ?? 'running';
+  const updatedSeq = overrides.updatedSeq ?? 2;
+  return {
+    recordVersion: 1,
+    runId: 'run-1',
+    workflowId: 'joy.workflow.production',
+    workflowVersion: '1.0.0',
+    projectRevision: 'rev-1',
+    state,
+    checkpointRevision: 1,
+    workflowInputs: { topic: 'summer campaign', duration: 15 },
+    links: {},
+    events: [
+      {
+        eventVersion: 1,
+        seq: 1,
+        type: 'run.queued',
+        state: 'queued',
+        checkpointRevision: 0,
+        actor: { principalId: 'owner-1', role: 'owner', displayName: 'Producer' },
+        message: 'queued',
+      },
+      {
+        eventVersion: 1,
+        seq: updatedSeq,
+        type:
+          state === 'failed'
+            ? 'run.failed'
+            : state === 'parked'
+              ? 'run.parked'
+              : 'run.checkpointed',
+        state,
+        checkpointRevision: 1,
+        message: state,
+      },
+    ],
+    approvals: [],
+    nodes: [],
+    createdSeq: 1,
+    updatedSeq,
+    ...overrides,
+  };
+}
+
+function node(
+  overrides: Partial<ProductionRunRecordV1['nodes'][number]> &
+    Pick<ProductionRunRecordV1['nodes'][number], 'nodeId' | 'type' | 'category' | 'state'>,
+): ProductionRunRecordV1['nodes'][number] {
+  return {
+    attempts: 1,
+    deterministic: true,
+    reused: false,
+    logs: [],
+    artifactIds: [],
+    ...overrides,
+  };
+}
diff --git a/apps/editor-web/src/production-board-model.ts b/apps/editor-web/src/production-board-model.ts
new file mode 100644
index 0000000..7fed522
--- /dev/null
+++ b/apps/editor-web/src/production-board-model.ts
@@ -0,0 +1,442 @@
+import type { ArtifactStore } from '@joy-media/commands';
+import type {
+  ProductionApprovalV1,
+  ProductionRunAuthority,
+  ProductionRunEventV1,
+  ProductionRunNodeProjectionV1,
+  ProductionRunRecordV1,
+  ProductionRunStateV1,
+} from '@joy-media/workflow-engine';
+import type { DataLane } from './data-lanes.js';
+import type { BrowserAsset } from './control-plane-client.js';
+
+export type ProductionBoardSectionId =
+  'brief' | 'scenes' | 'assets' | 'jobs' | 'approvals' | 'qa' | 'events';
+
+export interface ProductionBoardLink {
+  readonly kind: 'asset' | 'artifact' | 'data-lane' | 'job' | 'provider' | 'report';
+  readonly id: string;
+  readonly label: string;
+  readonly href: string;
+}
+
+export interface ProductionBoardActionAvailability {
+  readonly canApprove: boolean;
+  readonly canReject: boolean;
+  readonly canRetry: boolean;
+  readonly canCancel: boolean;
+  readonly disabledReason?: string;
+}
+
+export interface ProductionBoardRunProjection {
+  readonly runId: string;
+  readonly workflowId: string;
+  readonly workflowVersion: string;
+  readonly state: ProductionRunStateV1;
+  readonly projectRevision: string;
+  readonly checkpointRevision: number;
+  readonly updatedSeq: number;
+  readonly authorityBadge: string;
+  readonly staleRevisionConflict: boolean;
+  readonly pendingApprovals: readonly ProductionApprovalV1[];
+  readonly actions: ProductionBoardActionAvailability;
+  readonly sections: Readonly<Record<ProductionBoardSectionId, ProductionBoardSection>>;
+  readonly links: readonly ProductionBoardLink[];
+  readonly events: readonly ProductionRunEventV1[];
+}
+
+export interface ProductionBoardStatusGroup {
+  readonly state: ProductionRunStateV1;
+  readonly label: string;
+  readonly runs: readonly ProductionBoardRunProjection[];
+}
+
+export interface ProductionBoardSection {
+  readonly id: ProductionBoardSectionId;
+  readonly label: string;
+  readonly items: readonly ProductionBoardSectionItem[];
+}
+
+export interface ProductionBoardSectionItem {
+  readonly id: string;
+  readonly title: string;
+  readonly detail: string;
+  readonly state?: string;
+  readonly links: readonly ProductionBoardLink[];
+}
+
+export interface BuildProductionBoardModelInput {
+  readonly records: readonly ProductionRunRecordV1[];
+  readonly currentProjectRevision: string;
+  readonly artifacts: ArtifactStore;
+  readonly dataLanes: readonly DataLane[];
+  readonly assets?: readonly BrowserAsset[];
+}
+
+export interface ProductionBoardModel {
+  readonly isEmpty: boolean;
+  readonly groups: readonly ProductionBoardStatusGroup[];
+  readonly runs: readonly ProductionBoardRunProjection[];
+  readonly counts: Readonly<Partial<Record<ProductionRunStateV1, number>>>;
+}
+
+const STATUS_ORDER: readonly ProductionRunStateV1[] = [
+  'parked',
+  'running',
+  'queued',
+  'failed',
+  'canceled',
+  'succeeded',
+];
+
+const STATUS_LABELS: Readonly<Record<ProductionRunStateV1, string>> = {
+  queued: 'Queued',
+  running: 'Running',
+  parked: 'Needs review',
+  failed: 'Failed',
+  canceled: 'Canceled',
+  succeeded: 'Delivered',
+};
+
+const SECTION_LABELS: Readonly<Record<ProductionBoardSectionId, string>> = {
+  brief: 'Brief/Input',
+  scenes: 'Scenes/Candidates',
+  assets: 'Assets/B-roll',
+  jobs: 'Jobs/Providers/Cost',
+  approvals: 'Approvals',
+  qa: 'QA/Delivery',
+  events: 'Events',
+};
+
+export function buildProductionBoardModel(
+  input: BuildProductionBoardModelInput,
+): ProductionBoardModel {
+  const runs = [...input.records]
+    .sort(
+      (left, right) => right.updatedSeq - left.updatedSeq || left.runId.localeCompare(right.runId),
+    )
+    .map((record) => projectRun(record, input));
+
+  const counts: Partial<Record<ProductionRunStateV1, number>> = {};
+  for (const run of runs) {
+    counts[run.state] = (counts[run.state] ?? 0) + 1;
+  }
+
+  return {
+    isEmpty: runs.length === 0,
+    runs,
+    counts,
+    groups: STATUS_ORDER.flatMap((state) => {
+      const grouped = runs.filter((run) => run.state === state);
+      return grouped.length === 0 ? [] : [{ state, label: STATUS_LABELS[state], runs: grouped }];
+    }),
+  };
+}
+
+export function productionBoardNextRunId(
+  runs: readonly Pick<ProductionBoardRunProjection, 'runId'>[],
+  currentRunId: string | undefined,
+  direction: 'next' | 'previous',
+): string | undefined {
+  if (runs.length === 0) return undefined;
+  const currentIndex = runs.findIndex((run) => run.runId === currentRunId);
+  const start = currentIndex === -1 ? 0 : currentIndex;
+  const offset = direction === 'next' ? 1 : -1;
+  const nextIndex = (start + offset + runs.length) % runs.length;
+  return runs[nextIndex]?.runId;
+}
+
+export function productionBoardPrimaryRunId(
+  model: Pick<ProductionBoardModel, 'runs'>,
+  selectedRunId?: string,
+): string | undefined {
+  if (model.runs.length === 0) return undefined;
+  if (selectedRunId !== undefined && model.runs.some((run) => run.runId === selectedRunId)) {
+    return selectedRunId;
+  }
+  return model.runs[0]?.runId;
+}
+
+function projectRun(
+  record: ProductionRunRecordV1,
+  input: BuildProductionBoardModelInput,
+): ProductionBoardRunProjection {
+  const pendingApprovals = record.approvals.filter((approval) => approval.state === 'pending');
+  const staleRevisionConflict =
+    record.projectRevision !== input.currentProjectRevision && !isTerminal(record.state);
+  const links = linksForRun(record, input);
+  const events = [...record.events].sort((left, right) => left.seq - right.seq);
+  const sections = {
+    brief: briefSection(record, links),
+    scenes: nodeSection('scenes', record, input),
+    assets: nodeSection('assets', record, input),
+    jobs: jobsSection(record, input),
+    approvals: approvalsSection(record),
+    qa: nodeSection('qa', record, input),
+    events: eventsSection(events),
+  } satisfies Record<ProductionBoardSectionId, ProductionBoardSection>;
+
+  return {
+    runId: record.runId,
+    workflowId: record.workflowId,
+    workflowVersion: record.workflowVersion,
+    state: record.state,
+    projectRevision: record.projectRevision,
+    checkpointRevision: record.checkpointRevision,
+    updatedSeq: record.updatedSeq,
+    authorityBadge: authorityBadge(record),
+    staleRevisionConflict,
+    pendingApprovals,
+    actions: actionAvailability(record, staleRevisionConflict, pendingApprovals),
+    sections,
+    links,
+    events,
+  };
+}
+
+function briefSection(
+  record: ProductionRunRecordV1,
+  links: readonly ProductionBoardLink[],
+): ProductionBoardSection {
+  const inputSummary =
+    record.workflowInputs === undefined
+      ? 'No durable input payload recorded'
+      : summarizeValue(record.workflowInputs);
+  return {
+    id: 'brief',
+    label: SECTION_LABELS.brief,
+    items: [
+      {
+        id: `${record.runId}:brief`,
+        title: `${record.workflowId} v${record.workflowVersion}`,
+        detail: `run ${record.runId} · project ${record.projectRevision} · ${inputSummary}`,
+        state: record.state,
+        links,
+      },
+    ],
+  };
+}
+
+function nodeSection(
+  id: 'scenes' | 'assets' | 'qa',
+  record: ProductionRunRecordV1,
+  input: BuildProductionBoardModelInput,
+): ProductionBoardSection {
+  const nodes = record.nodes.filter((node) => nodeMatchesSection(node, id));
+  return {
+    id,
+    label: SECTION_LABELS[id],
+    items: nodes.map((node) => nodeItem(record, node, input)),
+  };
+}
+
+function jobsSection(
+  record: ProductionRunRecordV1,
+  input: BuildProductionBoardModelInput,
+): ProductionBoardSection {
+  const jobLinks = linksForRun(record, input).filter(
+    (link) => link.kind === 'job' || link.kind === 'provider' || link.kind === 'report',
+  );
+  const costItems = Object.values(input.artifacts.artifacts)
+    .filter((artifact) => record.links.artifactIds?.includes(artifact.id))
+    .filter((artifact) => artifact.provenance.cost !== undefined)
+    .map((artifact) => ({
+      id: `${record.runId}:cost:${artifact.id}`,
+      title: artifact.label,
+      detail:
+        `${artifact.provenance.cost?.amount ?? ''} ${artifact.provenance.cost?.currency ?? ''}`.trim(),
+      links: artifactLinks(artifact.id, input),
+    }));
+  const providerNodes = record.nodes.filter((node) => nodeMatchesSection(node, 'jobs'));
+  return {
+    id: 'jobs',
+    label: SECTION_LABELS.jobs,
+    items: [
+      ...providerNodes.map((node) => nodeItem(record, node, input)),
+      ...(jobLinks.length > 0
+        ? [
+            {
+              id: `${record.runId}:run-links`,
+              title: 'Run links',
+              detail: jobLinks.map((link) => link.label).join(' · '),
+              links: jobLinks,
+            },
+          ]
+        : []),
+      ...costItems,
+    ],
+  };
+}
+
+function approvalsSection(record: ProductionRunRecordV1): ProductionBoardSection {
+  return {
+    id: 'approvals',
+    label: SECTION_LABELS.approvals,
+    items: record.approvals.map((approval) => ({
+      id: approval.approvalId,
+      title: approval.prompt,
+      detail: `${approval.kind} · requested seq ${String(approval.requestedSeq)}${
+        approval.respondedSeq === undefined
+          ? ''
+          : ` · responded seq ${String(approval.respondedSeq)}`
+      }`,
+      state: approval.state,
+      links: [],
+    })),
+  };
+}
+
+function eventsSection(events: readonly ProductionRunEventV1[]): ProductionBoardSection {
+  return {
+    id: 'events',
+    label: SECTION_LABELS.events,
+    items: events.map((event) => ({
+      id: `event:${String(event.seq)}`,
+      title: `${String(event.seq).padStart(3, '0')} · ${event.type}`,
+      detail: [
+        event.message,
+        event.nodeId === undefined ? undefined : `node ${event.nodeId}`,
+        event.approvalId === undefined ? undefined : `approval ${event.approvalId}`,
+        event.failureCode === undefined ? undefined : `failure ${event.failureCode}`,
+      ]
+        .filter((part): part is string => part !== undefined && part.length > 0)
+        .join(' · '),
+      state: event.state,
+      links: [],
+    })),
+  };
+}
+
+function nodeItem(
+  record: ProductionRunRecordV1,
+  node: ProductionRunNodeProjectionV1,
+  input: BuildProductionBoardModelInput,
+): ProductionBoardSectionItem {
+  const links = node.artifactIds.flatMap((artifactId) => artifactLinks(artifactId, input));
+  const lastLog = node.logs.at(-1)?.message;
+  return {
+    id: `${record.runId}:node:${node.nodeId}`,
+    title: `${node.nodeId} · ${node.type}`,
+    detail: [
+      node.category,
+      `${String(node.attempts)} attempt${node.attempts === 1 ? '' : 's'}`,
+      node.deterministic ? 'deterministic' : 'provider',
+      node.reused ? 'reused' : undefined,
+      node.failureCode,
+      lastLog,
+    ]
+      .filter((part): part is string => part !== undefined && part.length > 0)
+      .join(' · '),
+    state: node.state,
+    links,
+  };
+}
+
+function nodeMatchesSection(
+  node: ProductionRunNodeProjectionV1,
+  section: 'scenes' | 'assets' | 'jobs' | 'qa',
+): boolean {
+  const haystack = `${node.nodeId} ${node.type} ${node.category}`.toLowerCase();
+  switch (section) {
+    case 'scenes':
+      return /(scene|candidate|script|prompt|storyboard)/.test(haystack);
+    case 'assets':
+      return /(asset|b-roll|broll|media|thumbnail|image|video|audio)/.test(haystack);
+    case 'jobs':
+      return /(job|provider|generate|synthesis|cost|runway|comfy|openrouter|lm-studio|higgsfield)/.test(
+        haystack,
+      );
+    case 'qa':
+      return /(qa|quality|delivery|render|inspect|export|preflight|report)/.test(haystack);
+  }
+}
+
+function linksForRun(
+  record: ProductionRunRecordV1,
+  input: BuildProductionBoardModelInput,
+): readonly ProductionBoardLink[] {
+  return [
+    ...(record.links.jobId === undefined
+      ? []
+      : [link('job', record.links.jobId, `Job ${record.links.jobId}`)]),
+    ...(record.links.providerRunId === undefined
+      ? []
+      : [link('provider', record.links.providerRunId, `Provider ${record.links.providerRunId}`)]),
+    ...(record.links.reportId === undefined
+      ? []
+      : [link('report', record.links.reportId, `Report ${record.links.reportId}`)]),
+    ...(record.links.artifactIds ?? []).flatMap((artifactId) => artifactLinks(artifactId, input)),
+  ];
+}
+
+function artifactLinks(
+  artifactId: string,
+  input: Pick<BuildProductionBoardModelInput, 'artifacts' | 'dataLanes' | 'assets'>,
+): readonly ProductionBoardLink[] {
+  const artifact = input.artifacts.artifacts[artifactId];
+  const lane = input.dataLanes
+    .flatMap((candidate) => candidate.items.map((item) => ({ lane: candidate, item })))
+    .find((candidate) => candidate.item.artifactId === artifactId);
+  const assetId =
+    artifact?.contentRef.type === 'asset'
+      ? artifact.contentRef.assetId
+      : input.assets?.some((asset) => asset.id === artifactId)
+        ? artifactId
+        : undefined;
+  return [
+    ...(assetId === undefined
+      ? []
+      : [link('asset', assetId, `Asset ${assetLabel(assetId, input.assets)}`)]),
+    ...(artifact === undefined
+      ? []
+      : [link('artifact', artifact.id, `Artifact ${artifact.label}`)]),
+    ...(lane === undefined ? [] : [link('data-lane', lane.item.id, `${lane.lane.label} lane`)]),
+  ];
+}
+
+function link(kind: ProductionBoardLink['kind'], id: string, label: string): ProductionBoardLink {
+  return { kind, id, label, href: `#${kind}:${encodeURIComponent(id)}` };
+}
+
+function assetLabel(assetId: string, assets: readonly BrowserAsset[] | undefined): string {
+  return assets?.find((asset) => asset.id === assetId)?.displayName ?? assetId;
+}
+
+function actionAvailability(
+  record: ProductionRunRecordV1,
+  staleRevisionConflict: boolean,
+  pendingApprovals: readonly ProductionApprovalV1[],
+): ProductionBoardActionAvailability {
+  const disabledReason = staleRevisionConflict
+    ? 'Project revision changed since this run parked.'
+    : undefined;
+  return {
+    canApprove: pendingApprovals.length > 0 && !staleRevisionConflict,
+    canReject: pendingApprovals.length > 0 && !staleRevisionConflict,
+    canRetry: (record.state === 'failed' || record.state === 'canceled') && !staleRevisionConflict,
+    canCancel: !isTerminal(record.state) && !staleRevisionConflict,
+    ...(disabledReason === undefined ? {} : { disabledReason }),
+  };
+}
+
+function authorityBadge(record: ProductionRunRecordV1): string {
+  const actor = record.events.find((event) => event.actor !== undefined)?.actor;
+  if (actor === undefined) return 'unknown authority';
+  return authorityLabel(actor);
+}
+
+function authorityLabel(authority: ProductionRunAuthority): string {
+  return `${authority.displayName ?? authority.principalId} · ${authority.role}`;
+}
+
+function summarizeValue(value: unknown): string {
+  if (value === null || typeof value !== 'object') return String(value);
+  if (Array.isArray(value)) return `${String(value.length)} inputs`;
+  const keys = Object.keys(value);
+  if (keys.length === 0) return 'empty input';
+  return keys.slice(0, 4).join(', ') + (keys.length > 4 ? ` +${String(keys.length - 4)}` : '');
+}
+
+function isTerminal(state: ProductionRunStateV1): boolean {
+  return state === 'canceled' || state === 'failed' || state === 'succeeded';
+}
diff --git a/apps/editor-web/src/workspace.ts b/apps/editor-web/src/workspace.ts
index 127b8cc..7d0cda5 100644
--- a/apps/editor-web/src/workspace.ts
+++ b/apps/editor-web/src/workspace.ts
@@ -9,20 +9,21 @@ export const PANEL_IDS = [
   'camera',
   'audio',
   'effects',
   'transitions',
   'color',
   'history',
   'diagnostics',
   'jobs',
   'agent',
   'workflows',
+  'production',
   'plugins',
   'templates',
 ] as const;
 export type PanelId = (typeof PANEL_IDS)[number];
 
 export interface WorkspaceLayout {
   readonly version: 1;
   readonly panels: readonly PanelId[];
 }
 
@@ -39,20 +40,21 @@ export const DEFAULT_WORKSPACE: WorkspaceLayout = {
     'camera',
     'audio',
     'effects',
     'transitions',
     'color',
     'history',
     'diagnostics',
     'jobs',
     'agent',
     'workflows',
+    'production',
     'plugins',
     'templates',
   ],
 };
 
 export const WORKSPACE_STORAGE_KEY = 'joy-media.editor-workspace.v1';
 export interface WorkspaceStorage {
   getItem(key: string): string | null;
   setItem(key: string, value: string): void;
 }
diff --git a/docs/TASK17-IMPLEMENTER-REPORT-2026-08-22.md b/docs/TASK17-IMPLEMENTER-REPORT-2026-08-22.md
new file mode 100644
index 0000000..81fba22
--- /dev/null
+++ b/docs/TASK17-IMPLEMENTER-REPORT-2026-08-22.md
@@ -0,0 +1,38 @@
+# Task 17 Implementer Report
+
+Date: 2026-08-22
+
+Scope:
+
+- Added the read-oriented JOY Production Board panel in
+  `apps/editor-web/src/ProductionBoardPanel.tsx`.
+- Added the pure projection model in `apps/editor-web/src/production-board-model.ts`.
+- Registered the durable `production` dock panel in workspace preferences, dock seed layout, panel
+  labels/icons, and App panel routing.
+- Styled the board as a dense editor panel with status groups, keyboard-selectable run rows, action
+  controls, conflict states, and section tabs for Brief/Input, Scenes/Candidates, Assets/B-roll,
+  Jobs/Providers/Cost, Approvals, QA/Delivery, and Events.
+
+Behavior covered:
+
+- Empty, loading, and error states.
+- Status-grouped durable runs with newest-updated ordering.
+- Monotonic event rendering by sequence.
+- Approval, rejection, retry, and cancellation availability computed from durable run state.
+- Stale project revision conflicts disable mutating actions and stay visible.
+- Authority badges derive from stored production-run event actors.
+- Links project to existing asset catalog entries, `CreativeArtifactV2` records, data-lane items,
+  provider run ids, job ids, and report ids.
+- Panel actions route through injected production run store/API callbacks; the board does not execute
+  workflow nodes.
+
+Verification:
+
+- `pnpm exec vitest run apps/editor-web/src/production-board-model.test.ts apps/editor-web/src/ProductionBoardPanel.test.tsx`
+- `pnpm --filter @joy-media/editor-web build`
+- `pnpm exec prettier --write apps/editor-web/src/production-board-model.ts apps/editor-web/src/production-board-model.test.ts apps/editor-web/src/ProductionBoardPanel.tsx apps/editor-web/src/ProductionBoardPanel.test.tsx apps/editor-web/src/workspace.ts apps/editor-web/src/dock-layout.ts apps/editor-web/src/panel-tab-icons.ts apps/editor-web/src/App.tsx apps/editor-web/src/app.css`
+
+Known external verification note:
+
+- The editor build still emits the pre-existing large chunk warning from Vite; the build completes
+  successfully.
