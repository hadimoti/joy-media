# JOY Media CLI — humanized test campaign: handoff

Written 2026-10-14 by the Claude orchestrator session that is stopping because the owner's **Claude usage is nearly exhausted**. The next orchestrator is a **Codex agent** that will fan work out to Codex/`gpt6luna`, the **AGY** CLI, the **Kilo** CLI, and **BytePlus-plan** sub-agents.

> **Hard rule for the next session: do not spawn Claude sub-agents or run Claude-model workers.** The owner's Claude Pro quota was at 85% (session) / 89% (week, resets Saturday 11:30 PM) when this was written. The previous session spent it on four Claude agents when the owner had asked for the external CLIs. That was the orchestrator's mistake; do not repeat it.

## 1. Goal (the owner's words, condensed)

- Make **joy-media fully tested with no bugs**, using **humanized tests** (scenarios the way a person or an AI agent really uses it, not function-level mocks).
- joy-media is **built for AI agents first; humans can use it too**. So the CLI's process-level behaviour — exit codes, stdout/stderr discipline, `--json`, error messages — is the product surface.
- The orchestrator should delegate tests and fixtures to the **allowed external agent CLIs** (Codex, AGY, Grok, Kilo, BytePlus), choosing their models wisely, and keep its own (and Claude's) usage minimal.
- "This is not a small task."

The thing under test is `apps/cli` (`@joy-media/cli`, bin `joy-media` / `joy`; TypeScript, Node >= 22, pnpm 11.15, vitest 3). The earlier attempt at this testing was done by a different bot (grokbot) that hit its usage limit; nothing from it is in the repo.

## 2. Repository / branch / PR state

| Item                      | Value                                                                                                                                                     |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo                      | `hadimoti/joy-media` (private)                                                                                                                            |
| Working branch            | `hadimoti/wonderful-ritchie-vfpgv7` (develop and push **only** here)                                                                                      |
| Base                      | `main` at `e6aa4f7` (v1.0.1 release evidence, 2026-10-02)                                                                                                 |
| Draft PR                  | https://github.com/hadimoti/joy-media/pull/7 (CodeRabbit skips drafts; leave its "Autofix" checkbox **unticked** so it does not push while you integrate) |
| Pushed foundation commits | `7cfabd7` (exit-code fix + harness) and `cac4c5c` (gate test time-bomb fix)                                                                               |

Other local notes: the repo has no PR template. The stop hook complains about untracked `.claude/worktrees/`; add `.claude/worktrees/` to `.git/info/exclude`, never commit it.

## 3. What is DONE (pushed, verified)

1. **P0 fix — every CLI failure exited 0.** `apps/cli/src/bin.ts` waited on an `unref()`'d 50 ms timer; with nothing else holding the event loop, Node exited naturally with status 0 before `process.exit(code)` ran. Unknown command, invalid flag, missing project all "succeeded". Fix: set `process.exitCode` first, flush streams with write callbacks, keep the safety timer ref'd. In-process `runCli()` unit tests could never see this.
2. **Black-box harness** `apps/cli/src/humanized/harness.ts`: runs the real binary (`bin/joy-media.mjs`, or the esbuild bundle via `entry: 'bundle'`) as a child process in an isolated HOME with provider keys scrubbed from the env, auto-builds `dist/` under a cross-process lock when sources are newer. API: `createSandbox()`, `sb.run(args, {entry, env, input, timeoutMs, signal, signalAfterMs, cwd})` -> `{code, signal, out, err, stdout, stderr, all, json(), ndjson(), durationMs}`, plus `describeRun`, `hasAnsi`, `stripAnsi`, `sb.home`, `sb.cwd`, `sb.joyDir`.
3. **Regression tests** `apps/cli/src/humanized/exit-codes.e2e.test.ts` (10 tests, both entry points). Verified: 8/10 fail on the old `bin.ts`, 10/10 pass on the fix.
4. **Release-gate test time bomb**: `tooling/release/src/gate.test.ts` "preserves fixture registrations in test-only source files" evaluated a fixture dated 2026-08-22 at the real clock against a 45-day freshness window, so it went red on 2026-10-06 with no code change. Fixed locally inside that test only (do not change the shared `passingInput()` — two other tests evaluate at a fixed `now` and break if you do; this was learned the hard way). Gate file: 64/64.

Baseline before any change: `npx vitest run` -> 599 files / 5,006 tests passing, 1 failing (the time bomb). `pnpm typecheck` clean. The full suite has **not** been re-run after the foundation commits.

## 4. PARTIAL WORK (not committed, never reviewed or fully verified)

Four Claude agents were stopped mid-work. Their uncommitted work is preserved as patches in `docs/qa/handoff/partial-patches/` (made with `git diff HEAD` against `cac4c5c`; generated files are included as new files). They are **untrusted drafts**: nobody has reviewed them, the agents were interrupted before reporting, and the combined state has known problems (section 5).

| Patch                      | Area                                      | Touches (source)                                                                                                                                        | New tests                                                                                              |
| -------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `D-cli-contract.patch`     | dispatcher, flags, logger, doctor, worker | `bin/joy-media.mjs`, `bin.ts`, `cli.ts`, `process-warnings.ts`, `utils/flags.ts`, `utils/logger.ts`, `commands/doctor-cmd.ts`, `commands/worker-cmd.ts` | `cli-contract`, `doctor-worker`, `doctor-failures`, `cli-helpers`, `flags.test`, `logger.test`         |
| `A-project-timeline.patch` | project + timeline                        | `commands/project-cmd.ts`, `timeline-cmd.ts`, `utils/project-loader.ts`                                                                                 | `project-lifecycle`, `project-robustness`, `timeline-editing`, `project-helpers`                       |
| `B-render-benchmark.patch` | render + benchmark                        | `commands/render-cmd.ts`, `benchmark-cmd.ts` (+ their unit tests)                                                                                       | `render-benchmark.e2e`, `render-helpers`                                                               |
| `C-agent-providers.patch`  | agent + providers + secrets               | `agent/{bridge,joy-agent,output,provider,repl}.ts`, `commands/agent-cmd.ts`, `utils/config.ts`                                                          | `agent-{chat,providers,resilience,run,secrets}.e2e`, `agent-helpers` (a mock OpenAI-compatible server) |

File ownership was disjoint, and all four patches **apply together cleanly** in this order: D, A, B, C (`git apply`). Intended file ownership (keep it if you parallelise again): D owns `cli.ts bin.ts utils/flags.ts utils/logger.ts doctor-cmd worker-cmd bin/ scripts/`; A owns `project-cmd timeline-cmd project-loader`; B owns `render-cmd benchmark-cmd`; C owns `agent-cmd agent/* utils/config.ts`; nobody edits `harness.ts` (additive helpers go in per-area `*-helpers.ts`) or `packages/*`.

## 5. Verification of the combined partial work (measured 2026-10-14)

Applied all four patches to `cac4c5c` in a scratch worktree, then:

- `pnpm install --frozen-lockfile`: OK.
- `eslint apps/cli`: **clean**.
- `pnpm typecheck`: **1 error** — `apps/cli/src/humanized/project-robustness.e2e.test.ts(169,58): TS2345 Promise<RunResult> is not assignable to RunResult` (a missing `await`).
- `prettier --check apps/cli`: **15 files unformatted**; `prettier --write apps/cli` fixes them.
- `vitest run apps/cli/src` as one process: **did not finish in 270 s** (killed). Only `render-benchmark.e2e.test.ts` reported, as "63 tests | 63 skipped" (likely a failing `beforeAll`/setup). The humanized suites spawn the real binary many times; parallel workers plus the build lock may be too slow or something hangs. **This is the first thing to diagnose.**
- Per-file results: see section 5a.

### 5a. Per-file results

**Root cause of the mass failures in the first combined run:** the single TS error above sits in a test file under `src/`, so `tsc -b` fails, the harness's auto-build fails, and every real-binary test fails or retries the build until timeout. The one-line fix is in `project-robustness.e2e.test.ts` line 169: replace `for (const r of [...readers, ...showers]) singleJson(r);` with `for (const r of all.slice(writers.length)) singleJson(r);`. **The patch files in this folder do NOT include that fix** — apply it by hand. Also harden the harness: it should fail fast with the build error and cache the failure instead of rebuilding on every `sb.run`.

Per-file results **after** that one-line fix (each file run alone, 150 s cap, Linux, one machine):

| File                                                              | Result                                                                                       |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `cli.test.ts` (existing)                                          | 11/11 pass                                                                                   |
| `commands/benchmark-cmd.test.ts`, `render-cmd.test.ts` (existing) | 12/12 and 17/17 pass                                                                         |
| `humanized/agent-secrets.e2e`                                     | 9/9 pass                                                                                     |
| `humanized/agent-providers.e2e`                                   | 19 pass, **2 fail**                                                                          |
| `humanized/agent-resilience.e2e`                                  | 4 pass, **1 fail**                                                                           |
| `humanized/agent-run.e2e`                                         | 23 pass, **1 fail**                                                                          |
| `humanized/agent-chat.e2e`                                        | **hangs** (killed at 150 s) — diagnose first; `agent chat` with piped stdin must exit on EOF |

**Not re-measured after the fix (no trustworthy numbers):** `cli-contract.e2e`, `doctor-worker.e2e`, `exit-codes.e2e`, `project-lifecycle.e2e`, `project-robustness.e2e`, `timeline-editing.e2e`, `render-benchmark.e2e`, `flags.test`, `logger.test`. In the earlier broken-build run `doctor-failures.test` passed 2/2, while `cli-contract` and `doctor-worker` timed out at 150 s and `exit-codes` failed 10/10 — all of that is attributable to the build break and should be re-run. The 6 failing agent tests above are real until proven otherwise (they may be unfinished work: the Area C agent was stopped while still editing `agent-cmd.ts`).

## 6. Confirmed findings (reproduced against the real binary) and status

Run with `HOME` pointed at an empty dir and `NODE_NO_WARNINGS` unset, e.g. `node apps/cli/bin/joy-media.mjs <args>` after `pnpm --filter @joy-media/cli build`.

| #   | Sev          | Finding                                                                                                                                                                                                                                                                                              | Evidence / repro                                              | Status                                                                                             |
| --- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | P0           | All failures exit 0                                                                                                                                                                                                                                                                                  | `joy-media frobnicate; echo $?` -> 0                          | **Fixed, pushed** (`7cfabd7`)                                                                      |
| 2   | P1           | Calendar time bomb in release-gate test                                                                                                                                                                                                                                                              | `gate.test.ts` red since 2026-10-06                           | **Fixed, pushed** (`cac4c5c`)                                                                      |
| 3   | P1           | `project create --name "Demo reel"` ignores the name -> "Untitled Project" (hint text says positional `project create "My Project"`)                                                                                                                                                                 | repro above                                                   | patch A (unverified)                                                                               |
| 4   | P1           | `project list --json` prints banner + human table, not JSON; banner/info/warn/success/step all go to **stdout**, so `--json` can never be pure                                                                                                                                                       | `project list --json`                                         | patch A + D (unverified)                                                                           |
| 5   | P1           | `--start 0` rejected: "value must be > 0 (received: 0)" (`NUMERIC_RANGES.start/end/at` lack `allowZero`), so a clip can't start at 0:00; message wording also inconsistent with `-3`                                                                                                                 | `timeline add-clip --asset a.mp4 --start 0 --duration 5`      | patch D (unverified)                                                                               |
| 6   | P1           | `parseArgs` runs with `strict:false`: unknown flags silently accepted; a string flag with a missing value (`--name` last) becomes `true` and is dropped, so `project create --name` silently creates an untitled project                                                                             | `project create --name`                                       | patch D (unverified)                                                                               |
| 7   | P1           | Node `ExperimentalWarning: SQLite is an experimental feature` printed to stderr on essentially every command (AI callers read stderr)                                                                                                                                                                | any command                                                   | patch D (`process-warnings.ts`, unverified)                                                        |
| 8   | P0 (product) | **`render` does not render.** `render-cmd.ts` (~line 355) loops `Math.sin(...)` as a "timing-accurate simulation", writes only `<project>.<ext>.manifest.json`, and reports success. No media file is produced                                                                                       | read the loop                                                 | patch B makes output honest (unverified). Real rendering **not implemented** — see owner questions |
| 9   | P2           | `doctor` prints "All core system diagnostics passed!" with 5 warnings, always hits `https://joyst.ir/ready` (3 s timeout), shells out to `powershell` for GPU on every OS, has no `--json`                                                                                                           | `doctor`                                                      | patch D (unverified)                                                                               |
| 10  | P2           | The existing unit test "supports adding, listing, selecting, and removing providers" in `apps/cli/src/cli.test.ts` hits the **live Kilo gateway** (`https://api.kilo.ai/api/gateway/v1`, prints "Discovered 394 models") — non-hermetic, fails offline                                               | run `npx vitest run apps/cli/src/cli.test.ts` and read stdout | **not assigned to anyone** — fix in the C area                                                     |
| 11  | P2           | Provider keys are stored in `~/.joy-media/ai-providers.json` via `writeFileSync` default mode (likely 0644); `--api-key` on argv leaks via the process list; a corrupt `ai-providers.json` is read as `{}` and then **overwritten** on the next save, silently destroying the user's other providers | code read: `utils/config.ts`, `agent-cmd.ts`                  | patch C (unverified); verify file modes on POSIX                                                   |

## 7. The AI-ready CLI contract the tests assert

Define it in one place and test it everywhere (flag, do not silently bend, anything that looks intentional — check `README.md`, `--help`, existing tests, `git log -S`):

- Exit codes: **0** success; **1** runtime/domain failure (project not found, network); **2** usage/validation error; **130** SIGINT.
- With `--json`: stdout is **exactly one JSON document** (or NDJSON for streaming commands such as `render`); no banner, ANSI, or log lines; human diagnostics go to stderr; errors stay machine-readable.
- No ANSI when stdout/stderr are not TTYs; honour `NO_COLOR`/`FORCE_COLOR`.
- Never block or prompt when stdin is not a TTY.
- A clean run has **empty stderr**.
- A failing command never corrupts or half-mutates state (project DB, config files, render artifacts).
- Tests are hermetic: isolated HOME, no real network, no real API keys (use fake `sk-test-...`), no wall-clock thresholds.

## 8. Open owner questions (need the owner, not an agent)

1. **Should `render` produce real media?** Candidates to wire in: `packages/renderer-headless`, `packages/export-core`, `apps/render-host`, `tooling/golden-render`, ffmpeg (present at `/usr/bin/ffmpeg` in the previous container). Until decided, `render` should say plainly that only a manifest was written.
2. Is `strict:false` in `parseArgs` deliberate (forwarding unknown flags)? Patch D makes unknown flags a usage error — confirm.
3. `doctor` exit-code policy (failures -> 1, warnings -> 0 but not "all passed") and a documented env override for the edge URL (patch D suggests `JOY_MEDIA_EDGE_URL`) — confirm names.
4. Secret storage policy for provider keys (0600 file now, OS keychain later?).
5. When everything is green: mark PR #7 ready for review (it is a draft).

## 9. Environment facts and traps (learned the hard way)

- Node 22.22, pnpm 11.15.0 (`CI=true pnpm install --frozen-lockfile`, ~15 s). The CLI must be built to run the real binary: `pnpm --filter @joy-media/cli build` (`tsc -b` then esbuild bundle). The harness rebuilds automatically when sources are newer than `dist/`.
- Vitest only picks up `{apps,packages,tooling}/**/src/**/*.test.{ts,tsx}`, so black-box tests **must live under `apps/cli/src/`** (that is why they are in `src/humanized/`).
- ESLint ignores `**/src/**/*.js` and `.d.ts`; `eslint apps/cli` and `prettier --check apps/cli` are the fast local gates. Full gate: `pnpm check` = typecheck + lint + format:check + test.
- Do not run the full monorepo vitest while a build is running; once saw `Timeout calling "onTaskUpdate"` under load.
- **Never chain `git commit` after a pipeline that ends in `grep`** (it succeeds even when tests fail). Gate commits on the real exit code.
- Agent-created git worktrees can appear at the wrong base briefly; check `git log -1` in each before trusting it.
- Outbound network in the previous container went through a proxy (`HTTPS_PROXY`, CA at `/root/.ccr/ca-bundle.crt`); the harness passes proxy variables through, but tests must not need the internet.
- The external CLIs (`codex`, `agy`, `grok`, `kilo`, BytePlus) were **not installed and had no credentials** in the previous container. They are on npm (`@openai/codex`, `@kilocode/cli`, `@xai-official/grok`, `@google/gemini-cli` all resolved). Provide keys as **environment variables in the environment settings**, never pasted in chat. This document cannot confirm the model name `gpt6luna` or which AGY/Kilo/BytePlus models the owner's plans include — query each CLI's model list first.
- The CLI itself already has a Kilo provider preset (`https://api.kilo.ai/api/gateway/v1`, models like `minimax/minimax-m3`, `kilo-auto/efficient`) and honours `KILO_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`.
- Commits so far carry Claude `Co-Authored-By` trailers; use whatever attribution your tool requires for new ones.

## 10. Recommended plan for the Codex orchestrator

**Orchestrate, don't implement.** Keep the orchestrator thin: it assigns, merges, and verifies. Suggested routing (adjust to the models you actually have; verify availability first):

| Work                                                                                       | Needs                               | Suggested worker                                                                         |
| ------------------------------------------------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------------------------------------- |
| Review + salvage patches A and B, write extra project/timeline/render scenarios            | volume, careful TS                  | a strong coding model (Codex/`gpt6luna`) or a cheaper Kilo/BytePlus coder for the volume |
| Patch C (secrets, providers, mock LLM server)                                              | security-sensitive, protocol detail | strongest available model; review its output with a second, different model              |
| Patch D (flags, logger, doctor, worker)                                                    | cross-cutting design                | strongest available; it defines the contract the others conform to                       |
| Fixtures (media via ffmpeg, malformed project files, Persian/RTL/emoji names, huge inputs) | cheap, mechanical                   | cheapest capable model (Kilo `kilo-auto/efficient`, BytePlus plan)                       |
| Adversarial bug bash on the merged result                                                  | fresh eyes, different model family  | AGY/Gemini-class long-context model reading the whole `apps/cli` tree                    |

Steps:

1. Branch from `hadimoti/wonderful-ritchie-vfpgv7`; `pnpm install`, build, read this file and `agent-briefs.md`.
2. Apply the four patches in the order D, A, B, C; fix the one TS error; `prettier --write apps/cli`.
3. **Diagnose the hung/slow combined vitest run first** (run files one at a time; check the `render-benchmark` "63 skipped"). Probable fixes: serialise the e2e files (`--no-file-parallelism` or per-file pools), raise per-test timeouts, make the build lock robust.
4. **Review every patch critically** — treat them as drafts. For each claimed fix, confirm the test fails without the fix and passes with it (revert the source change, run the test).
5. Commit per area (tests + fix together), push to the branch, keep PR #7 a draft.
6. Resolve finding 10 (hermetic provider test) and findings the patches did not cover.
7. Run the full gate (`pnpm check`) plus both entry points (`bin` and `bundle`), then an adversarial bug bash by a model that did not write the code.
8. Update the PR description with the findings table; answer the owner questions in section 8 where possible.

Definition of done: `pnpm check` green on a clean checkout; every confirmed finding in section 6 either fixed with a failing-then-passing test or listed as an explicit owner decision; no test needs network, keys, or wall-clock timing; real-binary tests pass for both `bin` and `bundle` entry points.
