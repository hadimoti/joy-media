import { useRef, useState } from 'react';
import type { HumanInputRequest } from '@joy-media/workflow-engine';
import type { EditorSession } from './editor-session.js';
import {
  extractWorkflowInputs,
  loadWorkflow,
  listWorkflows,
  deleteWorkflow,
  type RecordedWorkflow,
} from './workflow-recorder.js';
import {
  loadFirstPartyWorkflows,
  getFirstPartyWorkflowVersion,
  detectDerivedFrom,
} from './first-party-workflows.js';
import type { WorkflowRunOutcome } from './workflow-runner.js';
import { PlayIcon, RefreshIcon, TrashIcon, BadgeIcon, CloseIcon } from './icons.js';
import { PanelShell, type PanelTabSpec } from './PanelShell.js';
import { panelTabIconUrl } from './panel-tab-icons.js';
import { ContactSheetApproval, type ContactSheetApprovalDecision } from './ContactSheetApproval.js';
import { useAccessibleDialog } from './dialog-a11y.js';

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
  readonly approvalId?: string;
  readonly approvalRequestedSeq?: number;
  readonly approvalExpiresAtSeq?: number;
}

export function parametersFromSchema(
  schema: Record<string, unknown>,
  selectedClip:
    | {
        readonly trackId: string;
        readonly clip: {
          readonly id: string;
          readonly startUs: number;
          readonly durationUs: number;
        };
      }
    | undefined,
  playheadUs: number,
): WorkflowInputParameter[] {
  const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
  const required = (schema.required as string[] | undefined) ?? [];
  const names = required.length > 0 ? required : Object.keys(properties);

  return names.map((name) => {
    const propertySchema = (properties[name] as Record<string, unknown> | undefined) ?? {};
    let defaultValue = propertySchema.default;
    if (defaultValue === undefined) {
      if (name === 'trackId' && selectedClip !== undefined) defaultValue = selectedClip.trackId;
      else if (name === 'clipId' && selectedClip !== undefined) defaultValue = selectedClip.clip.id;
      else if (name === 'clipStartUs' && selectedClip !== undefined)
        defaultValue = selectedClip.clip.startUs;
      else if (name === 'clipDurationUs' && selectedClip !== undefined)
        defaultValue = selectedClip.clip.durationUs;
      else if (name === 'clipSourceInUs') defaultValue = 0;
      else if (name === 'atUs' || name === 'newStartUs') defaultValue = playheadUs;
      else if (name === 'newEndUs' && selectedClip !== undefined)
        defaultValue = selectedClip.clip.startUs + selectedClip.clip.durationUs;
      else if (name === 'newClipId' && selectedClip !== undefined)
        defaultValue = `${selectedClip.clip.id}-split-${selectedClip.clip.startUs}`;
      else if (name === 'asset' || name === 'assetId') defaultValue = 'asset-demo-1';
      else if (name === 'selectedMedia') defaultValue = 'asset-demo-1';
      else if (name === 'brief') defaultValue = 'Create a polished edit from the selected media.';
    }
    const schemaType = propertySchema.type;
    const type: 'string' | 'number' =
      schemaType === 'number' || schemaType === 'integer' ? 'number' : 'string';
    return {
      name: name === 'asset' ? 'assetId' : name,
      type,
      description:
        name === 'asset'
          ? ((propertySchema.description as string | undefined) ?? 'Opaque source video asset id')
          : name === 'selectedMedia'
            ? 'Selected media asset id'
            : ((propertySchema.description as string | undefined) ?? name),
      default: defaultValue,
    };
  });
}

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
  readonly onRun: (
    workflowId: string,
    inputs: Record<string, unknown>,
  ) => Promise<WorkflowRunOutcome>;
  readonly onResume: (
    runId: string,
    humanInputs: Record<string, unknown>,
    approval: {
      readonly approvalId?: string;
      readonly approvalRequestedSeq?: number;
      readonly approvalExpiresAtSeq?: number;
    },
  ) => Promise<WorkflowRunOutcome>;
}) {
  const [workflows, setWorkflows] = useState(() => listWorkflows(session));
  const [tab, setTab] = useState('saved');
  const [runModal, setRunModal] = useState<
    { workflowId: string; parameters: WorkflowInputParameter[] } | undefined
  >(undefined);
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [approval, setApproval] = useState<ApprovalState | undefined>(undefined);
  const [statusMessage, setStatusMessage] = useState<string | undefined>(undefined);
  const runDialogRef = useRef<HTMLDivElement | null>(null);
  const approvalDialogRef = useRef<HTMLDivElement | null>(null);

  useAccessibleDialog({
    open: runModal !== undefined,
    containerRef: runDialogRef,
    onClose: () => setRunModal(undefined),
    initialFocusSelector: 'input, button:not([disabled])',
  });
  useAccessibleDialog({
    open: approval !== undefined,
    containerRef: approvalDialogRef,
    onClose: () => setApproval(undefined),
    initialFocusSelector: '[role="option"], textarea, button:not([disabled])',
  });

  const handleDelete = (workflowId: string) => {
    deleteWorkflow(session, workflowId);
    setWorkflows(listWorkflows(session));
  };

  const selectedClip = (() => {
    if (selectedClipIds.length === 0) return undefined;
    const composition = session.timelineProject.compositions.root;
    if (composition === undefined) return undefined;
    for (const track of composition.tracks) {
      const clip = track.clips.find((c) => c.id === selectedClipIds[0]);
      if (clip !== undefined) return { trackId: track.id, clip };
    }
    return undefined;
  })();

  const systemWorkflows = loadFirstPartyWorkflows();
  const systemWorkflowVersion = getFirstPartyWorkflowVersion();

  function applyOutcome(outcome: WorkflowRunOutcome): void {
    if (outcome.status === 'waiting_for_input') {
      setApproval({
        runId: outcome.runId,
        workflowId: outcome.workflowId,
        nodeId: outcome.nodeId,
        request: outcome.request,
        ...(outcome.approvalId === undefined ? {} : { approvalId: outcome.approvalId }),
        ...(outcome.approvalRequestedSeq === undefined
          ? {}
          : { approvalRequestedSeq: outcome.approvalRequestedSeq }),
        ...(outcome.approvalExpiresAtSeq === undefined
          ? {}
          : { approvalExpiresAtSeq: outcome.approvalExpiresAtSeq }),
      });
      setStatusMessage(`تأیید کاربر برای ${outcome.request.kind} منتظر مانده است.`);
      return;
    }
    setApproval(undefined);
    if (outcome.status === 'succeeded') {
      setStatusMessage(`گردش‌کار ${outcome.workflowId} تمام شد و خروجی Manifest ثبت شد.`);
      return;
    }
    setStatusMessage(`اجرای گردش‌کار ناموفق بود: ${outcome.error}`);
  }

  function openRunModal(workflowId: string) {
    const recorded = loadWorkflow(session, workflowId);
    let schema: Record<string, unknown>;
    if (recorded !== undefined) {
      schema = extractWorkflowInputs(recorded.workflow.nodes);
    } else {
      const systemWf = systemWorkflows.find((entry) => entry.workflow.id === workflowId);
      if (systemWf === undefined) return;
      schema = systemWf.workflow.inputs as Record<string, unknown>;
    }
    const parameters = parametersFromSchema(schema, selectedClip, playheadUs);
    const initial: Record<string, string> = {};
    for (const parameter of parameters) {
      initial[parameter.name] = parameter.default !== undefined ? String(parameter.default) : '';
    }
    setRunInputs(initial);
    setRunModal({ workflowId, parameters });
  }

  async function submitRun() {
    if (runModal === undefined) return;
    const inputs: Record<string, unknown> = {};
    for (const parameter of runModal.parameters) {
      const raw = runInputs[parameter.name];
      if (raw === undefined || raw === '') {
        if (parameter.default !== undefined) {
          inputs[parameter.name] = parameter.default;
        }
        continue;
      }
      inputs[parameter.name] = parameter.type === 'number' ? Number(raw) : raw;
    }
    const workflowId = runModal.workflowId;
    setRunModal(undefined);
    setRunInputs({});
    const outcome = await onRun(workflowId, inputs);
    applyOutcome(outcome);
  }

  async function submitApprovalDecision(decision: ContactSheetApprovalDecision) {
    if (approval === undefined) return;
    const humanInputs: Record<string, unknown> = { [approval.nodeId]: decision.response };

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
          <strong>{recorded.workflow.name}</strong>
          <span>v{recorded.workflow.version}</span>
          {derivedFrom !== undefined && (
            <span className="derived-badge" title={`Derived from: ${derivedFrom}`}>
              <BadgeIcon />
              derived from: {derivedFrom.replace('joy.first-party.', '')}
            </span>
          )}
        </div>
        <div className="workflow-row-actions">
          <button
            className="icon-button"
            onClick={() =>
              hasInputs
                ? openRunModal(recorded.workflow.id)
                : void onRun(recorded.workflow.id, {}).then(applyOutcome)
            }
            aria-label={`Run ${recorded.workflow.name}`}
            title={`Run ${recorded.workflow.name}`}
          >
            <PlayIcon />
          </button>
          <button
            className="icon-button"
            onClick={() => handleDelete(recorded.workflow.id)}
            aria-label={`Delete ${recorded.workflow.name}`}
            title={`Delete ${recorded.workflow.name}`}
          >
            <TrashIcon />
          </button>
        </div>
      </li>
    );
  }

  function renderSystemRow(entry: {
    readonly workflow: {
      readonly id: string;
      readonly name: string;
      readonly version: string;
      readonly inputs: Record<string, unknown>;
    };
    readonly label: string;
    readonly summary: string;
    readonly requiredPorts: readonly string[];
    readonly approvals: readonly string[];
  }) {
    const properties =
      (entry.workflow.inputs.properties as Record<string, unknown> | undefined) ?? {};
    const hasInputs = Object.keys(properties).length > 0;
    return (
      <li key={entry.workflow.id} className="workflow-row">
        <div className="workflow-row-main">
          <strong>{entry.workflow.name}</strong>
          <span>
            {entry.label} · v{entry.workflow.version} · {entry.requiredPorts.length} required ports
          </span>
          <span title={entry.approvals.join(', ')}>{entry.summary}</span>
        </div>
        <div className="workflow-row-actions">
          <button
            className="icon-button"
            onClick={() =>
              hasInputs
                ? openRunModal(entry.workflow.id)
                : void onRun(entry.workflow.id, {}).then(applyOutcome)
            }
            aria-label={`Run ${entry.workflow.name}`}
            title="Start production workflow run"
          >
            <PlayIcon />
          </button>
        </div>
      </li>
    );
  }

  const isEmpty = workflows.length === 0 && systemWorkflows.length === 0;

  return (
    <PanelShell
      title="Workflows"
      iconUrl={panelTabIconUrl('workflows')}
      className="workflows-panel"
      tabs={TABS}
      activeTab={tab}
      onTabChange={setTab}
      {...(statusMessage !== undefined
        ? { note: statusMessage }
        : isEmpty
          ? { note: 'برای ساختن نخستین Workflow، یک ویرایش Agent را اجرا و ذخیره کنید.' }
          : {})}
      actions={
        <button
          type="button"
          className="icon-button"
          aria-label="Refresh workflow list"
          title="Refresh workflow list"
          onClick={() => setWorkflows(listWorkflows(session))}
        >
          <RefreshIcon />
        </button>
      }
    >
      {runModal !== undefined && (
        <div
          ref={runDialogRef}
          className="workflow-run-modal"
          role="dialog"
          aria-label="Run workflow inputs"
          aria-modal="true"
          tabIndex={-1}
        >
          <h4>Run: {runModal.workflowId}</h4>
          {runModal.parameters.map((parameter) => (
            <label key={parameter.name}>
              {parameter.description}
              <input
                type={parameter.type === 'number' ? 'number' : 'text'}
                value={runInputs[parameter.name] ?? ''}
                onChange={(event) =>
                  setRunInputs((current) => ({ ...current, [parameter.name]: event.target.value }))
                }
              />
            </label>
          ))}
          <div className="workflow-run-actions">
            <button
              className="icon-button icon-button-labeled"
              onClick={() => void submitRun()}
              title="Run workflow"
            >
              <PlayIcon />
              Run
            </button>
            <button
              className="icon-button"
              onClick={() => setRunModal(undefined)}
              title="Cancel"
              aria-label="Cancel"
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      )}

      {approval !== undefined && (
        <div
          ref={approvalDialogRef}
          className="workflow-run-modal"
          role="dialog"
          aria-label="Workflow approval"
          aria-modal="true"
          tabIndex={-1}
        >
          <ContactSheetApproval
            key={`${approval.runId}:${approval.nodeId}:${approval.approvalId ?? 'local'}`}
            request={approval.request}
            storageKey={`${approval.runId}:${approval.nodeId}:${approval.approvalId ?? 'local'}`}
            {...(approval.approvalId === undefined ? {} : { approvalId: approval.approvalId })}
            {...(typeof window === 'undefined' ? {} : { storage: window.localStorage })}
            onSubmit={(decision) => void submitApprovalDecision(decision)}
            onDismiss={() => setApproval(undefined)}
          />
        </div>
      )}

      {tab === 'saved' && (
        <ul className="workflow-list">{workflows.map((wf) => renderRecordedRow(wf))}</ul>
      )}

      {tab === 'system' && (
        <>
          <div className="workflow-section-header">
            <h4>Production pipeline packs</h4>
            <span className="system-version-badge" title="First-party production pack version">
              v{systemWorkflowVersion}
            </span>
          </div>
          <ul className="workflow-list">{systemWorkflows.map((wf) => renderSystemRow(wf))}</ul>
        </>
      )}
    </PanelShell>
  );
}
