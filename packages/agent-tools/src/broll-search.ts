import type {
  SemanticBrollAssetV1,
  SemanticBrollSearchIndexV1,
  SemanticBrollTimeRangeV1,
} from '@joy-media/project-schema';
import { validateSemanticBrollSearchIndexV1 } from '@joy-media/project-schema';
import type { AgentEditPlan } from './plan.js';
import { createPlan } from './plan.js';

export interface BrollSearchRequest {
  readonly query: string;
  readonly maxResults?: number;
  readonly assetTypes?: readonly SemanticBrollAssetV1['assetType'][];
  readonly timeRange?: {
    readonly startUs: number;
    readonly endUs: number;
  };
  readonly unusedOnly?: boolean;
  readonly rerank?: {
    readonly enabled: boolean;
    readonly privacyApproved: boolean;
    readonly providerId?: string;
  };
}

export interface BrollSearchResult {
  readonly resultId: string;
  readonly assetId: string;
  readonly displayName: string;
  readonly assetType: SemanticBrollAssetV1['assetType'];
  readonly usedInTimeline: boolean;
  readonly range: {
    readonly startUs: number;
    readonly durationUs: number;
  };
  readonly evidenceIds: readonly string[];
  readonly score: number;
  readonly explanations: readonly string[];
}

export interface BrollSearchResponse {
  readonly query: string;
  readonly results: readonly BrollSearchResult[];
  readonly privacy: {
    readonly dataLeavesDevice: boolean;
    readonly providerId?: string;
  };
  readonly warnings: readonly string[];
}

export interface BrollRerankCandidate extends BrollSearchResult {
  readonly baseScore: number;
}

export interface BrollRerankResult {
  readonly resultId: string;
  readonly score: number;
  readonly reason?: string;
}

export interface BrollSearchServices {
  readonly reranker?: (input: {
    readonly query: string;
    readonly candidates: readonly BrollRerankCandidate[];
  }) => readonly BrollRerankResult[];
}

export interface BrollInsertionProposalOptions {
  readonly compositionId: string;
  readonly trackId: string;
  readonly insertAtUs: number;
  readonly clipId: string;
  readonly dispatch?: (plan: AgentEditPlan) => void;
}

export class BrollSearchError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'BrollSearchError';
    this.code = code;
  }
}

export function searchBroll(
  index: SemanticBrollSearchIndexV1,
  request: BrollSearchRequest,
  services: BrollSearchServices = {},
): BrollSearchResponse {
  const errors = validateSemanticBrollSearchIndexV1(index);
  if (errors.length > 0) {
    throw new BrollSearchError('BROLL_INDEX_INVALID', errors.join('; '));
  }

  const queryTokens = tokenize(request.query);
  const candidates = index.assets
    .filter((asset) => assetMatchesRequest(asset, request))
    .flatMap((asset) =>
      asset.ranges
        .filter((range) => rangeMatchesRequest(range, request))
        .map((range) => scoreRange(index, asset, range, queryTokens))
        .filter((result) => result.score > 0 || queryTokens.length === 0),
    )
    .sort(compareBaseResults);

  const maxResults = Math.max(1, Math.min(100, request.maxResults ?? 10));
  const warnings: string[] = [];
  const rerankRequested = request.rerank?.enabled === true;
  const rerankAllowed = rerankRequested && request.rerank?.privacyApproved === true;
  const canRerank = rerankAllowed && services.reranker !== undefined;

  let results: readonly BrollSearchResult[] = candidates;
  if (rerankRequested && !rerankAllowed) {
    warnings.push('Rerank skipped because privacy approval was not granted.');
  } else if (canRerank) {
    const reranked = services.reranker({
      query: request.query,
      candidates: candidates.map((candidate) => ({ ...candidate, baseScore: candidate.score })),
    });
    results = applyRerank(candidates, reranked);
  }

  return {
    query: request.query,
    results: results.slice(0, maxResults),
    privacy: {
      dataLeavesDevice: canRerank,
      ...(canRerank && request.rerank?.providerId !== undefined
        ? { providerId: request.rerank.providerId }
        : {}),
    },
    warnings,
  };
}

export function createBrollInsertionProposal(
  result: BrollSearchResult,
  options: BrollInsertionProposalOptions,
): AgentEditPlan {
  void options.dispatch;
  return createPlan(
    `Insert B-roll from ${result.displayName}`,
    [
      {
        id: 'insert-broll-1',
        description: `Insert evidence-linked B-roll range ${result.range.startUs}-${result.range.startUs + result.range.durationUs}us from ${result.displayName}`,
        mode: 'command',
        tool: 'insertClip',
        arguments: {
          compositionId: options.compositionId,
          trackId: options.trackId,
          clip: {
            id: options.clipId,
            kind: 'video',
            assetId: result.assetId,
            startUs: options.insertAtUs,
            durationUs: result.range.durationUs,
            sourceStartUs: result.range.startUs,
            metadata: {
              dryRunOnly: true,
              evidenceIds: [...result.evidenceIds],
              brollSearchResultId: result.resultId,
            },
          },
        },
        dependsOn: [],
        expectedChange: `Would insert ${result.displayName} as B-roll after approval.`,
        preconditions: [
          {
            type: 'track-exists',
            entityId: options.trackId,
            message: `Track ${options.trackId} must exist`,
          },
          {
            type: 'time-range-valid',
            message: 'Insertion time range must be valid',
          },
        ],
        requiresConfirmation: true,
      },
    ],
    {
      status: 'pending-approval',
      requiredApprovals: [
        {
          id: 'approval-insert-broll-1',
          stepId: 'insert-broll-1',
          reason: 'project-edit',
          description: 'Insert B-roll clip into the timeline.',
          privacyImpact: { dataLeavesDevice: false, dataTypes: [] },
          isReversible: true,
          status: 'pending',
        },
      ],
    },
  );
}

function scoreRange(
  index: SemanticBrollSearchIndexV1,
  asset: SemanticBrollAssetV1,
  range: SemanticBrollTimeRangeV1,
  queryTokens: readonly string[],
): BrollSearchResult {
  if (range.evidenceIds.length === 0) {
    throw new BrollSearchError(
      'BROLL_RESULT_MISSING_EVIDENCE',
      `range ${range.rangeId} has no evidence`,
    );
  }
  for (const evidenceId of range.evidenceIds) {
    if (!index.evidenceIndex.has(evidenceId)) {
      throw new BrollSearchError(
        'BROLL_RESULT_MISSING_EVIDENCE',
        `range ${range.rangeId} cites missing evidence ${evidenceId}`,
      );
    }
  }

  const searchableText = [
    asset.displayName,
    asset.tags?.join(' ') ?? '',
    range.label,
    range.text,
    ...range.evidenceIds.map((evidenceId) => {
      const evidence = index.evidenceIndex.get(evidenceId);
      return `${evidence?.label ?? ''} ${evidence?.summary ?? ''}`;
    }),
  ]
    .join(' ')
    .toLowerCase();
  const matches = queryTokens.filter((token) => searchableText.includes(token));
  const unusedBoost = asset.usedInTimeline ? 0 : 2;
  const evidenceBoost = Math.min(2, range.evidenceIds.length * 0.25);
  const score = matches.length * 3 + unusedBoost + evidenceBoost;
  const explanations = [
    `Base score ${score.toFixed(2)} from ${matches.length} query match(es) and ${range.evidenceIds.length} evidence link(s).`,
    asset.usedInTimeline
      ? 'Asset is already used in the timeline.'
      : 'Asset is unused in the timeline, so it is ranked ahead of otherwise similar clips.',
  ];

  return {
    resultId: `${asset.assetId}:${range.rangeId}`,
    assetId: asset.assetId,
    displayName: asset.displayName,
    assetType: asset.assetType,
    usedInTimeline: asset.usedInTimeline,
    range: {
      startUs: range.startUs,
      durationUs: range.durationUs,
    },
    evidenceIds: [...range.evidenceIds],
    score,
    explanations,
  };
}

function applyRerank(
  candidates: readonly BrollSearchResult[],
  reranked: readonly BrollRerankResult[],
): readonly BrollSearchResult[] {
  const byId = new Map(candidates.map((candidate) => [candidate.resultId, candidate]));
  const consumed = new Set<string>();
  const output: BrollSearchResult[] = [];
  for (const item of [...reranked].sort(
    (left, right) => right.score - left.score || left.resultId.localeCompare(right.resultId),
  )) {
    const candidate = byId.get(item.resultId);
    if (candidate === undefined) continue;
    consumed.add(candidate.resultId);
    output.push({
      ...candidate,
      score: item.score,
      explanations: [
        ...candidate.explanations,
        `Reranked score ${item.score.toFixed(2)}${item.reason === undefined ? '' : `: ${item.reason}`}.`,
      ],
    });
  }
  output.push(...candidates.filter((candidate) => !consumed.has(candidate.resultId)));
  return output;
}

function assetMatchesRequest(asset: SemanticBrollAssetV1, request: BrollSearchRequest): boolean {
  if (request.unusedOnly === true && asset.usedInTimeline) return false;
  if (request.assetTypes !== undefined && !request.assetTypes.includes(asset.assetType)) {
    return false;
  }
  return true;
}

function rangeMatchesRequest(
  range: SemanticBrollTimeRangeV1,
  request: BrollSearchRequest,
): boolean {
  if (request.timeRange === undefined) return true;
  const rangeEndUs = range.startUs + range.durationUs;
  return range.startUs < request.timeRange.endUs && request.timeRange.startUs < rangeEndUs;
}

function compareBaseResults(left: BrollSearchResult, right: BrollSearchResult): number {
  if (left.usedInTimeline !== right.usedInTimeline) return left.usedInTimeline ? 1 : -1;
  return (
    right.score - left.score ||
    left.assetId.localeCompare(right.assetId) ||
    left.range.startUs - right.range.startUs
  );
}

function tokenize(query: string): readonly string[] {
  return [...new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? [])].filter(
    (token) => token.length > 1,
  );
}
