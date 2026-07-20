import type { AgentEditPlan, AgentPlanStep } from './plan.js';

export function generateTransactionLabel(plan: AgentEditPlan): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const goal = plan.goal.slice(0, 50);
  return `[${timestamp}] ${goal}`;
}

export function generateStepLabel(step: AgentPlanStep): string {
  const toolName = step.tool;
  const description = step.description.slice(0, 40);
  return `${toolName}: ${description}`;
}

export function formatTransactionLabel(baseLabel: string, timestamp?: string): string {
  const ts = timestamp ?? new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  return `[${ts}] ${baseLabel}`;
}
