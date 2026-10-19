/* global console */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CliFlags } from '../cli.js';
import {
  applyPreparedOperations,
  changedEntities,
  preparedPlanId,
  sha256Identity,
  type PreparedOperation,
} from '../services/prepared-edit.js';
import {
  applyPreparedTitleOperation,
  isTitleOperation,
  validateFrozenTitleOutput,
} from '../services/prepared-title.js';
import { ensureTitleTextMeasurer } from '../services/title-measure.js';
import {
  CommandFailure,
  emitJson,
  loadProject,
  locateProject,
  reportFailure,
  usageFailure,
  withExclusiveLock,
  writeFileAtomic,
  writeProjectFileWithAppliedPlans,
  type AppliedPlanLedger,
} from '../utils/project-loader.js';
import type { CliProjectDocument } from '../utils/project-loader.js';

// A type alias (not an interface) keeps the named fields through Omit and stays assignable to
// the Record parameter of preparedPlanId.
type EditPlan = {
  kind: 'joy-media.prepared-edit';
  schemaVersion: 1;
  semanticsVersion: 1 | 2;
  planId: string;
  projectId: string;
  baseRevision: number;
  baseHash: string;
  preparedAt: string;
  operations: PreparedOperation[];
  resultHash: string;
  changedEntities: ReturnType<typeof changedEntities>;
  warnings: string[];
  estimatedWork: { operationCount: number };
};

function parseJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new CommandFailure('FILE_NOT_FOUND', `File not found: ${path}`);
    }
    throw new CommandFailure(
      'FILE_INVALID',
      `Cannot read JSON file ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOperationsFile(path: string): PreparedOperation[] {
  const input = parseJsonFile(path);
  if (!isRecord(input) || input.schemaVersion !== 1 || !Array.isArray(input.operations)) {
    throw new CommandFailure(
      'PLAN_INVALID',
      'Operations input must contain schemaVersion 1 and an operations array.',
    );
  }
  if (input.operations.length > 24)
    throw new CommandFailure('PLAN_INVALID', 'A plan can contain at most 24 operations.');
  return input.operations as PreparedOperation[];
}

function parsePlan(path: string): EditPlan {
  const plan = parseJsonFile(path);
  if (!isRecord(plan) || plan.kind !== 'joy-media.prepared-edit' || plan.schemaVersion !== 1) {
    throw new CommandFailure(
      'PLAN_INVALID',
      'File is not a supported joy-media.prepared-edit plan (schemaVersion 1).',
    );
  }
  if (plan.semanticsVersion !== 1 && plan.semanticsVersion !== 2)
    throw new CommandFailure(
      'PLAN_UNSUPPORTED_SEMANTICS',
      `Unsupported prepared plan semanticsVersion ${String(plan.semanticsVersion)}.`,
    );
  if (typeof plan.planId !== 'string' || preparedPlanId(plan) !== plan.planId) {
    throw new CommandFailure('PLAN_TAMPERED', `Plan identity does not match its contents: ${path}`);
  }
  if (
    !Array.isArray(plan.operations) ||
    !Number.isInteger(plan.baseRevision) ||
    typeof plan.baseHash !== 'string' ||
    typeof plan.resultHash !== 'string'
  ) {
    throw new CommandFailure('PLAN_INVALID', 'Plan is missing required immutable fields.');
  }
  if (
    Array.isArray(plan.operations) &&
    plan.operations.some((op) => isRecord(op) && isTitleOperation(op as PreparedOperation)) &&
    plan.semanticsVersion !== 2
  )
    throw new CommandFailure(
      'PLAN_UNSUPPORTED_SEMANTICS',
      'Title operations require semanticsVersion 2.',
    );
  return plan as unknown as EditPlan;
}

function applyOperations(
  project: CliProjectDocument,
  operations: readonly PreparedOperation[],
  prepare: boolean,
): { project: CliProjectDocument; operations: PreparedOperation[] } {
  if (operations.length > 24)
    throw new CommandFailure('PLAN_INVALID', 'A plan can contain at most 24 operations.');
  const ids = new Set<string>();
  let current = project;
  const normalized: PreparedOperation[] = [];
  for (const operation of operations) {
    if (
      !isRecord(operation) ||
      typeof operation.id !== 'string' ||
      !operation.id ||
      ids.has(operation.id)
    )
      throw new CommandFailure('PLAN_INVALID', 'Every operation requires a unique string id.');
    ids.add(operation.id);
    if (isTitleOperation(operation)) {
      const result = applyPreparedTitleOperation(current, operation, prepare);
      current = result.project;
      normalized.push(result.operation);
    } else {
      current = applyPreparedOperations(current, [operation]);
      normalized.push(operation);
    }
  }
  return { project: current, operations: normalized };
}

function parseRevision(value: string | undefined): number {
  if (value === undefined || !/^\d+$/.test(value))
    throw usageFailure('--expected-revision is required and must be a non-negative integer.');
  const revision = Number(value);
  if (!Number.isSafeInteger(revision))
    throw usageFailure('--expected-revision must be a safe integer.');
  return revision;
}

function planSummary(plan: EditPlan, path?: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    planId: plan.planId,
    projectId: plan.projectId,
    baseRevision: plan.baseRevision,
    baseHash: plan.baseHash,
    resultHash: plan.resultHash,
    ...(path === undefined ? {} : { path }),
    changedEntities: plan.changedEntities,
    warnings: plan.warnings,
    estimatedWork: plan.estimatedWork,
  };
}

async function prepare(args: string[], flags: CliFlags): Promise<number> {
  await ensureTitleTextMeasurer();
  if (args.length !== 2 || !flags.project || !flags.output) {
    throw usageFailure(
      'Usage: joy-media plan prepare <operations.json> --project <file> --output <plan.json> [--json]',
    );
  }
  const outputPath = resolve(flags.output);
  if (existsSync(outputPath))
    throw new CommandFailure('PLAN_EXISTS', `Plan output already exists: ${outputPath}`);
  const { project, revision } = loadProject(flags.project, flags.sqlitePath);
  if (project.schemaVersion !== 1 && project.schemaVersion !== 2 && project.schemaVersion !== 3) {
    throw new CommandFailure(
      'PROJECT_SCHEMA_UNSUPPORTED',
      `Unsupported project schemaVersion ${project.schemaVersion}.`,
    );
  }
  const operations = parseOperationsFile(args[1]!);
  const prepared = applyOperations(project, operations, true);
  const next = prepared.project;
  const preparedAt = new Date().toISOString();
  const resultDocument = { ...next, updatedAt: preparedAt };
  const withoutId: Omit<EditPlan, 'planId'> = {
    kind: 'joy-media.prepared-edit',
    schemaVersion: 1,
    semanticsVersion: prepared.operations.some(isTitleOperation) ? 2 : 1,
    projectId: project.id,
    baseRevision: revision,
    baseHash: sha256Identity(project),
    preparedAt,
    operations: prepared.operations,
    resultHash: sha256Identity(resultDocument),
    changedEntities: changedEntities(project, resultDocument),
    warnings: [],
    estimatedWork: { operationCount: prepared.operations.length },
  };
  const plan: EditPlan = { ...withoutId, planId: preparedPlanId(withoutId) };
  withExclusiveLock(outputPath, () => {
    if (existsSync(outputPath))
      throw new CommandFailure('PLAN_EXISTS', `Plan output already exists: ${outputPath}`);
    writeFileAtomic(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  });
  if (flags.json) emitJson(planSummary(plan, outputPath));
  else
    console.log(
      `Prepared edit plan ${plan.planId} for project ${plan.projectId} at revision ${revision}: ${outputPath}`,
    );
  return 0;
}

function inspect(args: string[], flags: CliFlags): number {
  if (args.length !== 2) throw usageFailure('Usage: joy-media plan inspect <plan.json> [--json]');
  const path = resolve(args[1]!);
  const plan = parsePlan(path);
  const summary = { ...planSummary(plan), operationsCount: plan.operations.length };
  if (flags.json) emitJson(summary);
  else console.log(JSON.stringify(summary, null, 2));
  return 0;
}

async function apply(args: string[], flags: CliFlags): Promise<number> {
  if (args.length !== 2 || !flags.project) {
    throw usageFailure(
      'Usage: joy-media plan apply <plan.json> --project <file> --expected-revision N --idempotency-key K [--json]',
    );
  }
  const expectedRevision = parseRevision(flags.expectedRevision);
  const key = flags.idempotencyKey;
  if (!key) throw usageFailure('--idempotency-key is required.');
  const project = flags.project;
  const location = locateProject(project, flags.sqlitePath);
  const receipt = withExclusiveLock(location.path, () => {
    const plan = parsePlan(resolve(args[1]!));
    const info = loadProject(project, flags.sqlitePath);
    if (flags.sqlitePath || info.source !== 'file') {
      throw new CommandFailure(
        'PLAN_STORE_UNSUPPORTED',
        'Prepared edit apply currently supports file projects only; SQLite projects are read-only for this command.',
      );
    }
    const ledger = info.appliedPlans ?? {};
    const prior: unknown = Object.hasOwn(ledger, key) ? ledger[key] : undefined;
    if (prior !== undefined) {
      if (!isRecord(prior) || !isRecord(prior.receipt)) {
        throw new CommandFailure(
          'PROJECT_FILE_INVALID',
          `The applied-plan record for key "${key}" is malformed; nothing was written.`,
        );
      }
      if (prior.planId !== plan.planId)
        throw new CommandFailure(
          'IDEMPOTENCY_CONFLICT',
          `Idempotency key "${key}" was already used for another plan.`,
        );
      // A replay must agree with the plan it claims to record. The response takes its identity
      // from the plan and the document, never from the stored object.
      const receipt = prior.receipt;
      if (
        receipt.baseRevision !== plan.baseRevision ||
        receipt.revision !== plan.baseRevision + 1 ||
        receipt.resultHash !== plan.resultHash
      ) {
        throw new CommandFailure(
          'PROJECT_FILE_INVALID',
          `The applied-plan record for key "${key}" does not match plan ${plan.planId}; nothing was written.`,
        );
      }
      return {
        schemaVersion: 1,
        projectId: info.project.id,
        planId: plan.planId,
        idempotencyKey: key,
        baseRevision: plan.baseRevision,
        revision: plan.baseRevision + 1,
        resultHash: plan.resultHash,
        replayed: true,
      };
    }
    if (expectedRevision !== info.revision)
      throw new CommandFailure(
        'STALE_REVISION',
        `Expected revision ${expectedRevision}, but project is at revision ${info.revision}.`,
      );
    if (
      plan.projectId !== info.project.id ||
      plan.baseRevision !== info.revision ||
      plan.baseHash !== sha256Identity(info.project)
    ) {
      throw new CommandFailure(
        'STALE_PLAN',
        'The project no longer matches the base revision and content recorded in this plan.',
      );
    }
    const { project: next, operations: ignored } = applyOperations(
      info.project,
      plan.operations,
      false,
    );
    void ignored;
    const resultDocument = { ...next, updatedAt: plan.preparedAt };
    if (plan.semanticsVersion === 2) validateFrozenTitleOutput(resultDocument);
    const resultHash = sha256Identity(resultDocument);
    if (resultHash !== plan.resultHash)
      throw new CommandFailure(
        'PLAN_DRIFT',
        'Reapplying the plan produced a different project document.',
      );
    const storedReceipt = { baseRevision: info.revision, revision: info.revision + 1, resultHash };
    const nextLedger: AppliedPlanLedger = {
      ...ledger,
      [key]: { planId: plan.planId, receipt: storedReceipt },
    };
    writeProjectFileWithAppliedPlans(
      resultDocument,
      { path: info.path, revision: info.revision },
      nextLedger,
    );
    return {
      schemaVersion: 1,
      projectId: info.project.id,
      planId: plan.planId,
      idempotencyKey: key,
      ...storedReceipt,
      replayed: false,
    };
  });
  if (flags.json) emitJson(receipt);
  else console.log(JSON.stringify(receipt, null, 2));
  return 0;
}

/** Prepare, inspect and apply content-addressed timeline edit plans. */
export async function handlePlanCommand(args: string[], flags: CliFlags): Promise<number> {
  try {
    switch (args[0]) {
      case 'prepare':
        return await prepare(args, flags);
      case 'inspect':
        return inspect(args, flags);
      case 'apply':
        return await apply(args, flags);
      default:
        throw usageFailure(
          `Missing or unknown plan subcommand: ${args[0] ?? '(none)'}. Available: prepare, inspect, apply.`,
        );
    }
  } catch (err) {
    return reportFailure(err, Boolean(flags.json), 'plan');
  }
}
