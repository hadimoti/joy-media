import { useState } from 'react';
import type { EditorSession } from './editor-session.js';
import { listWorkflows, deleteWorkflow } from './workflow-recorder.js';
import { PlayIcon, RefreshIcon, TrashIcon } from './icons.js';

export function WorkflowsPanel({
  session,
  onRun,
}: {
  readonly session: EditorSession;
  readonly onRun: (workflowId: string) => void;
}) {
  const [workflows, setWorkflows] = useState(() => listWorkflows(session));

  const handleDelete = (workflowId: string) => {
    deleteWorkflow(session, workflowId);
    setWorkflows(listWorkflows(session));
  };

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
      {workflows.length === 0 ? (
        <p>No saved workflows yet. Run an agent action and save it as a workflow.</p>
      ) : (
        <ul>
          {workflows.map((wf) => (
            <li key={wf.workflow.id} className="workflow-row">
              <strong>{wf.workflow.name}</strong>
              <span>v{wf.workflow.version}</span>
              <button
                className="icon-button"
                onClick={() => onRun(wf.workflow.id)}
                aria-label={`Run ${wf.workflow.name}`}
                title={`Run ${wf.workflow.name}`}
              >
                <PlayIcon />
              </button>
              <button
                className="icon-button"
                onClick={() => handleDelete(wf.workflow.id)}
                aria-label={`Delete ${wf.workflow.name}`}
                title={`Delete ${wf.workflow.name}`}
              >
                <TrashIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}