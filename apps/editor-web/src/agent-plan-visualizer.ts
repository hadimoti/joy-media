import type { SpikeProject } from '@joy-media/project-schema';
import type { AgentEditPlan } from '@joy-media/agent-tools';
import type { JsonValue } from '@joy-media/agent-tools';

export type AgentPendingChange =
  | { kind: 'add'; clipId: string; trackId: string; startUs: number; durationUs: number }
  | { kind: 'remove'; clipId: string; trackId: string }
  | { kind: 'move'; clipId: string; trackId: string; newStartUs: number }
  | { kind: 'split'; originalClipId: string; newClipId: string; atUs: number }
  | { kind: 'join'; firstClipId: string; secondClipId: string };

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: JsonValue | undefined): value is string {
  return typeof value === 'string';
}

function isNumber(value: JsonValue | undefined): value is number {
  return typeof value === 'number';
}

function extractSplitChange(step: AgentEditPlan['steps'][number]): AgentPendingChange | undefined {
  const args = step.arguments;
  if (!isRecord(args)) return undefined;
  const clipId = args['clipId'];
  const newClipId = args['newClipId'];
  const atUs = args['atUs'];
  if (!isString(clipId) || !isString(newClipId) || !isNumber(atUs)) return undefined;
  return { kind: 'split', originalClipId: clipId, newClipId, atUs };
}

function extractMoveChange(step: AgentEditPlan['steps'][number]): AgentPendingChange | undefined {
  const args = step.arguments;
  if (!isRecord(args)) return undefined;
  const clipId = args['clipId'];
  const trackId = args['trackId'];
  const newStartUs = args['newStartUs'];
  if (!isString(clipId) || !isString(trackId) || !isNumber(newStartUs)) return undefined;
  return { kind: 'move', clipId, trackId, newStartUs };
}

function extractRemoveChange(step: AgentEditPlan['steps'][number]): AgentPendingChange | undefined {
  const args = step.arguments;
  if (!isRecord(args)) return undefined;
  const clipId = args['clipId'];
  const trackId = args['trackId'];
  if (!isString(clipId) || !isString(trackId)) return undefined;
  return { kind: 'remove', clipId, trackId };
}

function extractJoinChange(step: AgentEditPlan['steps'][number]): AgentPendingChange | undefined {
  const args = step.arguments;
  if (!isRecord(args)) return undefined;
  const firstClipId = args['firstClipId'];
  const secondClipId = args['secondClipId'];
  if (!isString(firstClipId) || !isString(secondClipId)) return undefined;
  return { kind: 'join', firstClipId, secondClipId };
}

function extractAddChange(step: AgentEditPlan['steps'][number]): AgentPendingChange | undefined {
  const args = step.arguments;
  if (!isRecord(args)) return undefined;
  const trackId = args['trackId'];
  const clip = args['clip'];
  if (!isString(trackId) || !isRecord(clip)) return undefined;
  const clipId = clip['id'];
  const startUs = clip['startUs'];
  const durationUs = clip['durationUs'];
  if (!isString(clipId) || !isNumber(startUs) || !isNumber(durationUs)) return undefined;
  return { kind: 'add', clipId, trackId, startUs, durationUs };
}

export function extractPendingChanges(
  plan: AgentEditPlan,
  _project: SpikeProject,
): AgentPendingChange[] {
  const changes: AgentPendingChange[] = [];
  for (const step of plan.steps) {
    let change: AgentPendingChange | undefined;
    switch (step.tool) {
      case 'splitClip':
        change = extractSplitChange(step);
        break;
      case 'moveClip':
        change = extractMoveChange(step);
        break;
      case 'removeClip':
        change = extractRemoveChange(step);
        break;
      case 'joinClips':
        change = extractJoinChange(step);
        break;
      case 'insertClip':
        change = extractAddChange(step);
        break;
    }
    if (change !== undefined) changes.push(change);
  }
  return changes;
}
