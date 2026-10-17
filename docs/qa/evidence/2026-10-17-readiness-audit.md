# JOY Media repository readiness audit — 2026-10-17

This is a source and existing-CI audit for planning. No product code, installer,
user profile, release, or production service was changed. The application test
suites were not rerun locally during this audit.

## Repository identity

| Item                   | Observed value                                                              |
| ---------------------- | --------------------------------------------------------------------------- |
| Local branch           | `hadimoti/wonderful-ritchie-vfpgv7`                                         |
| Local HEAD             | `34bb887fe77d346f0c5de8597f36b787f5cffce9`                                  |
| Remote branch HEAD     | `c1fffd59d5078902e031e7684e69c27df40ce607`                                  |
| Remote main            | `e6aa4f7db640923ac6f7a511f3a814ed31ce87f6`                                  |
| Integration            | [Draft PR #7](https://github.com/hadimoti/joy-media/pull/7), open, unmerged |
| Existing local residue | Untracked `nul`; preserved                                                  |

Remote branch fetched and inspected with `git show`; the working checkout was
not switched, reset, or fast-forwarded. All observations below about the latest
CLI mean the remote branch revision, not the older local HEAD.

## Latest commits

All dates below are October 14, 2026, in Asia/Tehran.

| Commit     | Time  | Change                                                                               |
| ---------- | ----- | ------------------------------------------------------------------------------------ |
| `c1fffd59` | 21:52 | Install SQLite warning filter before loading the CLI module graph                    |
| `40cb4497` | 19:21 | Real FFmpeg video rendering and media registration on `add-clip`                     |
| `db7bb37c` | 18:58 | Linux formatting and SIGTERM expectation fixes                                       |
| `34bb887f` | 21:07 | Full test/fixture planning document; subsequently removed by the newer render commit |
| `5255a150` | 20:05 | Machine-readable help and unknown-command errors under `--json`                      |
| `acb315b2` | 17:31 | Preserve source position during trim                                                 |

Author timestamps are not topologically ordered. Git ancestry, rather than clock
order, establishes that the remote branch is three commits ahead of local HEAD.
Earlier October 14 commits add black-box CLI contracts, correct failure exit
codes, reject default non-TTY agent chat, and activate render/project regressions.

## Existing verification, read on October 17

[CI run 38614595200](https://github.com/hadimoti/joy-media/actions/runs/38614595200)
is successful at exact SHA `c1fffd59d5078902e031e7684e69c27df40ce607`.
Its logs report:

- Unit/integration: **615 files passed, 3 skipped; 5,413 tests passed, 37 skipped**.
- Production dependency audit: no known vulnerabilities at run time.
- Primary browser viewport: **118 passed, 1 skipped**.
- Compact and minimum browser viewports: **1 responsive checkpoint passed each**.
- Windows worker-package job: successful; this is a worker executable self-test,
  not a clean Windows desktop installation or a full Windows CLI suite.

These are historical October 14 results inspected today, not fresh local runs.
The normal workflow enables one Playwright retry in CI. Its successful summary
alone does not establish a retry-free release pass. Golden HTML scene tests and
other environment-dependent tests appear among the skips; release acceptance
must require their prerequisites and account for every required skip.

## Source findings and test priorities

1. `apps/cli/src/commands/render-media.ts` now encodes MP4, WebM, and ProRes
   using FFmpeg. `render-real.e2e.test.ts` checks real streams and sampled colors.
   Its entire suite skips when FFmpeg/FFprobe are absent, and its cancellation
   case skips Windows. It primarily uses the `bin` entry; bundled and installed
   entry acceptance still needs explicit real-render coverage.
2. The CLI renderer is a separate FFmpeg composition path. It warns about
   unsupported clip kinds, playback rate, and reverse/time-remap. Its source does
   not establish full parity with desktop effects, text, captions, transforms,
   transitions, or audio controls. Supported-feature parity and unsupported-input
   handling need measured tests before broad export claims.
3. `planRender` still calculates planning frame totals separately from the real
   renderer's timeline duration. Gaps, overlaps, parallel tracks, and fractional
   frame rates need assertions against decoded output and NDJSON metadata.
4. `utils/asset-sources.ts` keeps machine-local asset paths in a shared JSON map
   using read/modify/rename. This is not proof of concurrent-update safety or
   cross-machine portability. Test concurrent registrations, failed edits,
   project export/import, relinking, and process interruption.
5. `render-cmd.ts` promotes the media file before writing its manifest. Inject
   failure at both boundaries and define a truthful, recoverable outcome; a
   normal success case cannot establish pairwise publication safety.
6. The existing fixture generator and `media/manifest.json` already cover 16
   inputs, including animated assets and malformed media. Extend this contract;
   do not invent a competing fixture store or accept newly generated hashes as
   independent correctness evidence.
7. `STATE.md` is dated September 19; `FEATURE-STATUS.md` is audited September 5
   and still says the Windows editor is not packaged. The VPS Gbrain October
   closeout receipt records v1.0.1 release/install smoke and leaves interactive
   Local-badge Monitor scrub/playback acceptance open. These historical records
   do not prove the latest CLI branch or a new installer ready.
8. `release-candidate-v2.yml` already has exact-candidate, isolated two-pass,
   real-service, performance/soak, restore, and evidence checks. Extend and run
   the existing gate rather than replacing it with a weaker checklist.

Items 2–5 are source-observed risks for reproduction, not claims of independently
reproduced runtime bugs. No claim is made about the current production deployment.

## Planning specification

Ready means an offline-first Windows desktop editor and agent-facing CLI can
complete documented workflows, preserve user data under failure, deliver verified
media for supported features, and report unsupported operations truthfully.
Every supported feature needs scenario evidence; disabled/experimental features
need an explicit status and must not count as accepted functionality.

The execution plan is
[`2026-10-17-joy-media-readiness-loop.md`](../../superpowers/plans/2026-10-17-joy-media-readiness-loop.md).
Implementation, merge, distribution, and deployment are not performed by this
planning task. Owner standing instructions still require candidate-specific
external GPT-6 Astra `APPROVE_FOR_DEPLOY` for JOY Media releases.

Sources: local Git status/log and fetched remote objects; PR/check/run readback
through `gh`; source files named above; authenticated VPS Gbrain
`default:ops/joy-media-desktop-closeout-implementation-2026-10-02`.
