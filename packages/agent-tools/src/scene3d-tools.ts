import { SCENE3D_TOOL_DEFINITIONS } from '@joy-media/scene3d-core';
import type { ToolDefinition } from './types.js';

/** Registry-facing, approval-bound 3D tool definitions. Execution remains in scene3d-core. */
export function createScene3DToolDefinitions(): readonly ToolDefinition[] {
  return SCENE3D_TOOL_DEFINITIONS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    category: tool.readOnly ? 'query' : 'edit',
    inputSchema: inputSchemaFor(tool.name),
    outputSchema: tool.readOnly
      ? tool.name === 'scene3d.assets'
        ? { type: 'array', items: { type: 'object' } }
        : tool.name === 'scene3d.selection'
          ? { anyOf: [{ type: 'object' }, { type: 'null' }] }
          : { type: 'object', additionalProperties: true }
      : {
          type: 'object',
          additionalProperties: false,
          required: ['diff', 'inverse', 'revision'],
          properties: {
            diff: { type: 'object' },
            inverse: { type: 'object' },
            revision: { type: 'string' },
          },
        },
    scope: {
      capabilities: [tool.readOnly ? 'timeline.read' : 'timeline.write'],
      isReversible: !tool.readOnly,
    },
    preconditions: [],
    requiresConfirmation: tool.requiresApproval,
    supportsDryRun: !tool.readOnly,
    returnsStableIds: true,
  }));
}

function inputSchemaFor(name: string): Record<string, unknown> {
  if (
    name === 'scene3d.summary' ||
    name === 'scene3d.assets' ||
    name === 'scene3d.scene' ||
    name === 'scene3d.selection'
  )
    return { type: 'object', additionalProperties: false };
  if (name === 'scene3d.add')
    return {
      type: 'object',
      additionalProperties: false,
      required: ['object'],
      properties: { object: { type: 'object' } },
    };
  if (name === 'scene3d.transform')
    return {
      type: 'object',
      additionalProperties: false,
      required: ['objectId', 'transform'],
      properties: { objectId: { type: 'string', minLength: 1 }, transform: { type: 'object' } },
    };
  if (name === 'scene3d.material')
    return {
      type: 'object',
      additionalProperties: false,
      properties: {
        objectId: { type: 'string', minLength: 1 },
        materialId: { type: 'string', minLength: 1 },
        material: { type: 'object' },
      },
    };
  if (name === 'scene3d.remove')
    return {
      type: 'object',
      additionalProperties: false,
      required: ['objectId'],
      properties: { objectId: { type: 'string', minLength: 1 } },
    };
  return {
    type: 'object',
    additionalProperties: false,
    properties: { cameraId: { type: 'string', minLength: 1 } },
  };
}
