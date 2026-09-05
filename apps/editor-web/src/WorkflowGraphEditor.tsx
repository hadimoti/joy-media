import { useEffect, useMemo, useState } from 'react';
import type { WorkflowGraphV2 } from '@joy-media/project-schema';
import type { GraphTransaction } from '@joy-media/commands';
import { computeNodeCacheKey, dryRunGraphTransaction } from '@joy-media/commands';
import { WORKFLOW_NODE_TEMPLATES, templateFor } from './workflow-node-catalog.js';
import { WORKFLOW_TEMPLATES, buildTemplateTransaction } from './workflow-templates.js';
import type { BrowserKeyValueStore } from '@joy-media/project-persistence';

/** Cleared the first time a workflow is created, so the hint stops appearing. */
const HINT_KEY = 'joy-media.workflow-hint-seen';

function hintSeen(storage: BrowserKeyValueStore | undefined): boolean {
  if (storage === undefined) return true;
  try {
    return storage.getItem(HINT_KEY) === 'yes';
  } catch {
    return true;
  }
}

function markHintSeen(storage: BrowserKeyValueStore | undefined): void {
  if (storage === undefined) return;
  try {
    storage.setItem(HINT_KEY, 'yes');
  } catch {
    // A hint is not worth failing over when storage is unavailable.
  }
}

export interface WorkflowGraphEditorProps {
  readonly graph: WorkflowGraphV2;
  /** Applies a transaction through the editor's one history. */
  readonly onDispatch: (transaction: GraphTransaction) => void;
  /** Clips the workflow is being created for, if any. */
  readonly selectedClipIds?: readonly string[];
  /** Range covered by the selection, used to bind the template's source node. */
  readonly selectionRange?: { readonly startUs: number; readonly durationUs: number };
  /** Root writer-gated adapter; omitted only for non-persistent isolated renders. */
  readonly storage?: BrowserKeyValueStore;
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
export function WorkflowGraphEditor({
  graph,
  onDispatch,
  selectedClipIds,
  selectionRange,
  storage,
}: WorkflowGraphEditorProps) {
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [connectFromId, setConnectFromId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [showHint, setShowHint] = useState(() => !hintSeen(storage));
  const [checkedIds, setCheckedIds] = useState<readonly string[]>([]);
  const [openGroupId, setOpenGroupId] = useState<string | undefined>(undefined);
  /** Which group's name is being edited, kept apart from which group is open. */
  const [rename, setRename] = useState<{ groupId: string; value: string } | undefined>(undefined);

  // A cached docked panel can mount before its writer context. Once attached,
  // resolve the preference through the fenced adapter rather than raw storage.
  useEffect(() => {
    if (storage !== undefined) setShowHint(!hintSeen(storage));
  }, [storage]);

  const selected = graph.nodes.find((node) => node.id === selectedId);
  const connectFrom = graph.nodes.find((node) => node.id === connectFromId);

  const groups = graph.groups ?? [];
  // Derived, not stored: an undo that removes the open group drops the user
  // back to the whole workflow without needing an effect to notice.
  const openGroup = groups.find((group) => group.id === openGroupId);
  const groupOf = (nodeId: string) => groups.find((group) => group.nodeIds.includes(nodeId));
  const visibleNodes =
    openGroup === undefined
      ? graph.nodes
      : graph.nodes.filter((node) => openGroup.nodeIds.includes(node.id));
  // Edges crossing the boundary stay listed. Hiding them would make a group
  // look self-contained when it is not, which is exactly the wrong impression
  // for a view whose purpose is understanding how a section connects.
  const visibleEdges =
    openGroup === undefined
      ? graph.edges
      : graph.edges.filter(
          (edge) =>
            openGroup.nodeIds.includes(edge.fromNodeId) ||
            openGroup.nodeIds.includes(edge.toNodeId),
        );

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

  const selectionCount = selectedClipIds?.length ?? 0;

  const applyTemplate = (templateId: string) => {
    const template = WORKFLOW_TEMPLATES.find((candidate) => candidate.id === templateId);
    if (template === undefined) return;
    dispatch(
      buildTemplateTransaction(template, {
        seed: Date.now().toString(36).slice(-5),
        // A workflow created from a selection says so on its nodes and binds
        // its source to that range, so the graph records what it was made for
        // rather than floating free of the edit that prompted it.
        ...(selectionCount === 0
          ? {}
          : { scopeLabel: `${selectionCount} clip${selectionCount === 1 ? '' : 's'}` }),
        ...(selectionRange === undefined ? {} : { range: selectionRange }),
      }),
    );
    // The hint has done its job the moment a workflow exists.
    markHintSeen(storage);
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

  const toggleChecked = (nodeId: string) => {
    setCheckedIds((current) =>
      current.includes(nodeId)
        ? current.filter((candidate) => candidate !== nodeId)
        : [...current, nodeId],
    );
  };

  const groupChecked = () => {
    // Ordered by the node list rather than by click order, so the group reads
    // the same way the graph does.
    const nodeIds = graph.nodes
      .map((node) => node.id)
      .filter((nodeId) => checkedIds.includes(nodeId));
    if (nodeIds.length < 2) return;
    const ordinal = groups.length + 1;
    dispatch({
      label: `Group ${nodeIds.length} nodes`,
      commands: [
        {
          type: 'graph.group.create',
          payload: {
            group: {
              id: `group-${ordinal}-${Date.now().toString(36).slice(-4)}`,
              label: `Group ${ordinal}`,
              nodeIds,
            },
          },
        },
      ],
    });
    setCheckedIds([]);
  };

  const ungroup = (groupId: string, label: string) => {
    dispatch({
      label: `Ungroup ${label}`,
      commands: [{ type: 'graph.group.delete', payload: { groupId } }],
    });
    if (openGroupId === groupId) setOpenGroupId(undefined);
  };

  const commitRename = (groupId: string, previousLabel: string) => {
    const next = rename?.groupId === groupId ? rename.value.trim() : undefined;
    setRename(undefined);
    // An empty name is refused rather than stored: the validator rejects it, and
    // a group with no name cannot be a breadcrumb.
    if (next === undefined || next === '' || next === previousLabel) return;
    dispatch({
      label: `Rename ${previousLabel} to ${next}`,
      commands: [{ type: 'graph.group.setLabel', payload: { groupId, label: next } }],
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
        <div className="workflow-heading-actions">
          <button
            type="button"
            className="dual-lens-disclosure"
            disabled={checkedIds.length < 2}
            onClick={groupChecked}
          >
            Group {checkedIds.length === 0 ? '' : checkedIds.length}
          </button>
          <button
            type="button"
            className="dual-lens-disclosure"
            disabled={selected === undefined}
            onClick={deleteSelected}
          >
            Delete node
          </button>
        </div>
      </div>

      {groups.length > 0 && (
        <nav className="workflow-breadcrumb" aria-label="Workflow location">
          <button
            type="button"
            className="workflow-crumb"
            aria-current={openGroup === undefined ? 'page' : undefined}
            onClick={() => setOpenGroupId(undefined)}
          >
            Workflow
          </button>
          {openGroup !== undefined && (
            <>
              <span aria-hidden="true">/</span>
              <span className="workflow-crumb is-current" aria-current="page">
                {openGroup.label}
              </span>
            </>
          )}
        </nav>
      )}

      {groups.length > 0 && openGroup === undefined && (
        <ul className="workflow-group-list" aria-label="Groups">
          {groups.map((group) => (
            <li key={group.id} className="workflow-group">
              <input
                className="workflow-group-name"
                aria-label={`Rename ${group.label}`}
                value={rename?.groupId === group.id ? rename.value : group.label}
                onFocus={() => setRename({ groupId: group.id, value: group.label })}
                onChange={(event) => setRename({ groupId: group.id, value: event.target.value })}
                onBlur={() => commitRename(group.id, group.label)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              <span className="workflow-group-count">
                {group.nodeIds.length} node{group.nodeIds.length === 1 ? '' : 's'}
              </span>
              <button type="button" onClick={() => setOpenGroupId(group.id)}>
                Open
              </button>
              <button type="button" onClick={() => ungroup(group.id, group.label)}>
                Ungroup
              </button>
            </li>
          ))}
        </ul>
      )}

      <div
        className="workflow-templates"
        role="group"
        aria-label="Create a workflow from a template"
      >
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

      {visibleNodes.length === 0 ? (
        <p className="workflow-empty">
          {openGroup === undefined
            ? 'No workflow yet. Add a node to start one — every change is a single Undo.'
            : `${openGroup.label} has no nodes left. Ungroup it, or go back to the whole workflow.`}
        </p>
      ) : (
        <ul className="workflow-node-list">
          {visibleNodes.map((node) => {
            const isSelected = node.id === selectedId;
            const isConnectSource = node.id === connectFromId;
            const owner = groupOf(node.id);
            const classes = ['workflow-node'];
            if (isSelected) classes.push('is-selected');
            if (isConnectSource) classes.push('is-connect-source');
            if (node.status === 'stale') classes.push('is-stale');
            return (
              <li key={node.id}>
                <div className={classes.join(' ')}>
                  <input
                    type="checkbox"
                    className="workflow-node-check"
                    aria-label={`Include ${node.label} in a group`}
                    checked={checkedIds.includes(node.id)}
                    onChange={() => toggleChecked(node.id)}
                  />
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
                    {owner !== undefined && openGroup === undefined && (
                      <span className="workflow-badge is-group">{owner.label}</span>
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

      {visibleEdges.length > 0 && (
        <ul className="workflow-edge-list" aria-label="Connections">
          {visibleEdges.map((edge) => {
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
