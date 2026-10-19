# JOY Media Windows baseline — 2026-10-17

This is a fresh baseline on the isolated `codex/joy-media-readiness` worktree at source base `c1fffd59d5078902e031e7684e69c27df40ce607`. It is diagnostic evidence, not app-ready or release-ready certification.

## Machine and candidate identity

| Item                     | Observed                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| Source base SHA          | `c1fffd59d5078902e031e7684e69c27df40ce607`                                                 |
| `pnpm-lock.yaml` SHA-256 | `40f9c7a6cd77056f0faf03543ebac68c7413b8eb99ed82d2bd4b6c3b9ab33968`                         |
| Node                     | `v24.19.0`                                                                                 |
| Initial pnpm             | `11.25.0`                                                                                  |
| Repository-pinned pnpm   | `11.15.0` (`packageManager: pnpm@11.15.0`)                                                 |
| FFmpeg / FFprobe         | `8.1.1-full_build-www.gyan.dev`                                                            |
| Install                  | `pnpm install --offline --frozen-lockfile` succeeded; 367 packages linked, zero downloaded |

Corepack is not installed in this environment. The pinned pnpm package was available from the local package cache via `pnpm dlx pnpm@11.15.0`; its binary reported version `11.15.0`.

## Fresh command results

| Command                                                                  | Result                                                                                                                                                                                                                                                                    | Evidence                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `pnpm verify:ci`                                                         | Initial unmodified source baseline, using global pnpm 11.25.0: exit 0. TypeScript, ESLint, Prettier, Vitest, builds, and production dependency audit passed. Vitest: 617 files passed, 1 skipped; 5,426 tests passed, 24 skipped.                                         | Raw output retained in the ignored SDD workspace.  |
| `pnpm dlx pnpm@11.15.0 verify:ci`                                        | Pinned follow-up on the same source base with the Task 1A readiness validator and evidence files present: exit 0. Vitest: 618 files passed, 1 skipped; 5,471 tests passed, 24 skipped. TypeScript, ESLint, Prettier, workspace builds, and production audit also passed.  | Raw output retained in the ignored SDD workspace.  |
| `pnpm dlx pnpm@11.15.0 verify:ci`                                        | Final Task 1 run after source-bound writer revalidation: exit 0. Vitest: 618 files passed, 1 skipped; 5,485 tests passed, 24 skipped. TypeScript, ESLint, Prettier, all workspace builds, and production dependency audit passed; no known vulnerabilities were reported. | Raw output retained in the ignored SDD workspace.  |
| `pnpm dlx pnpm@11.15.0 exec vitest run tooling/release/src`              | Exit 0. 9 files passed; 210 tests passed, including candidate binding, required source-bound evidence, missing/invalid records, workspace lock/fixture hashes, installer hashes, unsafe paths, and writer revalidation.                                                   | Raw output retained in the ignored SDD workspace.  |
| `pnpm dlx pnpm@11.15.0 test:harness`                                     | Exit 0. 20 passed, 0 failed, 11 skipped.                                                                                                                                                                                                                                  | Raw output retained in the ignored SDD workspace.  |
| `pnpm dlx pnpm@11.15.0 exec playwright test --list`                      | Exit 0. Listed 833 tests in 33 files; this enumerates tests and runs none.                                                                                                                                                                                                | Raw output retained in the ignored SDD workspace.  |
| `apps/cli/src/humanized/render-real.e2e.test.ts` within full Vitest      | 9 passed, 1 Windows cancellation case skipped. It exercises real FFmpeg/FFprobe output through the `bin` entry.                                                                                                                                                           | Full Vitest output; test source in the named file. |
| `apps/cli/src/humanized/render-benchmark.e2e.test.ts` within full Vitest | 63 passed, 1 Windows cancellation case skipped.                                                                                                                                                                                                                           | Full Vitest output; test source in the named file. |

The real-render tests provide fresh Windows evidence that the CLI can encode and inspect playable media through `bin`. They do not establish the `bundle` or installed `joy.cmd` entrypoints, editor parity, safe failure recovery, or a packaged desktop journey.

## Skips and remaining acceptance work

All 24 Vitest skips are accounted for below. Windows-excluded process, ACL, worker-layout, and cancellation checks remain acceptance gaps until equivalent Windows cases pass. Optional speech/model checks remain unqualified; advertised features need real local acceptance or an explicit status/limitation.

| Tests                                                 |  Count | Observed reason                                                     | Closeout treatment                                                                        |
| ----------------------------------------------------- | -----: | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `apps/worker/src/runtime.test.ts`                     |      1 | Licensed RNNoise model file not provisioned                         | Qualify when model is available or mark the capability unavailable.                       |
| `apps/api/src/whisper-transcribe.test.ts`             |      1 | Whisper runtime/model unavailable                                   | Qualify or mark unavailable.                                                              |
| `apps/api/src/speech-synthesize.test.ts`              |      1 | `edge-tts` runtime unavailable                                      | Qualify or mark unavailable.                                                              |
| `apps/cli/src/humanized/agent-secrets.e2e.test.ts`    |      2 | POSIX mode-bit checks skipped on Windows                            | Add Windows ACL checks for synthetic credentials.                                         |
| `apps/cli/src/humanized/agent-resilience.e2e.test.ts` |      2 | POSIX SIGINT/SIGTERM exit semantics skipped on Windows              | Add Windows termination/child-cleanup equivalents.                                        |
| `apps/cli/src/humanized/render-real.e2e.test.ts`      |      1 | POSIX Ctrl-C during real encode skipped on Windows                  | Add a Windows cancellation/partial-output test.                                           |
| `apps/cli/src/humanized/doctor-worker.e2e.test.ts`    |      8 | POSIX shell, venv layout, and fake-worker cases excluded on Windows | Replace applicable cases with Windows-native fake executables, paths, and process checks. |
| `apps/cli/src/humanized/render-benchmark.e2e.test.ts` |      1 | POSIX Ctrl-C render case skipped on Windows                         | Add a Windows cancellation equivalent.                                                    |
| `apps/cli/src/humanized/cli-contract.e2e.test.ts`     |      7 | POSIX signal exit-code cases skipped on Windows                     | Assert Windows termination policy through the shipped Windows entrypoints.                |
| **Vitest total**                                      | **24** |                                                                     |                                                                                           |

The 11 `test:harness` skips are 5 Bash/Perl evidence-retention tests unavailable on this Windows harness path and 6 POSIX process-group termination tests. They do not prove the corresponding Windows runner behavior; task 7 must add/enable Windows equivalents.

## Decision

The full verification passes on Windows with both the globally available and repository-pinned pnpm versions. The latest pinned run includes the current Task 1 implementation and tests, so it is a dirty-worktree engineering result rather than clean exact-candidate release evidence. Required Windows process/ACL cases, optional model-backed features, the desktop-installed workflow, bundled/installed CLI delivery, and the exact-candidate two-pass run remain open. The owner-confirmed `joy-media render` requirement is a playable video and cannot be satisfied by a manifest alone.
