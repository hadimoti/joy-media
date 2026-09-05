# Joy Code Project Conversation Design

## Decision

JOY Studio treats Joy Code as one continuous, project-scoped creative
conversation. It is not an IDE task launcher. The Joy Code dock panel has no
History, Composer, or 3D tabs and no prominent New task action.

The existing project History dock panel remains the undo/restore surface.
Jobs remains the long-running execution surface. Agent proposals, approvals,
and safe run outcomes remain in the Joy Code conversation that produced them.

## Joy Code surface

The panel always renders the existing conversation UI:

```text
Create with JOY  [Edit] [Creative Brief]

project conversation, proposals, approvals, and outcomes

[attach] [message] [send]
```

Creative Brief remains an explicit Joy Code skill. A generated brief is an
attached, revision-bound artifact in the conversation; it is not a panel or a
separate conversation mode.

The current History and Composer controls are removed. Today they switch
between a per-project list of task threads and its active thread, while the
header plus creates a second task thread. That model is replaced by one
conversation per project.

## Conversation data and migration

Conversation data stays browser-local and project-keyed. It is not written to
the JOY server, provider configuration, project document, autosync payload,
or project export.

The storage format becomes a versioned project conversation record containing
one message sequence. On first load, a legacy thread list is read safely:

1. The latest legacy thread becomes the active conversation.
2. Its messages preserve their existing order and timestamps.
3. Earlier legacy threads remain in the old local-storage record for recovery;
   the cleanup release does not delete or overwrite them.
4. A malformed or unavailable record produces an empty in-memory conversation
   without blocking editing.

This deliberately avoids silently concatenating unrelated prior tasks while
preserving all legacy data. A future explicit archive viewer can be designed
only if real usage requires it.

## 3D workspace

The existing 3D viewer is a creative workspace, not an agent mode. It moves
from `AgentPanel` into a dedicated `scene3d` Dockview panel called **3D Scene**.
The vertical default layout puts it directly after Inspector:

```text
Inspector | 3D Scene | Animate | Audio | Jobs
```

The panel owns the existing viewer and Add to timeline callback. Joy Code and
the shared JOY Agent Engine can still request a 3D task, but safe activity
routing targets `scene3d` rather than the Joy Code panel. Follow remains
off by default and never steals focus.

## Compatibility and accessibility

Saved Dockview layouts migrate by adding the new panel without discarding the
user layout. New layouts seed 3D Scene next to Inspector. Existing `agent`
activity targets are updated atomically with the panel registration so no
runtime route points to the removed nested 3D tab.

The cleaned Joy Code panel has no redundant `tablist`; Edit and Creative Brief
remain accessible pressed controls in the composer toolbar. The dock tab,
panel title, overflow menu, keyboard navigation, and live activity semantics
continue to expose clear labels.

## Non-goals

- No change to the JOY Agent Engine, BYOK provider handling, approvals, or
  preview/atomic-apply boundary.
- No server persistence, sync, or export of conversation contents.
- No destructive migration of older Joy Code threads.
- No new agent execution path or fallback.

## Acceptance criteria

1. Joy Code has one project conversation and no History, Composer, 3D, or
   New task header control.
2. Project switching and reload isolate conversations by project ID.
3. Legacy task records survive migration unchanged and the latest thread is
   available as the conversation.
4. Creative Brief remains usable from the single conversation surface.
5. 3D Scene is a standalone dock panel beside Inspector in a fresh layout.
6. Saved layouts add 3D Scene without losing their existing panel arrangement.
7. Agent 3D tool/task activity targets 3D Scene; other agent activity still
   targets its product-owned surface.
8. Focused unit tests, typecheck, production editor build, and browser visual
   checks pass.
