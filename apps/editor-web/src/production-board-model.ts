import type { ArtifactStore } from '@joy-media/commands';
import type {
  ProductionApprovalV1,
  ProductionRunAuthority,
  ProductionRunEventV1,
  ProductionRunNodeProjectionV1,
  ProductionRunRecordV1,
  ProductionRunStateV1,
} from '@joy-media/workflow-engine';
import type { DataLane } from './data-lanes.js';
import type { BrowserAsset } from './control-plane-client.js';

export type ProductionBoardSectionId =
  'brief' | 'scenes' | 'assets' | 'jobs' | 'approvals' | 'qa' | 'events';

export interface ProductionBoardLink {
  readonly kind: 'asset' | 'artifact' | 'data-lane' | 'job' | 'provider' | 'report';
  readonly id: string;
  readonly label: string;
  readonly href: string;
}

export interface ProductionBoardActionAvailability {
  readonly canApprove: boolean;
  readonly canReject: boolean;
  readonly canRetry: boolean;
  readonly canCancel: boolean;
  readonly disabledReason?: string;
}

export interface ProductionBoardRunProjection {
  readonly runId: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly state: ProductionRunStateV1;
  readonly projectRevision: string;
  readonly checkpointRevision: number;
  readonly updatedSeq: number;
  readonly authorityBadge: string;
  readonly staleRevisionConflict: boolean;
  readonly pendingApprovals: readonly ProductionApprovalV1[];
  readonly actions: ProductionBoardActionAvailability;
  readonly sections: Readonly<Record<ProductionBoardSectionId, ProductionBoardSection>>;
  readonly links: readonly ProductionBoardLink[];
  readonly events: readonly ProductionRunEventV1[];
}

export interface ProductionBoardStatusGroup {
  readonly state: ProductionRunStateV1;
  readonly label: string;
  readonly runs: readonly ProductionBoardRunProjection[];
}

export interface ProductionBoardSection {
  readonly id: ProductionBoardSectionId;
  readonly label: string;
  readonly items: readonly ProductionBoardSectionItem[];
}

export interface ProductionBoardSectionItem {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
  readonly state?: string;
  readonly links: readonly ProductionBoardLink[];
}

export interface BuildProductionBoardModelInput {
  readonly records: readonly ProductionRunRecordV1[];
  readonly currentProjectRevision: string;
  readonly artifacts: ArtifactStore;
  readonly dataLanes: readonly DataLane[];
  readonly assets?: readonly BrowserAsset[];
}

export interface ProductionBoardModel {
  readonly isEmpty: boolean;
  readonly groups: readonly ProductionBoardStatusGroup[];
  readonly runs: readonly ProductionBoardRunProjection[];
  readonly counts: Readonly<Partial<Record<ProductionRunStateV1, number>>>;
}

const STATUS_ORDER: readonly ProductionRunStateV1[] = [
  'parked',
  'running',
  'queued',
  'failed',
  'canceled',
  'succeeded',
];

const STATUS_LABELS: Readonly<Record<ProductionRunStateV1, string>> = {
  queued: 'Queued',
  running: 'Running',
  parked: 'Needs review',
  failed: 'Failed',
  canceled: 'Canceled',
  succeeded: 'Delivered',
};

const SECTION_LABELS: Readonly<Record<ProductionBoardSectionId, string>> = {
  brief: 'Brief/Input',
  scenes: 'Scenes/Candidates',
  assets: 'Assets/B-roll',
  jobs: 'Jobs/Providers/Cost',
  approvals: 'Approvals',
  qa: 'QA/Delivery',
  events: 'Events',
};

export function buildProductionBoardModel(
  input: BuildProductionBoardModelInput,
): ProductionBoardModel {
  const runs = [...input.records]
    .sort(
      (left, right) => right.updatedSeq - left.updatedSeq || left.runId.localeCompare(right.runId),
    )
    .map((record) => projectRun(record, input));

  const counts: Partial<Record<ProductionRunStateV1, number>> = {};
  for (const run of runs) {
    counts[run.state] = (counts[run.state] ?? 0) + 1;
  }

  return {
    isEmpty: runs.length === 0,
    runs,
    counts,
    groups: STATUS_ORDER.flatMap((state) => {
      const grouped = runs.filter((run) => run.state === state);
      return grouped.length === 0 ? [] : [{ state, label: STATUS_LABELS[state], runs: grouped }];
    }),
  };
}

export function productionBoardNextRunId(
  runs: readonly Pick<ProductionBoardRunProjection, 'runId'>[],
  currentRunId: string | undefined,
  direction: 'next' | 'previous',
): string | undefined {
  if (runs.length === 0) return undefined;
  const currentIndex = runs.findIndex((run) => run.runId === currentRunId);
  const start = currentIndex === -1 ? 0 : currentIndex;
  const offset = direction === 'next' ? 1 : -1;
  const nextIndex = (start + offset + runs.length) % runs.length;
  return runs[nextIndex]?.runId;
}

export function productionBoardPrimaryRunId(
  model: Pick<ProductionBoardModel, 'runs'>,
  selectedRunId?: string,
): string | undefined {
  if (model.runs.length === 0) return undefined;
  if (selectedRunId !== undefined && model.runs.some((run) => run.runId === selectedRunId)) {
    return selectedRunId;
  }
  return model.runs[0]?.runId;
}

function projectRun(
  record: ProductionRunRecordV1,
  input: BuildProductionBoardModelInput,
): ProductionBoardRunProjection {
  const pendingApprovals = record.approvals.filter((approval) => approval.state === 'pending');
  const staleRevisionConflict =
    record.projectRevision !== input.currentProjectRevision && !isTerminal(record.state);
  const links = linksForRun(record, input);
  const events = [...record.events].sort((left, right) => left.seq - right.seq);
  const sections = {
    brief: briefSection(record, links),
    scenes: nodeSection('scenes', record, input),
    assets: nodeSection('assets', record, input),
    jobs: jobsSection(record, input),
    approvals: approvalsSection(record),
    qa: nodeSection('qa', record, input),
    events: eventsSection(events),
  } satisfies Record<ProductionBoardSectionId, ProductionBoardSection>;

  return {
    runId: record.runId,
    workflowId: record.workflowId,
    workflowVersion: record.workflowVersion,
    state: record.state,
    projectRevision: record.projectRevision,
    checkpointRevision: record.checkpointRevision,
    updatedSeq: record.updatedSeq,
    authorityBadge: authorityBadge(record),
    staleRevisionConflict,
    pendingApprovals,
    actions: actionAvailability(record, staleRevisionConflict, pendingApprovals),
    sections,
    links,
    events,
  };
}

function briefSection(
  record: ProductionRunRecordV1,
  links: readonly ProductionBoardLink[],
): ProductionBoardSection {
  const inputSummary =
    record.workflowInputs === undefined
      ? 'No durable input payload recorded'
      : summarizeValue(record.workflowInputs);
  return {
    id: 'brief',
    label: SECTION_LABELS.brief,
    items: [
      {
        id: `${record.runId}:brief`,
        title: `${record.workflowId} v${record.workflowVersion}`,
        detail: `run ${record.runId} · project ${record.projectRevision} · ${inputSummary}`,
        state: record.state,
        links,
      },
    ],
  };
}

function nodeSection(
  id: 'scenes' | 'assets' | 'qa',
  record: ProductionRunRecordV1,
  input: BuildProductionBoardModelInput,
): ProductionBoardSection {
  const nodes = record.nodes.filter((node) => nodeMatchesSection(node, id));
  return {
    id,
    label: SECTION_LABELS[id],
    items: nodes.map((node) => nodeItem(record, node, input)),
  };
}

function jobsSection(
  record: ProductionRunRecordV1,
  input: BuildProductionBoardModelInput,
): ProductionBoardSection {
  const jobLinks = linksForRun(record, input).filter(
    (link) => link.kind === 'job' || link.kind === 'provider' || link.kind === 'report',
  );
  const costItems = Object.values(input.artifacts.artifacts)
    .filter((artifact) => record.links.artifactIds?.includes(artifact.id))
    .filter((artifact) => artifact.provenance.cost !== undefined)
    .map((artifact) => ({
      id: `${record.runId}:cost:${artifact.id}`,
      title: artifact.label,
      detail:
        `${artifact.provenance.cost?.amount ?? ''} ${artifact.provenance.cost?.currency ?? ''}`.trim(),
      links: artifactLinks(artifact.id, input),
    }));
  const providerNodes = record.nodes.filter((node) => nodeMatchesSection(node, 'jobs'));
  return {
    id: 'jobs',
    label: SECTION_LABELS.jobs,
    items: [
      ...providerNodes.map((node) => nodeItem(record, node, input)),
      ...(jobLinks.length > 0
        ? [
            {
              id: `${record.runId}:run-links`,
              title: 'Run links',
              detail: jobLinks.map((link) => link.label).join(' · '),
              links: jobLinks,
            },
          ]
        : []),
      ...costItems,
    ],
  };
}

function approvalsSection(record: ProductionRunRecordV1): ProductionBoardSection {
  return {
    id: 'approvals',
    label: SECTION_LABELS.approvals,
    items: record.approvals.map((approval) => ({
      id: approval.approvalId,
      title: approval.prompt,
      detail: `${approval.kind} · requested seq ${String(approval.requestedSeq)}${
        approval.respondedSeq === undefined
          ? ''
          : ` · responded seq ${String(approval.respondedSeq)}`
      }`,
      state: approval.state,
      links: [],
    })),
  };
}

function eventsSection(events: readonly ProductionRunEventV1[]): ProductionBoardSection {
  return {
    id: 'events',
    label: SECTION_LABELS.events,
    items: events.map((event) => ({
      id: `event:${String(event.seq)}`,
      title: `${String(event.seq).padStart(3, '0')} · ${event.type}`,
      detail: [
        event.message,
        event.nodeId === undefined ? undefined : `node ${event.nodeId}`,
        event.approvalId === undefined ? undefined : `approval ${event.approvalId}`,
        event.failureCode === undefined ? undefined : `failure ${event.failureCode}`,
      ]
        .filter((part): part is string => part !== undefined && part.length > 0)
        .join(' · '),
      state: event.state,
      links: [],
    })),
  };
}

function nodeItem(
  record: ProductionRunRecordV1,
  node: ProductionRunNodeProjectionV1,
  input: BuildProductionBoardModelInput,
): ProductionBoardSectionItem {
  const links = node.artifactIds.flatMap((artifactId) => artifactLinks(artifactId, input));
  const lastLog = node.logs.at(-1)?.message;
  return {
    id: `${record.runId}:node:${node.nodeId}`,
    title: `${node.nodeId} · ${node.type}`,
    detail: [
      node.category,
      `${String(node.attempts)} attempt${node.attempts === 1 ? '' : 's'}`,
      node.deterministic ? 'deterministic' : 'provider',
      node.reused ? 'reused' : undefined,
      node.failureCode,
      lastLog,
    ]
      .filter((part): part is string => part !== undefined && part.length > 0)
      .join(' · '),
    state: node.state,
    links,
  };
}

function nodeMatchesSection(
  node: ProductionRunNodeProjectionV1,
  section: 'scenes' | 'assets' | 'jobs' | 'qa',
): boolean {
  const haystack = `${node.nodeId} ${node.type} ${node.category}`.toLowerCase();
  switch (section) {
    case 'scenes':
      return /(scene|candidate|script|prompt|storyboard)/.test(haystack);
    case 'assets':
      return /(asset|b-roll|broll|media|thumbnail|image|video|audio)/.test(haystack);
    case 'jobs':
      return /(job|provider|generate|synthesis|cost|runway|comfy|openrouter|lm-studio|higgsfield)/.test(
        haystack,
      );
    case 'qa':
      return /(qa|quality|delivery|render|inspect|export|preflight|report)/.test(haystack);
  }
}

function linksForRun(
  record: ProductionRunRecordV1,
  input: BuildProductionBoardModelInput,
): readonly ProductionBoardLink[] {
  return [
    ...(record.links.jobId === undefined
      ? []
      : [link('job', record.links.jobId, `Job ${record.links.jobId}`)]),
    ...(record.links.providerRunId === undefined
      ? []
      : [link('provider', record.links.providerRunId, `Provider ${record.links.providerRunId}`)]),
    ...(record.links.reportId === undefined
      ? []
      : [link('report', record.links.reportId, `Report ${record.links.reportId}`)]),
    ...(record.links.artifactIds ?? []).flatMap((artifactId) => artifactLinks(artifactId, input)),
  ];
}

function artifactLinks(
  artifactId: string,
  input: Pick<BuildProductionBoardModelInput, 'artifacts' | 'dataLanes' | 'assets'>,
): readonly ProductionBoardLink[] {
  const artifact = input.artifacts.artifacts[artifactId];
  const lane = input.dataLanes
    .flatMap((candidate) => candidate.items.map((item) => ({ lane: candidate, item })))
    .find((candidate) => candidate.item.artifactId === artifactId);
  const assetId =
    artifact?.contentRef.type === 'asset'
      ? artifact.contentRef.assetId
      : input.assets?.some((asset) => asset.id === artifactId)
        ? artifactId
        : undefined;
  return [
    ...(assetId === undefined
      ? []
      : [link('asset', assetId, `Asset ${assetLabel(assetId, input.assets)}`)]),
    ...(artifact === undefined
      ? []
      : [link('artifact', artifact.id, `Artifact ${artifact.label}`)]),
    ...(lane === undefined ? [] : [link('data-lane', lane.item.id, `${lane.lane.label} lane`)]),
  ];
}

function link(kind: ProductionBoardLink['kind'], id: string, label: string): ProductionBoardLink {
  return { kind, id, label, href: `#${kind}:${encodeURIComponent(id)}` };
}

function assetLabel(assetId: string, assets: readonly BrowserAsset[] | undefined): string {
  return assets?.find((asset) => asset.id === assetId)?.displayName ?? assetId;
}

function actionAvailability(
  record: ProductionRunRecordV1,
  staleRevisionConflict: boolean,
  pendingApprovals: readonly ProductionApprovalV1[],
): ProductionBoardActionAvailability {
  const disabledReason = staleRevisionConflict
    ? 'Project revision changed since this run parked.'
    : undefined;
  return {
    canApprove: pendingApprovals.length > 0 && !staleRevisionConflict,
    canReject: pendingApprovals.length > 0 && !staleRevisionConflict,
    canRetry: (record.state === 'failed' || record.state === 'canceled') && !staleRevisionConflict,
    canCancel: !isTerminal(record.state) && !staleRevisionConflict,
    ...(disabledReason === undefined ? {} : { disabledReason }),
  };
}

function authorityBadge(record: ProductionRunRecordV1): string {
  const actor = record.events.find((event) => event.actor !== undefined)?.actor;
  if (actor === undefined) return 'unknown authority';
  return authorityLabel(actor);
}

function authorityLabel(authority: ProductionRunAuthority): string {
  return `${authority.displayName ?? authority.principalId} · ${authority.role}`;
}

function summarizeValue(value: unknown): string {
  if (value === null || typeof value !== 'object') return String(value);
  if (Array.isArray(value)) return `${String(value.length)} inputs`;
  const keys = Object.keys(value);
  if (keys.length === 0) return 'empty input';
  return keys.slice(0, 4).join(', ') + (keys.length > 4 ? ` +${String(keys.length - 4)}` : '');
}

function isTerminal(state: ProductionRunStateV1): boolean {
  return state === 'canceled' || state === 'failed' || state === 'succeeded';
}
