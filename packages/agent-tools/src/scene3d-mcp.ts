import {
  dryRunScene3DTool,
  inspectScene3DTool,
  type Scene3DReadTool,
  type Scene3DApprovalBinding,
  type Scene3DToolSession,
  type Scene3DWriteTool,
} from '@joy-media/scene3d-core';
import type {
  Scene3DCommit,
  Scene3DExecutionResult,
  Scene3DPlanExecutor,
} from './scene3d-execution.js';
import type { ToolDefinition } from './types.js';
import type { ToolRegistry } from './registry.js';

export interface Scene3DGatewayBinding {
  readonly getSession: () => Scene3DToolSession;
  readonly commit: Scene3DCommit;
}

/** In-process MCP-shaped gateway; transports remain host-owned and never gain filesystem authority. */
export class Scene3DMcpGateway {
  private readonly registry: ToolRegistry;
  private readonly executor: Scene3DPlanExecutor;
  private readonly binding: Scene3DGatewayBinding;

  constructor(options: {
    readonly registry: ToolRegistry;
    readonly executor: Scene3DPlanExecutor;
    readonly binding: Scene3DGatewayBinding;
  }) {
    this.registry = options.registry;
    this.executor = options.executor;
    this.binding = options.binding;
  }

  listTools(): readonly ToolDefinition[] {
    return this.registry.scene3dDefinitions;
  }

  read(name: Scene3DReadTool): unknown {
    return inspectScene3DTool(this.binding.getSession(), name);
  }

  preview(name: Scene3DWriteTool, input: Readonly<Record<string, unknown>>) {
    return dryRunScene3DTool(this.binding.getSession(), name, input);
  }

  callApproved(options: {
    readonly planId: string;
    readonly stepId: string;
    readonly idempotencyKey: string;
    readonly name: Scene3DWriteTool;
    readonly input: Readonly<Record<string, unknown>>;
    readonly approval: Scene3DApprovalBinding;
  }): Scene3DExecutionResult {
    const session = this.binding.getSession();
    return this.executor.execute({
      ...options,
      session,
      commit: this.binding.commit,
    });
  }
}
