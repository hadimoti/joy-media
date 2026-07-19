# JOY Media — Progress Ledger

Updated by **every** implementation session (protocol: [`ORCHESTRATION.md`](ORCHESTRATION.md) §2).
One row per part. Keep entries terse; detail lives in the part files' WP checkboxes.

| Part                       | Status      | WPs done | Last session | Next action                                    |
| -------------------------- | ----------- | -------- | ------------ | ---------------------------------------------- |
| P00 architecture proofs    | in-progress | 2/8      | 2026-07-19   | any spike WP; WP-00.3 now unblocked            |
| P01 platform foundation    | not-started | 0/6      | —            | gated on P00 exit criteria                     |
| P02 editing slice          | not-started | 0/6      | —            | gated on P01                                   |
| P03 captions               | not-started | 0/5      | —            | gated on P02                                   |
| P04 motion + HTML scenes   | not-started | 0/5      | —            | gated on P02                                   |
| P05 audio + providers      | not-started | 0/5      | —            | gated on P02 (+provider-sdk min from P03)      |
| P06 agent                  | not-started | 0/5      | —            | gated on P02+P03                               |
| P07 workflows              | not-started | 0/4      | —            | gated on P06 partial                           |
| P08 plugin SDK + templates | not-started | 0/5      | —            | gated on P04–P07 contracts                     |
| P09 marketplace/collab     | not-started | 0/0      | —            | **owner approval required to open**            |
| P10 advanced               | not-started | 0/0      | —            | not scoped                                     |
| X01 VPS control plane      | not-started | 0/4      | —            | activates with P01; skeleton dir exists on VPS |

## Session log (newest first)

| Date       | Part | What happened                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-19 | P00  | **WP-00.1 done (time/evaluation spike).** ADR-0002 accepted: integer-µs time base, BigInt ceil/floor frame mapping with exact NTSC round-trips, end-exclusive ranges, primitives in `project-schema`. Spike model (2 video clips + nested comp + cycle detection) and pure `evaluateFrame` with source-time mapping. 38 tests green via `pnpm check`.                     |
| 2026-07-19 | P00  | **WP-00.0 done.** Standalone `joy-media` repo created (Q16); planning base + master plan moved in from `joy-vps`; owner answered all §48 questions → ADR-0001 + DECISIONS.md updated; pnpm workspace bootstrapped (strict TS project refs, ESLint 9 flat, Prettier, Vitest, GH Actions CI, `pnpm check` green, 7 spike-package scaffolds with passing placeholder tests). |
| 2026-07-19 | —    | Base prepared: master plan debugged to v1.1, orchestration structure created, VPS facts measured, ports 8790/8791 reserved, `/opt/joy-media/` skeleton created on VPS. No product code written.                                                                                                                                                                           |
