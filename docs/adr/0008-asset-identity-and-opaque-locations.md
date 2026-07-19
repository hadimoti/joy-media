# ADR-0008: Asset identity is separate from physical location

Status: Accepted
Date: 2026-07-19

## Context

A creative project needs durable references even when source media moves between disks, Workers, browsers, or optional storage. Physical paths are private, machine-specific, and unsuitable as project or control-plane identity (§13.1, §13.5). WP-00.6 validates that a selected 8 GiB local asset can be registered and processed locally without sharing its original path or bytes.

## Decision

1. Projects and jobs reference a stable `AssetId`; physical storage is represented separately by typed `AssetLocation` records.
2. A Worker-file location contains only `workerId` and an opaque path token. The mapping from token to absolute path exists solely within the permission-scoped local bridge/Worker.
3. Content hash and byte length identify/validate asset content. The user-visible display name is metadata and may be synchronized; it is not a filesystem location or identity key.
4. Thumbnails and proxies are derivative records with their own opaque locations and source-asset relationship. A local derivative request contains an `AssetId` and profile, not the source bytes or source path.
5. Source changes invalidate derivatives by content hash, not filename or modification date. Advanced relinking/scoring is deferred to P02.

## Alternatives considered

- **Use paths or URLs as asset IDs** — rejected: they break on another machine, leak private layout, and cannot distinguish changed content at the same filename.
- **Use display names as secrecy guarantees** — rejected: display names are intentionally user-visible metadata; only physical paths and bytes are private by default.
- **Copy every original into the browser/VPS** — rejected: impractical for multi-gigabyte sources and incompatible with local-first privacy.

## Consequences

- A project remains portable/relinkable even when current locations are unavailable.
- Public APIs must reject raw path-shaped values in place of opaque location IDs.
- Full media descriptors, hashes from actual bytes, derivative checksums, and relink scoring land in P02.

## Validation and rollback

`packages/media-core/src/assets.test.ts` registers a simulated 8 GiB asset, creates local thumbnail/proxy derivatives, and asserts that control-plane records contain no original path. If a public record exposes a physical path, disable the bridge API and treat it as a security regression.

## Related contracts/tests

`packages/media-core/src/assets.ts` · master plan §13.1–§13.5 · WP-00.6.
