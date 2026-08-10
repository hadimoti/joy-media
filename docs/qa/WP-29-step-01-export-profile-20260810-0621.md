# WP-29 STEP-01 Export Profile Report

## Review state

- Status: **READY-FOR-REVIEW**
- Diagnostic functional result: **FAIL**
- Product code changes: **none**
- STEP-02: **NOT STARTED**
- Classification: **3/3 consistent FAIL; not FLAKY**

## Accepted 1080x1920 runs

| Run | Timeline/profile/exact export click | Exact combined H264/AAC MIME support | Initiation | `captureStream` | Recorder events | Export frames | Download | Bounded elapsed time | Cleanup                              |
| --- | ----------------------------------- | ------------------------------------ | ---------- | --------------- | --------------- | ------------- | -------- | -------------------- | ------------------------------------ |
| 1   | PASS                                | false                                | false      | 0               | 0               | 0             | false    | 10135 ms             | Local project purged; browser closed |
| 2   | PASS                                | false                                | false      | 0               | 0               | 0             | false    | 10144 ms             | Local project purged; browser closed |
| 3   | PASS                                | false                                | false      | 0               | 0               | 0             | false    | 10107 ms             | Local project purged; browser closed |

The diagnostic functional pass ratio is **0/3**. All three runs reached the intended timeline and export profile and clicked the exact export control, then failed consistently at the same capability guard. The result is **3/3 consistent FAIL**, not FLAKY.

## Accepted failure evidence

Only these evidence basenames are accepted for the ratio:

- `wp29-step01-1080x1920-setup-only-1786350131655-sanitized.json`
- `wp29-step01-1080x1920-setup-only-1786350324166-sanitized.json`
- `wp29-step01-1080x1920-setup-only-1786350347167-sanitized.json`

The `setup-only` text in these filenames is historical. These three artifacts contain the accepted, bounded failure evidence described above and are therefore included in the STEP-01 failure ratio.

Earlier refused-navigation, selector, fake-lower-snapshot, overlapping, and generic-export attempts are excluded setup-only attempts. They are never included in the ratio.

## MediaRecorder capability matrix

The default and feature-flag modes produced an identical capability matrix.

| Capability                        | Default | Feature flag |
| --------------------------------- | ------- | ------------ |
| MediaRecorder                     | true    | true         |
| `video/mp4`                       | true    | true         |
| AVC1-only MP4                     | true    | true         |
| Exact `avc1.42E01E` + `mp4a.40.2` | false   | false        |
| `h264,aac`                        | false   | false        |
| VP8 + Opus                        | true    | true         |
| VP9 + Opus                        | true    | true         |

The sanitized boolean-only matrix is recorded in `wp29-step01-mediarecorder-capability-sanitized.json`.

## Lower-profile disposition

- 320x180: **BLOCKED-CAPABILITY**
- 720x1280: **BLOCKED-CAPABILITY**

The shared MIME guard fails before any dimension-dependent renderer or readback work. No fake comparison is reported for either lower profile.

## Measured root cause

The App's exact combined MIME preflight exits before renderer creation and before `captureStream`. Consequently, initiation remains false, `captureStream` remains 0, recorder events remain 0, export frames remain 0, and download remains false. The historical `readPixels` stall was not reached in these runs.

## STEP-02 implementation seam

STEP-02 should address capability negotiation at the browser-export MIME/MediaRecorder boundary and the App preflight. It must preserve authored audio, progress, cancel, and cleanup behavior. The principal risks are a container/codec mismatch and audio loss.

Validation should cover three 1080x1920 runs, the lower profiles, and independent FFprobe and audio verification. Rollback applies only to the eventual STEP-02 product commit; STEP-01 contains no product code changes.

## Security and closeout

Evidence references use basenames only. This report contains no paths, URLs, contacts, IDs, tokens, or private references. Local projects were purged after each accepted run, every browser was closed, and no production mutation occurred.

Remaining later gates are Worker, playback, and the 37-case suite.

Next step: NOT STARTED
