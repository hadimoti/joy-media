# Workflow approval recovery

Bundled workflows may pause for human input. The editor saves these checkpoints
under `joy-media.workflow-runs.v2` in this browser, including project identity,
canonical revision, exact bundled workflow definition and pending request.
Reload does not approve or execute anything. The Workflows panel restores and
lists only the current project's pending runs; review and Continue are explicit.
Dismiss hides the dialog, while Discard removes the saved run without running
further nodes. Multiple approvals remain discoverable in the pending list.

Resume rejects a different project or changed revision. Restored records must
match the currently bundled definition/version, checkpoint identity, node
states and pending request. Invalid or oversized data is ignored so it cannot
prevent the editor opening. Storage is bounded to 64 parked runs and 2 MiB.
Earlier unbound v1 records are not resumed or deleted automatically: start a
new run because their project/revision cannot be established reliably.

When browser storage is unavailable/full, the current approval remains usable
in memory and the UI warns that reload recovery is unavailable. Browser-local
storage is not a cross-device backup or a transactional job ledger. Clearing
site data removes recovery records. Concurrent-tab workflow writes and storage
failure during later checkpoint/removal are not a guarantee of exactly-once
remote effects; real provider/job execution needs its durable job ledger and
idempotency contract before replacing experimental handlers.

Tests simulate module reload at both long-video draft-reel approvals, verify
completed deterministic nodes are reused, require a fresh user response at the
next approval, remove completed runs, and reject stale, foreign or malformed
recovery data. They use fixture handlers and no model/provider calls. Bundled
recipes remain experimental and may return deferred/fixture-backed outputs.
Real media delivery, cross-device workflow continuation, and an authenticated
browser reload journey are separate acceptance work.
