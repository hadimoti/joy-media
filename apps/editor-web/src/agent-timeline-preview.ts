export interface AgentPreviewClip {
  readonly id: string;
  readonly trackId: string;
  readonly startUs: number;
  readonly durationUs: number;
  readonly effectIds?: readonly string[];
  readonly properties?: Readonly<Record<string, number | string | boolean>>;
}
export interface AgentPreviewTimeline {
  readonly clips: readonly AgentPreviewClip[];
}

/** Convert the canonical JOY timeline into the small, render-safe preview shape. */
export function previewTimelineFromProject(project: {
  readonly rootCompositionId: string;
  readonly compositions: Readonly<
    Record<
      string,
      {
        readonly tracks: readonly {
          readonly id: string;
          readonly clips: readonly {
            readonly id: string;
            readonly startUs: number;
            readonly durationUs: number;
          }[];
        }[];
      }
    >
  >;
}): AgentPreviewTimeline {
  const composition = project.compositions[project.rootCompositionId];
  return {
    clips:
      composition?.tracks.flatMap((track) =>
        track.clips.map((clip) => ({
          id: clip.id,
          trackId: track.id,
          startUs: clip.startUs,
          durationUs: clip.durationUs,
        })),
      ) ?? [],
  };
}

export type AgentTimelineDiff =
  | { readonly kind: 'add'; readonly clip: AgentPreviewClip }
  | { readonly kind: 'remove'; readonly clip: AgentPreviewClip }
  | {
      readonly kind: 'move';
      readonly clipId: string;
      readonly from: AgentPreviewClip;
      readonly to: AgentPreviewClip;
    }
  | {
      readonly kind: 'trim';
      readonly clipId: string;
      readonly from: AgentPreviewClip;
      readonly to: AgentPreviewClip;
    }
  | {
      readonly kind: 'effect';
      readonly clipId: string;
      readonly from: readonly string[];
      readonly to: readonly string[];
    }
  | {
      readonly kind: 'property';
      readonly clipId: string;
      readonly key: string;
      readonly from: number | string | boolean | undefined;
      readonly to: number | string | boolean | undefined;
    };

function equalValue(left: unknown, right: unknown): boolean {
  return Object.is(left, right);
}

/** Pure projection of an uncommitted, revision-bound timeline snapshot. */
export function diffAgentTimeline(
  canonical: AgentPreviewTimeline,
  preview: AgentPreviewTimeline,
): readonly AgentTimelineDiff[] {
  const canonicalById = new Map(canonical.clips.map((clip) => [clip.id, clip]));
  const previewById = new Map(preview.clips.map((clip) => [clip.id, clip]));
  const diffs: AgentTimelineDiff[] = [];
  for (const clip of preview.clips) {
    const before = canonicalById.get(clip.id);
    if (before === undefined) {
      diffs.push({ kind: 'add', clip });
      continue;
    }
    if (before.trackId !== clip.trackId || before.startUs !== clip.startUs) {
      diffs.push({ kind: 'move', clipId: clip.id, from: before, to: clip });
    }
    if (before.durationUs !== clip.durationUs) {
      diffs.push({ kind: 'trim', clipId: clip.id, from: before, to: clip });
    }
    const beforeEffects = before.effectIds ?? [];
    const afterEffects = clip.effectIds ?? [];
    if (JSON.stringify(beforeEffects) !== JSON.stringify(afterEffects)) {
      diffs.push({ kind: 'effect', clipId: clip.id, from: beforeEffects, to: afterEffects });
    }
    const keys = new Set([
      ...Object.keys(before.properties ?? {}),
      ...Object.keys(clip.properties ?? {}),
    ]);
    for (const key of keys) {
      const from = before.properties?.[key];
      const to = clip.properties?.[key];
      if (!equalValue(from, to)) diffs.push({ kind: 'property', clipId: clip.id, key, from, to });
    }
  }
  for (const clip of canonical.clips) {
    if (!previewById.has(clip.id)) diffs.push({ kind: 'remove', clip });
  }
  return diffs;
}

export function diffSummary(diff: AgentTimelineDiff): string {
  switch (diff.kind) {
    case 'add':
      return `Add ${diff.clip.id}`;
    case 'remove':
      return `Remove ${diff.clip.id}`;
    case 'move':
      return `Move ${diff.clipId} to ${diff.to.startUs / 1_000_000}s`;
    case 'trim':
      return `Trim ${diff.clipId} to ${diff.to.durationUs / 1_000_000}s`;
    case 'effect':
      return `Change effects on ${diff.clipId}`;
    case 'property':
      return `Change ${diff.key} on ${diff.clipId}`;
  }
}
