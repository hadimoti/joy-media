import { useState } from 'react';
import type { EditorSession } from './editor-session.js';
import { extractWorkflowInputs, loadWorkflow, listWorkflows, deleteWorkflow } from './workflow-recorder.js';
import { loadFirstPartyWorkflows, getFirstPartyWorkflowVersion } from './first-party-workflows.js';
import { PlayIcon, RefreshIcon, TrashIcon, BadgeIcon } from './icons.js';

export interface WorkflowInputParameter {
  readonly name: string;
  readonly type: 'string' | 'number';
  readonly description: string;
  readonly default?: unknown;
}

export function WorkflowsPanel({
  session,
  selectedClipIds,
  playheadUs,
  onRun,
}: {
  readonly session: EditorSession;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly onRun: (workflowId: string, inputs: Record<string, unknown>) => void;
}) {
  const [workflows, setWorkflows] = useState(() => listWorkflows(session));
  const [runModal, setRunModal] = useState<{ workflowId: string; parameters: WorkflowInputParameter[] } | undefined>(undefined);
  const [runInputs, setRunInputs] = useState<Record<string, string>>({});
  const [showSystemWorkflows, setShowSystemWorkflows] = useState(false);

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

  // Load system (first-party) workflows
  const systemWorkflows = loadFirstPartyWorkflows();
  const systemWorkflowVersion = getFirstPartyWorkflowVersion();

  function openRunModal(workflowId: string) {
    const recorded = loadWorkflow(session, workflowId);
    let workflow;
    if (recorded !== undefined) {
      workflow = recorded.workflow;
    } else {
      const systemWf = systemWorkflows.find((w) => w.workflow.id === workflowId);
      if (!systemWf) return;
      workflow = systemWf.workflow;
    }
    const inputsSchema = extractWorkflowInputs(workflow.nodes);
    const properties = (inputsSchema.properties as Record<string, unknown> | undefined) ?? {};
    const required = (inputsSchema.required as string[]) ?? [];
    const parameters = required.map((name) => {
      const schema = (properties[name] as Record<string, unknown>) ?? {};
      let defaultValue = schema.default;
      if (defaultValue === undefined) {
        if (name === 'trackId' && selectedClip !== undefined) defaultValue = selectedClip.trackId;
        else if (name === 'clipId' && selectedClip !== undefined) defaultValue = selectedClip.clip.id;
        else if (name === 'clipStartUs' && selectedClip !== undefined) defaultValue = selectedClip.clip.startUs;
        else if (name === 'clipDurationUs' && selectedClip !== undefined) defaultValue = selectedClip.clip.durationUs;
        else if (name === 'clipSourceInUs') defaultValue = 0;
        else if ((name === 'atUs' || name === 'newStartUs') && selectedClip !== undefined)
          defaultValue = selectedClip.clip.startUs;
        else if (name === 'newEndUs' && selectedClip !== undefined)
          defaultValue = selectedClip.clip.startUs + selectedClip.clip.durationUs;
        else if (name === 'newClipId' && selectedClip !== undefined)
          defaultValue = `${selectedClip.clip.id}-split-${selectedClip.clip.startUs}`;
      }
      return {
        name,
        type: (schema.type as 'string' | 'number') || 'string',
        description: (schema.description as string) || name,
        default: defaultValue,
      };
    });
    const initial: Record<string, string> = {};
    for (const parameter of parameters) {
      initial[parameter.name] = parameter.default !== undefined ? String(parameter.default) : '';
    }
    setRunInputs(initial);
    setRunModal({ workflowId, parameters });
  }

  function submitRun() {
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
    onRun(runModal.workflowId, inputs);
    setRunModal(undefined);
    setRunInputs({});
  }

  // Render a workflow row with "Derived from" badge for system workflows
  function renderWorkflowRow(wf: { workflow: { id: string; name: string; version: string; inputs: { properties: Record<string, unknown> } } }, isSystem = false) {
    const hasInputs = Object.keys((wf.workflow.inputs.properties as Record<string, unknown>) ?? {}).length > 0;
    return (
      <li key={wf.workflow.id} className="workflow-row">
        <div className="workflow-row-main">
          <strong>{wf.workflow.name}</strong>
          <span>v{wf.workflow.version}</span>
          {isSystem && (
            <span className="derived-badge" title={`Derived from first-party workflow v${systemWorkflowVersion}`}>
              <BadgeIcon size={10} />
              Derived
            </span>
          )}
        </div>
        <div className="workflow-row-actions">
          <button
            className="icon-button"
            onClick={() => (hasInputs ? openRunModal(wf.workflow.id) : onRun(wf.workflow.id, {}))}
            aria-label={`Run ${wf.workflow.name}`}
            title={`Run ${wf.workflow.name}`}
          >
            <PlayIcon />
          </button>
          {!isSystem && (
            <button
              className="icon-button"
              onClick={() => handleDelete(wf.workflow.id)}
              aria-label={`Delete ${wf.workflow.name}`}
              title={`Delete ${wf.workflow.name}`}
            >
              <TrashIcon />
            </button>
          )}
        </div>
      </li>
    );
  }

  return (
    <article className="workflows-panel">
      <div className="workflows-header">
        <h3>Workflows</h3>
        <button
          className="icon-button"
          aria-label="Refresh workflow list"
          title="Refresh workflow list"
          onClick={() => setWorkflows(listWorkflows(session))}
        >
          <RefreshIcon />
        </button>
      </div>

      {runModal !== undefined && (
        <div className="workflow-run-modal" role="dialog" aria-label="Run workflow inputs">
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
                dir="ltr"
              />
            </label>
          ))}
          <div className="workflow-run-actions">
            <button className="icon-button icon-button-labeled" onClick={submitRun} title="Run workflow">
              <PlayIcon />
              Run
            </button>
            <button className="icon-button" onClick={() => setRunModal(undefined)} title="Cancel" aria-label="Cancel">
              <TrashIcon />
            </button>
          </div>
        </div>
      )}

      {workflows.length === 0 && systemWorkflows.length === 0 ? (
        <p className="empty-hint">No saved workflows yet. Run an agent action and save it as a workflow.</p>
      ) : (
        <>
          {/* User workflows section */}
          {workflows.length > 0 && (
            <>
              <div className="workflow-section-header">
                <h4>My Workflows</h4>
              </div>
              <ul className="workflow-list">
                {workflows.map((wf) => renderWorkflowRow(wf, false))}
              </ul>
            </>
          )}

          {/* System workflows section */}
          {systemWorkflows.length > 0 && (
            <>
              <div className="workflow-section-header">
                <h4>System Workflows</h4>
                <span className="system-version-badge">v{systemWorkflowVersion}</span>
              </div>
              <ul className="workflow-list">
                {systemWorkflows.map((wf) => renderWorkflowRow(wf, true))}
              </ul>
            </>
          )}
        </>
      )}
    </article>
  );
}