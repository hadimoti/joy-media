import type { EditTool } from './edit-tools.js';
import {
  createAddEffectTool,
  createInsertClipTool,
  createJoinClipsTool,
  createMoveClipTool,
  createRemoveClipTool,
  createSetFadeTool,
  createSetGainTool,
  createSetMuteTool,
  createSetPanTool,
  createSplitClipTool,
  createTrimClipTool,
} from './edit-tools.js';
import type { QueryTool } from './queries.js';
import {
  createEstimateImpactTool,
  createFindActiveClipsTool,
  createFindClipTool,
  createFindMissingAssetsTool,
  createGetAudioRegionsTool,
  createGetBrandConstraintsTool,
  createGetProviderCapabilitiesTool,
  createGetTimelineSummaryTool,
  createInspectPropertiesTool,
  createSearchTranscriptTool,
} from './queries.js';
import type { ToolDefinition } from './types.js';
import { createScene3DToolDefinitions } from './scene3d-tools.js';

export interface ToolRegistry {
  readonly tools: ReadonlyMap<string, ToolDefinition>;
  getTool(name: string): QueryTool | EditTool | undefined;
  getToolsByCategory(category: ToolDefinition['category']): readonly (QueryTool | EditTool)[];
  getToolNames(): readonly string[];
  hasTool(name: string): boolean;
  readonly scene3dDefinitions: readonly ToolDefinition[];
}

export function createToolRegistry(): ToolRegistry {
  const queryTools: readonly QueryTool[] = [
    createFindClipTool(),
    createFindActiveClipsTool(),
    createSearchTranscriptTool(),
    createGetAudioRegionsTool(),
    createInspectPropertiesTool(),
    createFindMissingAssetsTool(),
    createEstimateImpactTool(),
    createGetTimelineSummaryTool(),
    createGetProviderCapabilitiesTool(),
    createGetBrandConstraintsTool(),
  ];

  const editTools: readonly EditTool[] = [
    createInsertClipTool(),
    createRemoveClipTool(),
    createMoveClipTool(),
    createTrimClipTool(),
    createSplitClipTool(),
    createJoinClipsTool(),
    createSetGainTool(),
    createSetPanTool(),
    createSetMuteTool(),
    createSetFadeTool(),
    createAddEffectTool(),
  ];

  const allTools: readonly (QueryTool | EditTool)[] = [...queryTools, ...editTools];
  const scene3dDefinitions = createScene3DToolDefinitions();
  const toolMap = new Map<string, ToolDefinition>();
  const toolImplMap = new Map<string, QueryTool | EditTool>();

  for (const tool of allTools) {
    const definition = 'definition' in tool ? tool.definition : createQueryDefinition(tool);
    toolMap.set(tool.name, definition);
    toolImplMap.set(tool.name, tool);
  }
  for (const definition of scene3dDefinitions) toolMap.set(definition.name, definition);

  return {
    tools: toolMap,
    scene3dDefinitions,
    getTool: (name) => toolImplMap.get(name),
    getToolsByCategory: (category) => {
      return allTools.filter((tool) => {
        const def = 'definition' in tool ? tool.definition : createQueryDefinition(tool);
        return def.category === category;
      });
    },
    getToolNames: () => [...toolMap.keys()],
    hasTool: (name) => toolMap.has(name),
  };
}

function createQueryDefinition(tool: QueryTool): ToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    category: 'query',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    scope: {
      capabilities: ['timeline.read'],
      isReversible: true,
    },
    preconditions: [],
    requiresConfirmation: false,
    supportsDryRun: false,
    returnsStableIds: true,
  };
}
