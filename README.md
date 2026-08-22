# JOY Media

Local-first creative operating system for content production — browser/desktop editor, lightweight JOY VPS control plane, local/GPU Workers.

This repository is the prepared _base_: the master plan partitioned into session-runnable parts, the monorepo skeleton with each folder carrying its slice of the plan, and the live-VPS deployment part grounded in measured facts. Implementation is underway per [`STATE.md`](STATE.md).

Toolchain: Node ≥22, pnpm (via corepack). Run `pnpm install` then `pnpm check` (typecheck + lint + format check + tests).

## Start here

| File                                                   | What it is                                                                                                        |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| [`JOY_MEDIA_MASTER_PLAN.md`](JOY_MEDIA_MASTER_PLAN.md) | The architecture contract (v1.1, 50 sections). Read sections on demand, not linearly.                             |
| [`ORCHESTRATION.md`](ORCHESTRATION.md)                 | **The execution front door.** Part map, dependency graph, session protocol.                                       |
| [`STATE.md`](STATE.md)                                 | Progress ledger — which part/WP is active, what's next.                                                           |
| [`DESIGN.md`](DESIGN.md)                               | Editor UI contract (gray Adobe-class chrome, library gate, timeline NLE, **Modam Pro** Eng/Fa/Arabic typography). |
| [`plan/`](plan/)                                       | One file per part (P00–P10 + X01), each with work packages and exit criteria.                                     |
| [`plan/DECISIONS.md`](plan/DECISIONS.md)               | Open product questions (§48) with working defaults and status.                                                    |

**Editor entry (2026-07-24):** `media.joyteam.ir` boots a **Projects library** (open/create), then the Dockview editor with CapCut-style timeline tools. Live tip/deploy state is always in `STATE.md` handoff — do not trust this README for SHA freshness.

## Layout

Mirrors master plan §9. Every folder's `README.md` states its role, the part that first builds it, and its must-not rules. Folders stay empty of code until their part is active in `STATE.md`.

```text
joy-media/
├─ apps/        editor-web · desktop · api · worker · render-host · docs
├─ packages/    project-schema · commands · evaluator · render-ir · renderer-pixi ·
│               renderer-headless · timeline-engine · property-system · media-core ·
│               audio-core · captions-core · motion-core · html-scene-runtime ·
│               provider-sdk · plugin-sdk · agent-tools · workflow-engine ·
│               job-protocol · ui-kit · test-fixtures
├─ plugins/first-party      templates/first-party
├─ tooling/     schema-codegen · golden-render · benchmark · release
├─ docs/        adr · architecture · product · security
└─ plan/        the partitioned work plan (this is what agents execute)
```

## Repo boundary

This is the standalone `joy-media` repository (owner decision Q16, 2026-07-19) — the isolated service/repository boundary master plan §5.3 asks for. It was seeded from `joy-vps` (planning history there up to 2026-07-19); `joy-vps` keeps a pointer and remains the home of VPS operations. Only part X01 of this plan may touch the live VPS.

## 1.0 release gate

Run `pnpm release:gate:test` for the pure evaluator and `pnpm release:gate` for the non-deploying
evidence command. The gate writes machine-readable reports, a manifest, an SBOM, and artifact
hashes under `test-output/release-gate/`; it fails closed when browser, build, test, persistence,
privacy, or authentication evidence is missing. See [`docs/releases/JOY-STUDIO-1.0-CHECKLIST.md`](docs/releases/JOY-STUDIO-1.0-CHECKLIST.md).
