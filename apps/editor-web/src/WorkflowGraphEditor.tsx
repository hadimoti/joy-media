import { useMemo, useState } from 'react';
import type { WorkflowGraphV2 } from '@joy-media/project-schema';
import type { GraphTransaction } from '@joy-media/commands';
import { computeNodeCacheKey, dryRunGraphTransaction } from '@joy-media/commands';
import { WORKFLOW_NODE_TEMPLATES, templateFor } from './workflow-node-catalog.js';
import { WORKFLOW_TEMPLATES, buildTemplateTransaction } from './workflow-templates.js';

/** Cleared the first time a workflow is created, so the hint stops appearing. */
const HINT_KEY = 'joy-media.workflow-hint-seen';

function hintSeen(): boolean {
  try {
    return window.localStorage.getItem(HINT_KEY) === 'yes';
  } catch {
    return true;
  }
}

function markHintSeen(): void {
  try {
    window.localStorage.setItem(HINT_KEY, 'yes');
  } catch {
    // A hint is not worth failing over when storage is unavailable.
  }
}

export interface WorkflowGraphEditorProps {
  readonly graph: WorkflowGraphV2;
  /** Applies a transaction through the editor's one history. */
  readonly onDispatch: (transaction: GraphTransaction) => void;
}

/**
 * Authoring surface for the workflow graph.
 *
 * Kept separate from the Flow projection above it: that graph is *derived* from
 * what the document already contains, this one is *authored*. Drawing them on
 * one canvas before their relationship is designed would suggest an equivalence
 * that does not exist yet (ADR-0024).
 *
 * Every mutation here goes out as a transaction. Nothing edits the graph value
 * directly, so everything on this surface undoes with one Undo.
 */
export function WorkflowGraphEditor({ graph, onDispatch }: WorkflowGraphEditorProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [connectFromId, setConnectFromId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [showHint, setShowHint] = useState(() => !hintSeen());

  const selected = graph.nodes.find((node) => node.id === selectedId);
  const connectFrom = graph.nodes.find((node) => node.id === connectFromId);

  const cacheKeys = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, computeNodeCacheKey(graph, node.id)])),
    [graph],
  );

  const dispatch = (transaction: GraphTransaction) => {
    // Dry run first so a rejected edit reports why instead of throwing past the
    // click handler and losing the reason.
    const preview = dryRunGraphTransaction(graph, transaction);
    if (!preview.ok) {
      setError(preview.errors[0] ?? 'the graph rejected that change');
      return;
    }
    setError(undefined);
    onDispatch(transaction);
  };

  const applyTemplate = (templateId: string) => {
    const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === templateId);
    if (template === undefined) return;
    dispatch(
      buildTemplateTransaction(template, { seed: Date.now().toString(36).slice(-5) }),
    );
    // The hint has done its job the moment a workflow exists.
    markHintSeen();
    setShowHint(false);
  };

  const addNode = (type: string) => {
    const template = templateFor(type);
    if (template === undefined) return;
    // Deterministic-enough id, supplied by the caller as ADR-0003 requires.
    const id = `${type.split('.')[1] ?? 'node'}-${graph.nodes.length + 1}-${Date.now().toString(36).slice(-4)}`;
    dispatch({
      label: `Add ${template.label}`,
      commands: [{ type: 'graph.node.create', payload: { node: template.build(id) } }],
    });
    setSelectedId(id);
  };

  const deleteSelected = () => {
    if (selected === undefined) return;
    dispatch({
      label: `Delete ${selected.label}`,
      commands: [{ type: 'graph.node.delete', payload: { nodeId: selected.id } }],
    });
    setSelectedId(undefined);
    setConnectFromId(undefined);
  };

  const connectTo = (toId: string) => {
    if (connectFrom === undefined) return;
    const fromPort = connectFrom.outputs[0];
    const toNode = graph.nodes.find((node) => node.id === toId);
    const toPort = toNode?.inputs[0];
    if (fromPort === undefined || toPort === undefined) {
      setError('those nodes have no ports to connect');
      return;
    }
    dispatch({
      label: `Connect ${connectFrom.label} to ${toNode?.label ?? toId}`,
      commands: [
        {
          type: 'graph.edge.connect',
          payload: {
            edge: {
              id: `edge-${connectFrom.id}-${toId}`,
              fromNodeId: connectFrom.id,
              fromPortId: fromPort.id,
              toNodeId: toId,
              toPortId: toPort.id,
            },
          },
        },
      ],
    });
    setConnectFromId(undefined);
  };

  const disconnect = (edgeId: string) => {
    dispatch({
      label: 'Disconnect',
      commands: [{ type: 'graph.edge.disconnect', payload: { edgeId } }],
    });
  };

  return (
    <section className="workflow-editor" aria-label="Workflow graph editor">
      <div className="dual-lens-section-heading">
        <div>
          <strong>Workflow</strong>
          <span>
            {graph.nodes.length} node{graph.nodes.length === 1 ? '' : 's'} · {graph.edges.length}{' '}
            edge{graph.edges.length === 1 ? '' : 's'}
          </span>
        </div>
        <button
          type="button"
          className="dual-lens-disclosure"
          disabled={selected === undefined}
          onClick={deleteSelected}
        >
          Delete node
        </button>
      </div>

      <div className="workflow-templates" role="group" aria-label="Create a workflow from a template">
        <span className="workflow-templates-label">Templates</span>
        {WORKFLOW_TEMPLATES.map((template) => (
          <button
            key={template.id}
            type="button"
            className="workflow-template-button"
            title={template.description}
            onClick={() => applyTemplate(template.id)}
          >
            {template.label}
          </button>
        ))}
      </div>

      {showHint && graph.nodes.length === 0 && (
        <p className="workflow-hint">
          Start from a template — it builds the whole chain in one step, and one Undo removes it.
        </p>
      )}

      <div className="workflow-palette" role="group" aria-label="Add a node">
        {WORKFLOW_NODE_TEMPLATES.map((template) => (
          <button
            key={template.type}
            type="button"
            className="workflow-palette-button"
            title={template.hint}
            onClick={() => addNode(template.type)}
          >
            + {template.label}
          </button>
        ))}
      </div>

      {error !== undefined && (
        <p className="workflow-error" role="alert">
          {error}
        </p>
      )}

      {graph.nodes.length === 0 ? (
        <p className="workflow-empty">
          No workflow yet. Add a node to start one — every change is a single Undo.
        </p>
      ) : (
        <ul className="workflow-node-list">
          {graph.nodes.map((node) => {
            const isSelected = node.id === selectedId;
            const isConnectSource = node.id === connectFromId;
            const classes = ['workflow-node'];
            if (isSelected) classes.push('is-selected');
            if (isConnectSource) classes.push('is-connect-source');
            if (node.status === 'stale') classes.push('is-stale');
            return (
              <li key={node.id}>
                <div className={classes.join(' ')}>
                  <button
                    type="button"
                    className="workflow-node-body"
                    aria-pressed={isSelected}
                    onClick={() => setSelectedId(isSelected ? undefined : node.id)}
                  >
                    <span className="workflow-node-label">{node.label}</span>
                    <span className="workflow-node-type">{node.type}</span>
                    <span className="workflow-node-key" title="Cache key">
                      {cacheKeys.get(node.id)?.slice(0, 8)}
                    </span>
                    {node.status === 'stale' && <span className="workflow-badge">stale</span>}
                    {node.executionPolicy.requiresApproval && (
                      <span className="workflow-badge is-gate">approval</span>
                    )}
                  </button>
                  {connectFromId === undefined ? (
                    <button
                      type="button"
                      className="workflow-node-action"
                      disabled={node.outputs.length === 0}
                      onClick={() => setConnectFromId(node.id)}
                    >
                      Connect from
                    </button>
                  ) : isConnectSource ? (
                    <button
                      type="button"
                      className="workflow-node-action"
                      onClick={() => setConnectFromId(undefined)}
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="workflow-node-action"
                      disabled={node.inputs.length === 0}
                      onClick={() => connectTo(node.id)}
                    >
                      Connect here
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {graph.edges.length > 0 && (
        <ul className="workflow-edge-list" aria-label="Connections">
          {graph.edges.map((edge) => {
            const from = graph.nodes.find((node) => node.id === edge.fromNodeId);
            const to = graph.nodes.find((node) => node.id === edge.toNodeId);
            return (
              <li key={edge.id}>
                <span>
                  {from?.label ?? edge.fromNodeId} → {to?.label ?? edge.toNodeId}
                </span>
                <button type="button" onClick={() => disconnect(edge.id)}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
