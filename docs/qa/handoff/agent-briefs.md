# Worker briefs (tool-agnostic)

Paste the **Common preamble** plus one **area brief** into any worker CLI (Codex, AGY, Kilo, BytePlus plan, Grok). Each worker gets its own git worktree/branch off `hadimoti/wonderful-ritchie-vfpgv7`. Read `HANDOFF.md` first for state, the contract, and traps.

## Common preamble

You are a QA + fix engineer on the JOY Media monorepo (TypeScript, Node 22, pnpm, vitest). JOY Media is an offline-first video editor built primarily for AI agents to drive; humans can use it too. The CLI's process-level behaviour — exit codes, stdout/stderr discipline, `--json`, error messages — is the product surface. Existing unit tests call `runCli()` in-process and miss all of that. Write **humanized end-to-end tests** (scenarios as a creator or an AI agent really uses the tool) against the **real built binary**, find real bugs, and fix them.

Platform: the owner is on Windows (PowerShell). Use `path.join`; tests asserting POSIX file modes use `it.skipIf(process.platform === 'win32')`.

Setup: `pnpm install --frozen-lockfile` (PowerShell: `$env:CI='true'` first). Read `apps/cli/src/humanized/harness.ts` (`createSandbox()`, `sb.run(args, {entry:'bin'|'bundle', env, input, timeoutMs, signal, signalAfterMs})`, `r.code r.out r.err r.json() r.ndjson() describeRun(r)`) and `apps/cli/src/humanized/exit-codes.e2e.test.ts` (the style to follow). Do **not** edit `harness.ts`; put helpers in your own `*-helpers.ts`.

Contract to assert (flag, do not silently bend, anything that might be intentional — check `README.md`, `--help`, existing tests, `git log -S`):

- Exit 0 success / 1 runtime failure / 2 usage error / 130 SIGINT.
- With `--json`: stdout is exactly ONE JSON document (or NDJSON for streaming); no banner/ANSI/log lines; human diagnostics on stderr; errors machine-readable.
- No ANSI when not a TTY. Never block/prompt without a TTY. Clean runs have empty stderr.
- A failing command never corrupts or half-mutates state.
- Hermetic: sandbox HOME, no real network, fake keys only (`sk-test-...`), no wall-clock thresholds.

"Humanized" means scenarios, not function calls. Titles read like intent ("a creator splits a 30 s intro at 10 s and the timeline shows three coherent clips", "a typo in the project id gives a helpful error and a non-zero exit"). Assert what the user observes: exit code, stdout, stderr, persisted state read back by a **fresh process**. Cover happy paths, typical human mistakes, and typical AI mistakes (wrong flag order, `--json` everywhere, numbers as strings, calling twice).

Process: explore the real CLI by hand first; write tests in `apps/cli/src/humanized/<area>*.e2e.test.ts`; for each real bug make a minimal fix and prove the test **fails without the fix and passes with it** (revert the source change to check); commit tests+fix together per bug; **do not push or open PRs** (the orchestrator integrates). Before reporting: `npx vitest run <your files>`, `npx eslint apps/cli`, `npx prettier --check apps/cli`, `pnpm typecheck`. Bugs in files you do not own: write the test as `it.fails(...)` and report.

Report: worktree + branch + commits; bug table (severity P0/P1/P2, one-line repro, fixed? or why not); tests added; owner questions; what you could not verify. Be honest about anything not run or flaky.

## Area A — `project` + `timeline` (owns `commands/project-cmd.ts`, `timeline-cmd.ts`, `utils/project-loader.ts`)

Existing draft: `partial-patches/A-project-timeline.patch`. Known suspects to verify: `project create --name` ignored (positional form is the hint); `project list --json` not JSON; `project create --name` with no value silently creates an untitled project; `project show` / `export` / `timeline add-clip|split|trim|remove` error paths; id vs `file.json`; revision counters; corrupted/missing SQLite; two processes on one DB; Persian/emoji/very long/quoted names; `--sqlite-path` and `JOY_MEDIA_SQLITE_PATH`; read-only HOME; trim past bounds; split outside a clip; overlaps; zero/negative/huge numbers; removing a clip twice; unknown track. (`--start 0` rejection lives in `utils/flags.ts`, Area D.)

## Area B — `render` + `benchmark` (owns `commands/render-cmd.ts`, `benchmark-cmd.ts`)

Existing draft: `partial-patches/B-render-benchmark.patch`. **`render` does not render** (a `Math.sin` loop plus a manifest). Do not implement a renderer unprompted: pin current behaviour, make output honest (`mediaProduced: false`, "manifest only — no video file written"), and assess feasibility of real rendering (`packages/renderer-headless`, `packages/export-core`, `apps/render-host`, `tooling/golden-render`, ffmpeg). Probe: NDJSON stream contract (every line JSON, last line `done`/`error`, exit code matches), unknown/valid `--preset`, `--out` missing / unwritable / a file, `--concurrency` 0/1/32/33/"abc", empty project, many clips, fps math and rounding, manifest `frameRange` correctness with concurrency > 1 (the shared `renderedFrames` counter looks suspect), overwrite, two simultaneous renders to one dir, progress bar not polluting stdout when not a TTY, `benchmark --system|--media-engine` shape and bounded runtime. Set up projects through the real CLI (`project create`, `timeline add-clip`).

## Area C — `agent` family (owns `commands/agent-cmd.ts`, `agent/*`, `utils/config.ts`)

Existing draft: `partial-patches/C-agent-providers.patch` (includes a mock OpenAI-compatible server in `agent-helpers.ts`: `/v1/models`, `/v1/chat/completions` non-stream + SSE, scripted tool calls/401/429/500/malformed/hung, request recording). Security-sensitive; be rigorous. Probe: key file/dir permissions (expect 0600/0700 on POSIX), keys never printed in full (also with `JOY_CLI_DEBUG`, errors, `agent config`, `provider list`), `--api-key` argv exposure (env/stdin alternative), env keys not written to disk, provider add with/without model discovery (200 / bare array / 401 / HTML / huge / timeout — discovery must time out), duplicate/odd names (`__proto__`), use/remove unknown or active provider, **corrupt config silently treated as empty then overwritten**, concurrent `provider add`, precedence flags > config > env, the `'not-provided'` fake-key fallback (no key must fail fast and locally, before any network call), base URL normalisation; `agent run` dry-run vs `--apply` (no mutation without `--apply`; revision increments and persists with it), garbage/401/429/500/stalled stream, invalid tool-call args, tool call on a missing clip (no partial mutation), no `--project`, SIGINT -> 130 with no corrupt state; `agent chat` with piped stdin must exit on EOF and never need a TTY; Persian/emoji/long instructions round-trip. Also fix the non-hermetic provider test in `apps/cli/src/cli.test.ts` (it hits the live Kilo gateway).

## Area D — CLI shell (owns `cli.ts`, `bin.ts`, `utils/flags.ts`, `utils/logger.ts`, `commands/doctor-cmd.ts`, `worker-cmd.ts`, `apps/cli/bin/*`, `apps/cli/scripts/*`)

Existing draft: `partial-patches/D-cli-contract.patch`. Probe and fix: suppress only the SQLite `ExperimentalWarning` for both entry points (ESM imports hoist — use a first-imported side-effect module); `parseArgs` `strict:false` (unknown flags / missing values -> exit 2 with "did you mean"; complete the option table first, and negative numbers like `--start -3` must reach the validator); `NUMERIC_RANGES.start/end/at` need `allowZero` so `--start 0` works and messages are accurate; a "machine output" switch in `logger.ts` (suppress banner, route all human logs to stderr when `--json`); colour from the right stream's TTY plus `NO_COLOR`/`FORCE_COLOR`; `doctor` (offline-safe, bounded time, no `powershell` on non-Windows, no "all passed" with warnings, `--json`, env override for the edge URL, hermetic tests against a local server); `worker status|upscale|denoise` without GPU/venv/models, missing inputs, bad scale, `--json`; per-subcommand `--help`, `help <cmd>`, flags before the command, `--flag=value`, `--`, repeated flags, `EPIPE` on `| head -1`, SIGINT/SIGTERM exit codes (test with a never-responding local server), `JOY_CLI_DEBUG`.

## Reviewer brief (run by a model that did NOT write the code)

Read the whole `apps/cli` tree and the humanized tests. For each test ask: does it fail without the fix it claims to cover? Is it hermetic and free of timing thresholds? Does it assert what a user observes, not an implementation detail? Then try to break the CLI with inputs the authors did not think of (Unicode normalisation, path traversal in `--out`/`--sqlite-path`, symlinks, huge argv, concurrent writers, killed mid-write, locale/TZ, Windows path separators in code paths). Report only reproducible findings, each with a one-line repro, ranked by severity; do not edit code.
