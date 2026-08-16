export type PreviewResourceKind =
  'primary-decoder' | 'partner-decoder' | 'audio-context' | 'pixi-renderer' | 'gpu-frame-url';

export interface PreviewResourceAuditSnapshot {
  readonly created: Readonly<Record<PreviewResourceKind, number>>;
  readonly released: Readonly<Record<PreviewResourceKind, number>>;
  readonly active: Readonly<Record<PreviewResourceKind, number>>;
}

interface MutableAudit {
  readonly created: Record<PreviewResourceKind, number>;
  readonly released: Record<PreviewResourceKind, number>;
  readonly activeTokens: Map<PreviewResourceKind, Set<string>>;
}

declare global {
  interface Window {
    /** QA-only counters; no project data, asset URL, or credential is exposed. */
    __JOY_MEDIA_RESOURCE_AUDIT__?: PreviewResourceAuditSnapshot;
  }
}

const KINDS: readonly PreviewResourceKind[] = [
  'primary-decoder',
  'partner-decoder',
  'audio-context',
  'pixi-renderer',
  'gpu-frame-url',
];

const audit: MutableAudit = {
  created: emptyCounts(),
  released: emptyCounts(),
  activeTokens: new Map(KINDS.map((kind) => [kind, new Set()])),
};

export function recordPreviewResourceCreated(kind: PreviewResourceKind, token: string): void {
  const active = audit.activeTokens.get(kind)!;
  if (active.has(token)) return;
  active.add(token);
  audit.created[kind] += 1;
  publish();
}

export function recordPreviewResourceReleased(kind: PreviewResourceKind, token: string): void {
  const active = audit.activeTokens.get(kind)!;
  if (!active.delete(token)) return;
  audit.released[kind] += 1;
  publish();
}

export function previewResourceAuditSnapshot(): PreviewResourceAuditSnapshot {
  return {
    created: { ...audit.created },
    released: { ...audit.released },
    active: Object.fromEntries(
      KINDS.map((kind) => [kind, audit.activeTokens.get(kind)!.size]),
    ) as Record<PreviewResourceKind, number>,
  };
}

function publish(): void {
  if (typeof window !== 'undefined')
    window.__JOY_MEDIA_RESOURCE_AUDIT__ = previewResourceAuditSnapshot();
}

function emptyCounts(): Record<PreviewResourceKind, number> {
  return Object.fromEntries(KINDS.map((kind) => [kind, 0])) as Record<PreviewResourceKind, number>;
}

publish();
