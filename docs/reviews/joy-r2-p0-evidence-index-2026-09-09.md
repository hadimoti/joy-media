# JOY Live Director R2 — P0 evidence index (2026-09-09)

**Package:** P0 — evidence preservation, provenance, discrepancy reconciliation.
**This is not product acceptance, technical acceptance, or deployment approval.**
Successful preservation only means the evidence is now safe to review.

- Worktree: `C:\Users\HadiMoti\joy-r2-p0-20260909T185139Z`
- Branch: `codex/joy-r2-p0-provenance-20260909T185139Z`
- Base / result commit: `d01770b1eafeb10f9cc0386ca3122d8314a4ee90`
- Tree: `551ddb516a2a14ea3dc49dba4ae3ac863a88291b`
- `pnpm-lock.yaml` blob: `bcf36b0d24e24d55305898e783b4813723e22d90`
  raw SHA-256: `c9e147f8f56265b5e53e64800c1f691d67675ac2618434bfc821f666176b88aa`
- Preservation window (UTC): 2026-09-09T18:49Z … 2026-09-09T18:55Z (Phase A copy).
- No push authorized. No fetch/merge/pull performed. No originals modified.

## Evidence root

```
C:\Users\HadiMoti\Desktop\joy-r2-p0-evidence-20260909T185139Z\
```

- `MANIFEST.csv` — per-file: category, git status, bytes, mtime (UTC), match,
  dest rel path, source abs path, SHA-256 (source-before / dest / source-after).
- `MANIFEST.md` — summary.
- MANIFEST.csv SHA-256:
  `e9dfe84379da9c53d08fd2feb7c438bbdcd17dacae26a292b260f743f3e1f97c`
- Items: **78**  |  verified OK (src-before == dest == src-after): **78**  |
  anomalies: **0**  |  total bytes: **9,676,182**

Copy method per file: hash source → `copy2` (preserves mtime) → hash destination →
re-hash source. All three hashes equal for every item. Originals untouched;
`jm-r2-check` working tree still shows the same 8 untracked entries as at session
start, and the concurrent test file hash is unchanged (see ledger D-13).

## Contents by category

| Dir in bundle | Category | Items | Notes |
|---|---|---|---|
| `jm-r2-check/samples-out/**` | evidence media + reports | 42 | 10 proxy MP4, 4 intended MP4, 1 A/V fixture MP4, 2 manifests, 3 intended sweeps, `verify/` (2 JSON reports, 16 `.av-sweep-*.ppm`, 3 `*-native.ppm`, `av-sync-audio.pcm`) |
| `jm-r2-check/tooling/*.mjs` | producer / verifier scripts | 7 | untracked in `jm-r2-check`; see provenance report |
| `jm-r2-check/docs-reviews/` | review docs | 2 | `...r2-sample-gallery-2026-09-09.md` (untracked), `...r2-gap-reconciliation-2026-09-08.md` (tracked — carries the f80e029a failure text at its lines 378–392) |
| `session-6672909d-logs/` | raw process logs | 16 | original `full-check-*.log` / `check-52b11d51*.log` etc. from session `6672909d` scratchpad — **original stdout captures, not transcript reconstructions**. See ledger D-04..D-06. |
| `ci-opt-docs/` | review docs | 4 | `joy-media-ci-{review-response,open-items,repetition-contract}-2026-09-08.md`, `github-support-artifact-quota-2026-09-09.md` (all tracked on `codex/joy-live-director-ci-opt`) |
| `desktop-handoffs/` | handoff / plan docs | 7 | active plan + its byte-preserved pre-review backup + the session-authored original + 2 handoffs + 2 older handoffs |
| `concurrent-unverified/` | **NOT adopted** | 1 | `looks-encoded-sample-acceptance.test.ts` — untracked in `codex/joy-live-director`, unknown owner, concurrent work. Snapshot only. Not run, staged, edited, or treated as baseline. |

## Raw process logs located (session `6672909d` scratchpad)

Path: `C:\Users\HadiMoti\AppData\Local\Temp\claude\C--Users-HadiMoti-joy-media\6672909d-0c7d-4102-8056-8c6b34cf5bad\scratchpad\`

| Log | SHA / role | Result |
|---|---|---|
| `full-check-0a829af4.log` | render-timeout evidence | **CHECK_EXIT 1** — `looks-render-acceptance.test.ts:160` (GAP 4) `Error: Test timed out in 5000ms`. 4327 pass / 1 fail / 38 skip. |
| `full-check-d01770b1.log` | claimed green | **CHECK_EXIT 0** — 538 files, 4328 pass / 38 skip. Only delta vs 0a829af4 = the 30 s timeout bump commit. |
| `full-check-f80e029a.log` | font-assets failure | **CHECK_EXIT 1** — `tooling/release/src/font-assets.test.ts:104` `Error: Test timed out in 5000ms` inside `scanFontAssets(repositoryRoot)`. 4263 pass / 1 fail / 38 skip. **A timeout, not a redistribution-gate violation.** |
| `full-check-{e65c132a,9f97ff0b,04edd236,4d3c8ce1,1bf0e656}.log` | intermediate GAP checkpoints | preserved, not individually re-audited in P0 |
| `full-check-c0de248c.log` | 442 bytes | stub / aborted run |
| `check-52b11d51{,-rerun,-r3}.log` | 2026-09-09 ~11:2x | preserved, out of R2-impl line; not audited in P0 |

Nothing was reconstructed. Logs not found on disk stay MISSING; none were needed —
all three named logs were located as genuine captures.

## What was deliberately NOT copied

- No `node_modules`, `.git`, `dist/` trees, `.pnpm-store`, or whole session/config
  directories (size + secret-hygiene). `dist/` provenance is addressed by hashing
  in place — see the provenance report.
- No `vps` remote contact. No `.env` / provider config / process command lines.
- Secret scan (`ghp_`, `gho_`, `github_pat_`, `AKIA…`, PEM private keys,
  `xox[baprs]-…`, `Authorization: Bearer …`) over the whole bundle: **0 matches.**
  Not an exhaustive audit; the logs are Vitest stdout.
