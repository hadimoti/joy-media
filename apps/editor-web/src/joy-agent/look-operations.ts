/**
 * Living Look host operations (R2 / L2).
 *
 * The bridge between the pure `@joy-media/motion-core` Look compiler and the
 * R1 canonical operation path. `translateLookOperations` is a 1:1, total
 * mapping from the compiler's `LookOperation` intermediate to
 * `JoyCodePlanOperationV1` — the exact type the shared `validate_proposal`
 * staging handler already compiles, stages, and routes to approval. No new
 * apply path: a Look change is an ordinary prepared change with Undo.
 *
 * `catalog` and `describe` are read-only. They compute honest availability the
 * same way R1's recipe catalogue does — a Look whose required operation kinds
 * or fonts are not available is listed, disabled, with the reason shown.
 */

import {
  compileLook,
  validateLookDefinition,
  type LookCompileInput,
  type LookCompileResult,
  type LookDefinition,
  type LookOperation,
} from '@joy-media/motion-core';
import {
  JOY_CODE_OPERATION_KINDS,
  JOY_CODE_PLAN_SCHEMA_VERSION,
  type JoyCodeModelPlanV1,
  type JoyCodeOperationKind,
  type JoyCodePlanOperationV1,
} from '@joy-media/agent-tools';

export interface LookCatalogEntry {
  readonly definition: LookDefinition;
  readonly available: boolean;
  readonly missingOperationKinds: readonly JoyCodeOperationKind[];
  readonly missingFonts: readonly string[];
  readonly definitionDiagnostics: readonly string[];
}

export interface LookCatalogContext {
  /** Operation kinds this runtime advertises (defaults to the full canonical set). */
  readonly availableOperationKinds?: readonly JoyCodeOperationKind[];
  /** Bundled font families available to the editor. */
  readonly availableFonts: readonly string[];
}

const CANONICAL_KINDS = new Set<string>(JOY_CODE_OPERATION_KINDS);

/** Read-only: the honest availability matrix for a set of Look definitions. */
export function catalog(
  definitions: readonly LookDefinition[],
  context: LookCatalogContext,
): readonly LookCatalogEntry[] {
  const availableKinds = new Set<string>(
    context.availableOperationKinds ?? JOY_CODE_OPERATION_KINDS,
  );
  const availableFonts = new Set(context.availableFonts);

  return definitions.map((definition) => {
    const definitionDiagnostics = validateLookDefinition(definition).map(
      (d) => `${d.path}: ${d.message}`,
    );
    const missingOperationKinds = definition.requiredOperationKinds.filter(
      (kind) => !CANONICAL_KINDS.has(kind) || !availableKinds.has(kind),
    ) as readonly JoyCodeOperationKind[];
    const missingFonts = definition.requiredFonts.filter((font) => !availableFonts.has(font));
    return {
      definition,
      available:
        definitionDiagnostics.length === 0 &&
        missingOperationKinds.length === 0 &&
        missingFonts.length === 0,
      missingOperationKinds,
      missingFonts,
      definitionDiagnostics,
    };
  });
}

export interface LookDescription {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly description: string;
  readonly slots: readonly {
    readonly id: string;
    readonly label: string;
    readonly required: boolean;
  }[];
  readonly controls: readonly {
    readonly id: string;
    readonly label: string;
    readonly kind: string;
    readonly default: number | string | boolean;
  }[];
}

/** Read-only: a compact, translation-safe description for the panel and the agent. */
export function describe(definition: LookDefinition): LookDescription {
  return {
    id: definition.id,
    version: definition.version,
    title: definition.title,
    description: definition.description,
    slots: definition.slots.map((s) => ({ id: s.id, label: s.label, required: s.required })),
    controls: definition.controls.map((c) => ({
      id: c.id,
      label: c.label,
      kind: c.kind,
      default: c.default,
    })),
  };
}

/**
 * One or two canonical operations per `LookOperation`. A `text.setTemplate`
 * that lands on an object whose current text is known also emits a dependent
 * `text.setContent` restoring that text — `motion-core` is pure and cannot see
 * the live document, so a bare template swap would replace the operator's words
 * with the template's sample copy. `currentTextByObjectId` is the host's
 * snapshot of the bound objects' text at plan time.
 */
export function translateLookOperations(
  operations: readonly LookOperation[],
  idPrefix: string,
  currentTextByObjectId: Readonly<Record<string, string>> = {},
): readonly JoyCodePlanOperationV1[] {
  const out: JoyCodePlanOperationV1[] = [];
  operations.forEach((operation, index) => {
    const id = `${idPrefix}-${index}`;
    out.push(translateOne(operation, id));
    if (operation.kind === 'text.setTemplate') {
      const preserved = currentTextByObjectId[operation.objectId];
      if (typeof preserved === 'string' && preserved.length > 0) {
        out.push({
          id: `${id}-keep-text`,
          dependsOn: [id],
          kind: 'text.setContent',
          objectId: operation.objectId,
          content: preserved,
        });
      }
    }
  });
  return out;
}

function translateOne(operation: LookOperation, id: string): JoyCodePlanOperationV1 {
  const base = { id, dependsOn: [] as readonly string[] };
  switch (operation.kind) {
    case 'motion.setKeyframe':
      return {
        ...base,
        kind: 'motion.setKeyframe',
        binding: {
          ownerKind: operation.ownerKind,
          ownerId: operation.ownerId,
          propertyId: operation.propertyId,
          timeDomain: operation.timeDomain,
        },
        key: {
          kind: 'scalar',
          timeUs: operation.timeUs,
          value: operation.value,
          interpolation: operation.interpolation,
        },
      };
    case 'text.setContent':
      return {
        ...base,
        kind: 'text.setContent',
        objectId: operation.objectId,
        content: operation.content,
      };
    case 'text.setTemplate':
      return {
        ...base,
        kind: 'text.setTemplate',
        objectId: operation.objectId,
        templateId: operation.templateId,
      };
    case 'caption.setTemplate':
      return {
        ...base,
        kind: 'caption.setTemplate',
        captionClipId: operation.captionClipId,
        templateId: operation.templateId,
      };
    case 'transition.addAtJunction':
      return {
        ...base,
        kind: 'transition.addAtJunction',
        outgoingClipId: operation.outgoingClipId,
        incomingClipId: operation.incomingClipId,
        transitionId: operation.transitionId,
        durationUs: operation.durationUs,
      };
    default: {
      const exhaustive: never = operation;
      throw new Error(`unhandled Look operation: ${JSON.stringify(exhaustive)}`);
    }
  }
}

export interface LookPlanResult {
  readonly ok: boolean;
  readonly plan?: JoyCodeModelPlanV1;
  readonly compilation: LookCompileResult;
}

/**
 * Compile a Look and, on success, wrap its operations in a `JoyCodeModelPlanV1`
 * ready for the shared `validate_proposal` staging handler. Returns
 * `ok: false` with the compiler diagnostics on any failure — the caller never
 * gets a partial plan.
 */
export function prepareLookPlan(
  input: LookCompileInput,
  goal: string,
  currentTextByObjectId: Readonly<Record<string, string>> = {},
): LookPlanResult {
  const compilation = compileLook(input);
  if (!compilation.ok) return { ok: false, compilation };

  const operations = translateLookOperations(
    compilation.operations,
    `look-${input.definition.id}-v${input.definition.version}`,
    currentTextByObjectId,
  );
  const plan: JoyCodeModelPlanV1 = {
    schemaVersion: JOY_CODE_PLAN_SCHEMA_VERSION,
    goal,
    summary: `Apply the "${input.definition.title}" Look: ${compilation.changedBindingIds.length} binding(s), ${operations.length} operation(s).`,
    operations,
    assumptions: [],
    blockedBy: [],
    requiresHumanDecision: [],
  };
  return { ok: true, plan, compilation };
}
