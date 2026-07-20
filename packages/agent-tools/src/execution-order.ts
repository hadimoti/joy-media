import type { AgentEditPlan, AgentPlanStep } from './plan.js';

export interface ExecutionOrder {
  readonly order: readonly string[];
  readonly parallel: readonly string[][];
  readonly hasCycle: boolean;
}

export function resolveExecutionOrder(plan: AgentEditPlan): ExecutionOrder {
  const stepMap = new Map<string, AgentPlanStep>();
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const step of plan.steps) {
    stepMap.set(step.id, step);
    inDegree.set(step.id, step.dependsOn.length);
    dependents.set(step.id, []);
  }

  for (const step of plan.steps) {
    for (const depId of step.dependsOn) {
      const deps = dependents.get(depId);
      if (deps) {
        deps.push(step.id);
      }
    }
  }

  const queue: string[] = [];
  for (const [stepId, degree] of inDegree) {
    if (degree === 0) {
      queue.push(stepId);
    }
  }

  const order: string[] = [];
  const parallel: string[][] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const level: string[] = [...queue];
    parallel.push(level);
    queue.length = 0;

    for (const stepId of level) {
      order.push(stepId);
      visited.add(stepId);

      const deps = dependents.get(stepId) ?? [];
      for (const depId of deps) {
        const degree = (inDegree.get(depId) ?? 1) - 1;
        inDegree.set(depId, degree);
        if (degree === 0) {
          queue.push(depId);
        }
      }
    }
  }

  const hasCycle = visited.size !== plan.steps.length;

  return { order, parallel, hasCycle };
}

export function canStepExecute(step: AgentPlanStep, completedSteps: ReadonlySet<string>): boolean {
  return step.dependsOn.every((depId) => completedSteps.has(depId));
}

export function getReadySteps(
  plan: AgentEditPlan,
  completedSteps: ReadonlySet<string>,
  startedSteps: ReadonlySet<string>,
): readonly AgentPlanStep[] {
  return plan.steps.filter((step) => {
    if (completedSteps.has(step.id) || startedSteps.has(step.id)) {
      return false;
    }
    return canStepExecute(step, completedSteps);
  });
}
