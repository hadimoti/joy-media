import type { SpikeProject, JoyProjectV1 } from '@joy-media/project-schema';
import { textDocumentFromString } from '@joy-media/project-schema';
import type { JoyCodePlanOperationV1 } from '@joy-media/agent-tools';
import { textTemplateById } from './text-template-catalog.js';
import {
  prepareTextTemplateInsertion,
  type PreparedTextTemplateInsertion,
} from './text-template-transaction.js';

export interface JoyCodeTextOperationInput {
  readonly planId: string;
  readonly operationIndex: number;
  readonly timeline: SpikeProject;
  readonly visualProject: JoyProjectV1;
  readonly operation: Extract<
    JoyCodePlanOperationV1,
    { kind: 'text.insertTemplate' | 'text.setContent' | 'text.setTemplate' }
  >;
}

export type JoyCodeTextOperationResult =
  | (PreparedTextTemplateInsertion & { readonly ok: true; readonly affectedIds: readonly string[] })
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export function compileJoyCodeTextOperation(
  input: JoyCodeTextOperationInput,
): JoyCodeTextOperationResult {
  const operation = input.operation;
  if (operation.kind === 'text.insertTemplate') {
    const template = textTemplateById(operation.templateId);
    if (template === undefined)
      return {
        ok: false,
        error: {
          code: 'JOY_CODE_TEXT_TEMPLATE_UNKNOWN',
          message: `text template "${operation.templateId}" is not in the catalog`,
        },
      };
    if (operation.content.trim().length === 0 || operation.content.length > 500)
      return {
        ok: false,
        error: {
          code: 'JOY_CODE_TEXT_CONTENT_INVALID',
          message: 'text content must be non-empty and at most 500 characters',
        },
      };
    if (
      !Number.isSafeInteger(operation.startUs) ||
      operation.startUs < 0 ||
      !Number.isSafeInteger(operation.durationUs) ||
      operation.durationUs < 500_000 ||
      operation.durationUs > 10_000_000
    )
      return {
        ok: false,
        error: {
          code: 'JOY_CODE_TEXT_RANGE_INVALID',
          message: 'text placement range is outside safe bounds',
        },
      };
    const prepared = prepareTextTemplateInsertion(
      input.timeline,
      input.visualProject,
      template,
      operation.startUs,
      `${input.planId}-${input.operationIndex}`,
      operation.durationUs,
      operation.placementPreset,
    );
    if (prepared === undefined)
      return {
        ok: false,
        error: {
          code: 'JOY_CODE_TEXT_PLACEMENT_REJECTED',
          message: 'text placement does not fit the composition or available tracks',
        },
      };
    const original = prepared.document.visualObjects[prepared.inserted.objectId];
    if (original === undefined)
      return {
        ok: false,
        error: { code: 'JOY_CODE_TEXT_INTERNAL', message: 'prepared text object is missing' },
      };
    return {
      ...prepared,
      ok: true,
      affectedIds: [prepared.inserted.objectId, prepared.inserted.clipId],
      document: {
        ...prepared.document,
        visualObjects: {
          ...prepared.document.visualObjects,
          [prepared.inserted.objectId]: {
            ...original,
            text: operation.content,
            textDocument: textDocumentFromString(
              operation.content,
              `${prepared.inserted.objectId}-block`,
            ),
          },
        },
      },
    };
  }

  const object = input.visualProject.visualObjects[operation.objectId];
  if (object === undefined || object.kind !== 'text')
    return {
      ok: false,
      error: {
        code: 'JOY_CODE_TEXT_OBJECT_UNKNOWN',
        message: `text object "${operation.objectId}" does not exist`,
      },
    };
  if (operation.kind === 'text.setContent') {
    if (operation.content.trim().length === 0 || operation.content.length > 500)
      return {
        ok: false,
        error: {
          code: 'JOY_CODE_TEXT_CONTENT_INVALID',
          message: 'text content must be non-empty and at most 500 characters',
        },
      };
    const document: JoyProjectV1 = {
      ...input.visualProject,
      visualObjects: {
        ...input.visualProject.visualObjects,
        [operation.objectId]: {
          ...object,
          text: operation.content,
          textDocument: textDocumentFromString(operation.content, `${operation.objectId}-block`),
        },
      },
    };
    return {
      ok: true,
      inserted: { clipId: '', objectId: operation.objectId },
      timeline: { label: 'Set text content', commands: [] },
      document,
      label: 'Set text content',
      affectedIds: [operation.objectId],
    };
  }
  const template = textTemplateById(operation.templateId);
  if (template === undefined)
    return {
      ok: false,
      error: {
        code: 'JOY_CODE_TEXT_TEMPLATE_UNKNOWN',
        message: `text template "${operation.templateId}" is not in the catalog`,
      },
    };
  const document: JoyProjectV1 = {
    ...input.visualProject,
    visualObjects: {
      ...input.visualProject.visualObjects,
      [operation.objectId]: {
        ...object,
        text: template.sample,
        textDocument: template.document,
        textStyle: template.style,
      },
    },
  };
  return {
    ok: true,
    inserted: { clipId: '', objectId: operation.objectId },
    timeline: { label: `Set text template ${template.label}`, commands: [] },
    document,
    label: `Set text template ${template.label}`,
    affectedIds: [operation.objectId],
  };
}
