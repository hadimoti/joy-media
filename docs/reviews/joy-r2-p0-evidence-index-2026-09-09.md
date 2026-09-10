# JOY Live Director R2 — P0 evidence index (2026-09-09, rev P0-R1)

**Package:** P0 — evidence preservation, provenance, discrepancy reconciliation.
**This is not product acceptance, technical acceptance, or deployment approval.**
Successful preservation only means the evidence is now safe to review.

> **P0-R1 revision (2026-09-09, Claude session `7c5ec584`).** Corrects identity
> labels, untracked-entry counts, and citation errors; adds a fresh read-only
> `ffprobe` pass and a static package/dist provenance inventory in a **separate
> append-only** evidence directory. The original P0 bundle and its `MANIFEST.csv`
> are unchanged (hash re-verified, see below). No preservation run was repeated.

## Identity anchors (three distinct things — do not conflate)

| #   | Thing                                                                        | Commit                                                                                    | Tree                                       |
| --- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------ |
| 1   | **Application baseline** (R2 impl; `codex/joy-live-director`, `jm-r2-check`) | `d01770b1eafeb10f9cc0386ca3122d8314a4ee90`                                                | `551ddb516a2a14ea3dc49dba4ae3ac863a88291b` |
| 2   | **Reviewed P0 checkpoint** (parent = #1)                                     | `03e8909affdc97e2b922763251d4707085587351`                                                | `07a470238203ef4831ffc9cb149009160f8f0494` |
| 3   | **P0-R1 result** (parent = #2)                                               | _supplied in the P0-R1 return report after commit — a commit cannot contain its own hash_ | _idem_                                     |

- `pnpm-lock.yaml` at the application baseline `d01770b1`: blob
  `bcf36b0d24e24d55305898e783b4813723e22d90`, raw SHA-256
  `c9e147f8f56265b5e53e64800c1f691d67675ac2618434bfc821f666176b88aa` (133 132 B).
  The P0 and P0-R1 commits are **docs-only** and do not touch the lock.
- Worktree: `C:\Users\HadiMoti\joy-r2-p0-20260909T185139Z`
- Branch: `codex/joy-r2-p0-provenance-20260909T185139Z`
- No push authorized. No fetch/merge/pull performed. No originals modified.

## Evidence root 1 — original P0 preservation bundle (immutable)

```
C:\Users\HadiMoti\Desktop\joy-r2-p0-evidence-20260909T185139Z\
```

- `MANIFEST.csv` — per-file: category, git status, bytes, mtime (UTC), match,
  dest rel path, source abs path, SHA-256 (source-before / dest / source-after).
- `MANIFEST.csv` SHA-256:
  `e9dfe84379da9c53d08fd2feb7c438bbdcd17dacae26a292b260f743f3e1f97c`
  (**re-verified unchanged at P0-R1 start, 2026-09-09T19:24Z**; Codex separately
  verified all 78 copies and the current originals).
- Items: **78** | verified OK (src-before == dest == src-after): **78** |
  anomalies: **0** | total bytes: **9,676,182**

Copy method per file: hash source → `copy2` (preserves mtime) → hash destination →
re-hash source. All three hashes equal for every item. Originals untouched.

## Evidence root 2 — P0-R1 fresh observations (append-only, new)

```
C:\Users\HadiMoti\Desktop\joy-r2-p0-r1-evidence-20260909T192442Z\
```

- `README.md` — scope, tooling, coverage.
- `per-sample.json` / `.csv` — machine-readable per-sample probe results (15 rows),
  each row carrying the file SHA-256 and linking to its raw call tags.
- `raw-command-index.json` / `.csv` — **every** `ffprobe` call: executable, full
  argv, cwd, UTC start/end, exit code, `timed_out`, stdout/stderr SHA-256.
- `raw/<tag>.json` + `raw/<tag>.stdout` + `raw/<tag>.stderr` — 63 calls, stdout and
  stderr captured **separately**, verbatim.
- `package-provenance.json` — per-package manifest hash, tsconfig, `.tsbuildinfo`,
  `src/index.ts` hash, per-file `dist/` list, workspace junction targets.
- `dist-files.sha256` — 436 lines, `<sha256>  packages/<pkg>/dist/<relpath>`
  (normalized, sorted, reproducible — replaces the earlier undocumented aggregates).
- `SHA256SUMS` — hash of every other file in that directory; its own SHA-256:
  `288d45681d9f8e711cae28c70d70bdb71f89ff84a0c1e9f596b5d964d22fb5cb`.

Probe pass: 15/15 preserved MP4s, 63 sequential `ffprobe` calls, one decoder at a
time, 120 s (metadata/`-count_frames`) or 60 s (packet) timeout each. **0 timeouts,
0 non-zero exits, 0 decoder-error lines on stderr.** No media written or regenerated.
Tooling: `ffprobe` 8.1.1-full_build-www.gyan.dev, `node` v22.22.3, `pnpm` 11.15.0
(paths in `README.md`). This is container/stream/decode-count evidence only — **not**
pixel or audio-content acceptance.

## Contents of bundle 1 by category

| Dir in bundle                | Category                    | Items | Notes                                                                                                                                                                               |
| ---------------------------- | --------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `jm-r2-check/samples-out/**` | evidence media + reports    | 42    | 10 proxy MP4, 4 intended MP4, 1 A/V fixture MP4, 2 manifests, 3 intended sweeps, `verify/` (2 JSON reports, 16 `.av-sweep-*.ppm`, 3 `*-native.ppm`, `av-sync-audio.pcm`)            |
| `jm-r2-check/tooling/*.mjs`  | producer / verifier scripts | 7     | untracked in `jm-r2-check`; see provenance report §4                                                                                                                                |
| `jm-r2-check/docs-reviews/`  | review docs                 | 2     | `...r2-sample-gallery-2026-09-09.md` (untracked), `...r2-gap-reconciliation-2026-09-08.md` (tracked — carries the `f80e029a` failure text at its lines 378–392)                     |
| `session-6672909d-logs/`     | raw process logs            | 16    | original `full-check-*.log` / `check-52b11d51*.log` etc. from session `6672909d` scratchpad — **original stdout captures, not transcript reconstructions**. See ledger D-04..D-06.  |
| `ci-opt-docs/`               | review docs                 | 4     | `joy-media-ci-{review-response,open-items,repetition-contract}-2026-09-08.md`, `github-support-artifact-quota-2026-09-09.md` (all tracked on `codex/joy-live-director-ci-opt`)      |
| `desktop-handoffs/`          | handoff / plan docs         | 7     | active plan + its byte-preserved pre-review backup + the session-authored original + 2 handoffs + 2 older handoffs                                                                  |
| `concurrent-unverified/`     | **NOT adopted**             | 1     | `looks-encoded-sample-acceptance.test.ts` — untracked in `codex/joy-live-director`, unknown owner, concurrent work. Snapshot only. Not run, staged, edited, or treated as baseline. |

## Untracked state of `jm-r2-check` (corrected)

`git status --porcelain` in `jm-r2-check` reports **9 collapsed untracked entries**;
one of them (`samples-out/`) is a directory that expands to more files.
`git status --untracked-files=all` reports **50 individual untracked files**:

- `docs/reviews/joy-live-director-r2-sample-gallery-2026-09-09.md` (1)
- `tooling/*.mjs` — the 7 producer/verifier scripts (7)
- `samples-out/**` — **42 files** (15 MP4, 2 `manifest.json`, 3 `sweep-*.txt`,
  and `verify/` = 16 `.av-sweep-frame-*.ppm` + `av-sync-audio.pcm` +
  `av-sync-report.json` + 3 `*-native.ppm` + `verify-report.json`)

`samples-out/intended/` contains **3** `sweep-*.txt`
(`editorial-clean-landscape`, `kinetic-type-landscape`, `kinetic-type-portrait`);
`sweep-editorial-clean-portrait.txt` is **absent** (ledger D-08).

The earlier revision of this index said "8 untracked entries"; that was wrong on
both the collapsed count (9) and the file count (50).

## Raw process logs located (session `6672909d` scratchpad)

Path: `C:\Users\HadiMoti\AppData\Local\Temp\claude\C--Users-HadiMoti-joy-media\6672909d-0c7d-4102-8056-8c6b34cf5bad\scratchpad\`

| Log                                                             | Role                         | Result (verbatim markers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `full-check-0a829af4.log`                                       | render-timeout evidence      | `SHA: 0a829af4…`, `CHECK_EXIT: 1`. `looks-render-acceptance.test.ts` (10 tests \| 1 failed). Failing case: `… (GAP 4) > editorial-clean (portrait): identical preview/export at 3 frames, with real motion 5091ms → Test timed out in 5000ms.` Other 9 GAP-4 pack cases passed (2365–3244 ms). `Tests 4327 passed \| 1 failed \| 38 skipped`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `full-check-d01770b1.log`                                       | claimed green                | `SHA: d01770b1…`, `CHECK_EXIT: 0`. `Test Files 538 passed \| 1 skipped (539)`. `Tests 4328 passed \| 38 skipped (4366)`. `Duration 46.56s`. Only commit vs `0a829af4` = the GAP-4 30 s timeout bump.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `full-check-f80e029a.log`                                       | font-assets flake            | `SHA: f80e029a…`, `CHECK_EXIT: 1`. `font-assets.test.ts` (6 tests \| 1 failed \| 13903 ms). Failing case: `editor font redistribution gate > is clean through the same scanner used by release:gate 13694ms → Test timed out in 5000ms.` The **other 5** font-assets cases passed (0–202 ms). Stack top `font-assets.test.ts:104:3`; body line 105 = `const result = scanFontAssets(repositoryRoot);`. `Tests 4263 passed \| 1 failed \| 38 skipped (4302)` — an **earlier GAP checkpoint** (534 files) than `0a829af4`/`d01770b1` (539). **A test timeout, not a redistribution-gate assertion failure.** A timeout establishes only that the 5 s budget was exceeded — not which internal operation was slow, nor whether any assertion in that case ran (ledger D-05). |
| `full-check-{e65c132a,9f97ff0b,04edd236,4d3c8ce1,1bf0e656}.log` | intermediate GAP checkpoints | preserved, not individually re-audited in P0/P0-R1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `full-check-c0de248c.log`                                       | 442 bytes                    | stub / aborted run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `check-52b11d51{,-rerun,-r3}.log`                               | 2026-09-09 ~11:2x            | preserved, out of the R2-impl line; not audited                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

Nothing was reconstructed. Logs not found on disk stay MISSING; all three named
logs were located as genuine original captures.

## What was deliberately NOT copied

- No `node_modules`, `.git`, `dist/` trees, `.pnpm-store`, or whole session/config
  directories (size + secret hygiene). `dist/` provenance is addressed by static
  hashing in place — see the provenance report and `dist-files.sha256`.
- No `vps` remote contact. No `.env` / provider config / process command lines.
- Secret scan (`ghp_`, `gho_`, `github_pat_`, `AKIA…`, PEM private keys,
  `xox[baprs]-…`, `Authorization: Bearer …`) over the whole bundle: **0 matches.**
  Not an exhaustive audit; the logs are Vitest stdout.
