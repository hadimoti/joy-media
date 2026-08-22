import { SCENE3D_TOOL_DEFINITIONS } from '@joy-media/scene3d-core';
import type { ToolDefinition } from './types.js';

/** Registry-facing, approval-bound 3D tool definitions. Execution remains in scene3d-core. */
export function createScene3DToolDefinitions(): readonly ToolDefinition[] {
  return SCENE3D_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: tool.readOnly ? 'query' : 'edit',
    inputSchema: tool.inputSchema as Record<string, unknown>,
    outputSchema: { type: 'object' },
    scope: { capabilities: [tool.readOnly ? 'timeline.read' : 'timeline.write'], isReversible: !tool.readOnly },
    preconditions: [],
    requiresConfirmation: tool.requiresApproval,
    supportsDryRun: !tool.readOnly,
    returnsStableIds: true,
  }));
}
