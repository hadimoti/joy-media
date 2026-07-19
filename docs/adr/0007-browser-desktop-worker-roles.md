# ADR-0007: Browser, desktop bridge, and Worker have separate local-media roles

Status: Accepted
Date: 2026-07-19

## Context

Browser permission and storage models cannot safely represent arbitrary multi-gigabyte local-media workflows. At the same time, the editor and VPS must not become a backdoor for unrestricted local filesystem access (§6.1, §13.1, §26.10). WP-00.6 proves the smallest boundary needed for local-first ingest.

## Decision

1. The browser/editor requests a user-approved selection or references a browser handle; it does not receive a raw desktop path and does not become the source of truth for local file permissions.
2. The desktop bridge owns permission-scoped native selection and maps an approved path to an opaque local-location token. It exposes only narrow operations: register selection, request thumbnail/proxy, stream an approved derivative, and reveal/open after user approval.
3. The Worker owns local probing, hashing, derivative generation, and resolution of opaque local-location tokens. It receives no project mutation authority.
4. The VPS/control plane coordinates asset metadata and jobs but does not proxy original bytes by default. It may receive metadata, display names, opaque references, and explicitly approved derivatives only.
5. P00.6 is a local bridge contract proof. A native desktop shell, browser File System Access integration, permission revocation, and authenticated bridge transport are deferred to P01/P02/X01.

## Alternatives considered

- **Upload originals to the VPS before proxying** — rejected: unnecessary bandwidth/cost/privacy exposure and violates the local-first model.
- **Give the browser unrestricted path access** — rejected: unsupported and unsafe across browser permission models.
- **Let the Worker mutate project documents directly** — rejected: project changes must remain validated commands.

## Consequences

- Desktop-only launch remains viable when browser limitations would compromise the local-media workflow.
- Bridge APIs must remain allowlisted; they must never become arbitrary read/write/execute endpoints.
- Later browser mode can use handles/OPFS, while desktop and Worker retain the same opaque-location protocol.

## Validation and rollback

`packages/media-core/src/assets.test.ts` proves that physical paths are confined to the trusted bridge's derivative execution seam and absent from public records. A bridge operation that needs a broader authority requires a new reviewed API and an ADR update.

## Related contracts/tests

`packages/media-core/src/assets.ts` · master plan §6.1, §13.1, §26.10 · WP-00.6.
