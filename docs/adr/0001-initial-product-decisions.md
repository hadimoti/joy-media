# ADR-0001: Initial product decisions (owner round 1)

Status: Accepted
Date: 2026-07-19

## Context

Master plan §48 listed fifteen open product questions; the orchestration added Q16 (repo split). On 2026-07-19 the owner answered all of them in one round. This ADR records the decisions verbatim-in-substance so they cannot drift; the normalized table lives in `plan/DECISIONS.md`.

## Decision

1. **Surfaces (Q1):** browser and desktop are developed together and kept visually and functionally similar. No strong owner preference between them; a desktop-only launch is acceptable if it removes workload from the VPS.
2. **VPS budget (Q2):** JOY Media may use up to **3 GB RAM and 2 CPU cores** on the current VPS. Limits are flexible; after observing real usage the owner decides between upgrading the VPS or staying on the current plan.
3. **Sync (Q3):** projects may optionally sync to the JOY cloud; **local storage is the default**.
4. **Media storage (Q4):** storage is flexible between the local computer and the VPS. Initially heavy files will likely not be uploaded. Everything local by default, with optional cloud storage and synchronization.
5. **Browsers (Q5):** **Chrome is the priority.** Safari and mobile are unnecessary now, but the architecture must allow adding them later.
6. **Export (Q6):** H.264 video + AAC audio in MP4 at 1080p, primarily social-media and short-form content.
7. **Persian (Q7):** Persian subtitles, transcription, and speech must have **excellent, highly accurate** support. The platform interface is **entirely English**.
8. **Models (Q8):** support **OpenRouter** and **local models that can run on Windows**.
9. **Users (Q9):** early projects are single-user.
10. **Identity (Q10):** JOY Media uses the **existing shared JOY login** with its own application page and **no second sign-in**. It is **not enabled for anyone by default**; the owner activates access individually through the admin panel.
11. **Scene authoring (Q11):** no complete built-in HTML Scene code editor. The **Hermes agent** is available alongside the user and can create and edit templates.
12. **Brand kit (Q12):** not food/restaurant-specific. Contains **colors, shadows, effects, fonts, logos, and agent-readable brand descriptions and instructions**.
13. **Individual projects + teachability (Q9/Q15 adjunct):** projects are individual, but the agent can work across every part of the platform, and any process the owner performs once should eventually be teachable or convertible into a reusable agent skill.
14. **Agentic direction (D-AGENT):** over time, all operations should become agentic; the agent should ultimately have complete control over the platform.
15. **Repository (Q16):** JOY Media begins in a new repository named **`joy-media`**.

## Alternatives considered

Recorded per-question in the prior DECISIONS.md defaults (e.g. thumbnails-only VPS retention for Q4, opt-in-at-creation for Q3, standalone auth for Q10). Superseded by the above.

## Consequences

- X01 gains systemd `MemoryMax`/`CPUQuota` limits (3 GB / 200%) and keeps them adjustable.
- P01 auth work (WP-01.5) targets the existing JOY identity boundary + admin-panel per-user activation flag instead of standalone auth.
- P03 treats Persian accuracy as a headline exit bar; UI localization work is dropped from scope (English-only UI labels), while §33.3 string-key discipline is retained for the future. **UI chrome typography** for English labels and Persian/Arabic user content is Fontiran **Modam Pro** (DESIGN.md §4f / D-UI-FONT) — not a localization of chrome copy.
- P04 drops the "integrated scene editor" from any roadmap consideration; adds a Hermes-authoring integration point instead (contract-side only until P06).
- P05 provider lineup: OpenRouter adapter + Windows-local model adapters.
- P06/P07 must deliver a "record → reusable skill" path (D-AGENT) while keeping §22 approval/dry-run/audit/revert gates.
- Capability detection (§4.8) must stay honest so Safari/mobile can be added later despite Chrome-first testing.

## Validation and rollback

Each decision is revisitable via a superseding ADR. Q2 explicitly schedules its own review after real usage data exists.

## Related contracts/tests

`plan/DECISIONS.md` (normalized table) · X01 WP-X1.1 (resource limits) · P03 exit criteria (Persian fixtures) · P06 evaluation suite (approval gates).
