# ADR-0012 — Collaboration conflict model

**Status:** Accepted
**Date:** 2026-07-20

## Context

P09 may add team review and project versions, but ADR-0011 prohibits real-time collaboration without an explicit conflict model. Creative projects are structured documents where a silent last-writer-wins merge could discard editorial work.

## Decision

JOY collaboration is revision-led and asynchronous by default.

1. Every accepted change is an immutable revision with a project, actor, parent revision, and snapshot reference.
2. A proposal can be accepted only when its base revision is the current project head (a fast-forward). A stale proposal is marked conflicted; it is never auto-merged or overwritten.
3. A contributor resolves a conflict by comparing the retained proposal with the current head, then creating a new revision or a separate project branch.
4. Proxy review is annotation/approval over a specific project version and proxy timecode, not a mutation of project content.
5. If a narrow real-time surface is approved later, it uses a single-writer lease per project scope. Other editors are read-only for that scope and can create asynchronous proposals; the lease holder's changes still become ordinary ordered revisions. CRDTs and last-writer-wins are not introduced by this ADR.

## Consequences

Revision history is complete and conflicts are visible, at the cost of an explicit rebase/review step for concurrent edits. No network transport, presence system, or shared cursor is authorized or implemented by this decision. Any future real-time transport must preserve these semantics and document its lease lifecycle, outage behavior, and audit evidence.
