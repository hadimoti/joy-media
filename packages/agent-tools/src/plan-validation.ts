import type { ToolRegistry } from './registry.js';
import type { EditorContext } from './context.js';
import type { AgentEditPlan } from './plan.js';

export interface PlanValidationResult {
  readonly valid: boolean;
  readonly errors: readonly PlanError[];
  readonly warnings: readonly string[];
}

export interface PlanError {
  readonly stepId?: string;
  readonly code: string;
  readonly message: string;
}

export function validatePlanStructure(plan: AgentEditPlan): PlanValidationResult {
  const errors: PlanError[] = [];
  const warnings: string[] = [];

  if (plan.planVersion !== 1) {
    errors.push({ code: 'INVALID_VERSION', message: 'planVersion must be 1' });
  }

  if (!plan.planId || plan.planId.trim().length === 0) {
    errors.push({ code: 'MISSING_PLAN_ID', message: 'planId is required' });
  }

  if (!plan.goal || plan.goal.trim().length === 0) {
    errors.push({ code: 'MISSING_GOAL', message: 'goal is required' });
  }

  if (plan.steps.length === 0) {
    errors.push({ code: 'NO_STEPS', message: 'plan must have at least one step' });
  }

  const stepIds = new Set<string>();
  for (const step of plan.steps) {
    if (stepIds.has(step.id)) {
      errors.push({
        stepId: step.id,
        code: 'DUPLICATE_STEP_ID',
        message: `duplicate step id: ${step.id}`,
      });
    }
    stepIds.add(step.id);

    if (!step.tool || step.tool.trim().length === 0) {
      errors.push({
        stepId: step.id,
        code: 'MISSING_TOOL',
        message: `step ${step.id} must specify a tool`,
      });
    }

    if (!step.description || step.description.trim().length === 0) {
      warnings.push(`step ${step.id} has no description`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validatePlanAgainstContext(
  plan: AgentEditPlan,
  registry: ToolRegistry,
  _context: EditorContext,
): PlanValidationResult {
  const errors: PlanError[] = [];
  const warnings: string[] = [];

  for (const step of plan.steps) {
    if (!registry.hasTool(step.tool)) {
      errors.push({
        stepId: step.id,
        code: 'TOOL_NOT_FOUND',
        message: `tool '${step.tool}' not found in registry`,
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

export function validateStepDependencies(plan: AgentEditPlan): PlanValidationResult {
  const errors: PlanError[] = [];
  const warnings: string[] = [];

  const stepIds = new Set(plan.steps.map((s) => s.id));

  for (const step of plan.steps) {
    for (const depId of step.dependsOn) {
      if (!stepIds.has(depId)) {
        errors.push({
          stepId: step.id,
          code: 'INVALID_DEPENDENCY',
          message: `step ${step.id} depends on non-existent step ${depId}`,
        });
      }
    }
  }

  if (hasCycle(plan)) {
    errors.push({
      code: 'DEPENDENCY_CYCLE',
      message: 'plan contains circular dependencies',
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}

function hasCycle(plan: AgentEditPlan): boolean {
  const graph = new Map<string, string[]>();
  for (const step of plan.steps) {
    graph.set(step.id, [...step.dependsOn]);
  }

  const visited = new Set<string>();
  const recStack = new Set<string>();

  for (const stepId of graph.keys()) {
    if (dfs(stepId, graph, visited, recStack)) {
      return true;
    }
  }

  return false;
}

function dfs(
  node: string,
  graph: Map<string, string[]>,
  visited: Set<string>,
  recStack: Set<string>,
): boolean {
  if (!visited.has(node)) {
    visited.add(node);
    recStack.add(node);

    const neighbors = graph.get(node) ?? [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor) && dfs(neighbor, graph, visited, recStack)) {
        return true;
      }
      if (recStack.has(neighbor)) {
        return true;
      }
    }
  }

  recStack.delete(node);
  return false;
}
