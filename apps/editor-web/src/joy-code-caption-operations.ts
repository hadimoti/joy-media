import {
  applyCaptionProjectCommand,
  JOY_CAPTION_TEMPLATES,
  type CaptionCommand,
} from '@joy-media/captions-core';
import type { JoyProjectV1 } from '@joy-media/project-schema';
import type { JoyCodePlanOperationV1 } from '@joy-media/agent-tools';
import { CAPTION_BURN_IN_KEY } from './caption-burn-in.js';

export interface JoyCodeCaptionOperationInput {
  readonly project: JoyProjectV1;
  readonly operation: Extract<JoyCodePlanOperationV1, { kind: `caption.${string}` }>;
}

export type JoyCodeCaptionOperationResult =
  | {
      readonly ok: true;
      readonly project: JoyProjectV1;
      readonly affectedIds: readonly string[];
      readonly summary: string;
    }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export function compileJoyCodeCaptionOperation(
  input: JoyCodeCaptionOperationInput,
): JoyCodeCaptionOperationResult {
  const operation = input.operation;
  if (operation.kind === 'caption.setBurnIn') {
    return {
      ok: true,
      project: {
        ...input.project,
        pluginData: { ...input.project.pluginData, [CAPTION_BURN_IN_KEY]: operation.enabled },
      },
      affectedIds: [CAPTION_BURN_IN_KEY],
      summary: `${operation.enabled ? 'Enable' : 'Disable'} caption burn-in`,
    };
  }
  const captionClip = findCaptionClip(input.project, operation.captionClipId);
  if (captionClip === undefined)
    return {
      ok: false,
      error: {
        code: 'JOY_CODE_CAPTION_CLIP_UNKNOWN',
        message: `caption clip "${operation.captionClipId}" does not exist`,
      },
    };
  const document = input.project.captionDocuments[captionClip.captionDocumentId];
  if (document === undefined)
    return {
      ok: false,
      error: {
        code: 'JOY_CODE_CAPTION_DOCUMENT_UNKNOWN',
        message: `caption document "${captionClip.captionDocumentId}" does not exist`,
      },
    };
  let command: CaptionCommand;
  switch (operation.kind) {
    case 'caption.setSegmentText':
      if (
        !document.segments.some((segment) => segment.id === operation.segmentId) ||
        operation.text.length > 500 ||
        operation.text.trim().length === 0
      )
        return {
          ok: false,
          error: {
            code: 'JOY_CODE_CAPTION_SEGMENT_INVALID',
            message: 'caption segment or bounded text is invalid',
          },
        };
      command = {
        type: 'caption.setSegmentText',
        payload: {
          documentId: document.id,
          segmentId: operation.segmentId,
          textOverride: operation.text,
        },
      };
      break;
    case 'caption.setSegmentTiming':
      if (!document.segments.some((segment) => segment.id === operation.segmentId))
        return {
          ok: false,
          error: {
            code: 'JOY_CODE_CAPTION_SEGMENT_UNKNOWN',
            message: `caption segment "${operation.segmentId}" does not exist`,
          },
        };
      command = {
        type: 'caption.setSegmentTiming',
        payload: {
          documentId: document.id,
          segmentId: operation.segmentId,
          startUs: operation.startUs,
          endUs: operation.endUs,
        },
      };
      break;
    case 'caption.setTemplate':
      if (!JOY_CAPTION_TEMPLATES.some((template) => template.id === operation.templateId))
        return {
          ok: false,
          error: {
            code: 'JOY_CODE_CAPTION_TEMPLATE_UNKNOWN',
            message: `caption template "${operation.templateId}" is not in the catalog`,
          },
        };
      command = {
        type: 'caption.setStyle',
        payload: { documentId: document.id, styleRef: operation.templateId },
      };
      break;
    default:
      return {
        ok: false,
        error: {
          code: 'JOY_CODE_CAPTION_OPERATION_INVALID',
          message: 'unsupported caption operation',
        },
      };
  }
  try {
    const applied = applyCaptionProjectCommand(input.project, command);
    return {
      ok: true,
      project: applied.project,
      affectedIds: [operation.captionClipId, document.id],
      summary: `Apply ${operation.kind}`,
    };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: 'JOY_CODE_CAPTION_COMMAND_REJECTED',
        message: error instanceof Error ? error.message : 'caption command rejected',
      },
    };
  }
}

function findCaptionClip(project: JoyProjectV1, clipId: string) {
  for (const composition of Object.values(project.compositions)) {
    for (const track of composition.tracks) {
      const clip = track.clips.find(
        (candidate) => candidate.kind === 'caption' && candidate.id === clipId,
      );
      if (clip?.kind === 'caption') return clip;
    }
  }
  return undefined;
}
