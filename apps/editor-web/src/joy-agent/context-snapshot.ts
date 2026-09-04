export interface JoyAgentContextSnapshot {
  readonly projectId: string;
  readonly revision: string;
  readonly selectedClipIds: readonly string[];
  readonly playheadUs: number;
  readonly clips: readonly {
    readonly id: string;
    readonly trackId: string;
    readonly startUs: number;
    readonly durationUs: number;
  }[];
  readonly assets: readonly {
    readonly id: string;
    readonly kind: string;
    readonly displayName: string;
  }[];
  readonly omitted: readonly string[];
}

/** Build one immutable, byte-bounded model context; never forwards project objects. */
export function createJoyAgentContextSnapshot(input: {
  readonly projectId: string;
  readonly revision: string;
  readonly selectedClipIds?: readonly string[];
  readonly playheadUs?: number;
  readonly clips?: readonly {
    readonly id: string;
    readonly trackId: string;
    readonly startUs: number;
    readonly durationUs: number;
  }[];
  readonly assets?: readonly {
    readonly id: string;
    readonly kind: string;
    readonly displayName: string;
  }[];
}): JoyAgentContextSnapshot {
  const clips = (input.clips ?? []).slice(0, 256).map((clip) => ({
    id: clip.id,
    trackId: clip.trackId,
    startUs: clip.startUs,
    durationUs: clip.durationUs,
  }));
  const assets = (input.assets ?? []).slice(0, 256).map((asset) => ({
    id: asset.id,
    kind: asset.kind,
    displayName: asset.displayName.slice(0, 160),
  }));
  return Object.freeze({
    projectId: input.projectId.slice(0, 128),
    revision: input.revision.slice(0, 256),
    selectedClipIds: Object.freeze((input.selectedClipIds ?? []).slice(0, 64)),
    playheadUs: Number.isFinite(input.playheadUs) ? Math.max(0, input.playheadUs ?? 0) : 0,
    clips: Object.freeze(clips),
    assets: Object.freeze(assets),
    omitted: Object.freeze([
      ...((input.clips?.length ?? 0) > clips.length ? ['clips'] : []),
      ...((input.assets?.length ?? 0) > assets.length ? ['assets'] : []),
    ]),
  });
}
