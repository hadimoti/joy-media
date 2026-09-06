# JOY browser observation decoder selection

Recorded: 2026-09-06  
Status: selected for the bounded source-observation adapter and dedicated browser Worker; full release acceptance remains open.

## Candidate

- Package: `mediabunny` `1.55.7`, pinned exactly in `@joy-media/editor-web`.
- License: MPL-2.0. JOY consumes the published package without a source fork or modification. The release review must retain its license notice and recheck the final dependency inventory.
- Public API used: `Input`, `BlobSource`, `VideoSampleSink`, and decoded `VideoSample` presentation timestamps/durations. The adapter receives a trusted `Blob`, never a model URL, filesystem path, live Monitor element, or provider credential.
- Primary references: [Mediabunny quick start](https://mediabunny.dev/guide/quick-start), [packet and sample timing/resource guidance](https://mediabunny.dev/guide/packets-and-samples), and the [upstream MPL-2.0 license](https://github.com/Vanilagy/mediabunny/blob/main/LICENSE).

## Why this candidate

It can decode presentation-order `VideoSample` values with actual browser decoder timestamps and explicit `close()` ownership. That permits JOY to distinguish a source sample's actual presentation time from a requested range and to close the decoded resource on iterator advance, cancellation, or error. It is browser-native and does not introduce an FFmpeg, server proxy, local model, or shell dependency.

## Timing identity rule

The package exposes browser-normalized integer microseconds, not the original container tick rational. The adapter records that explicitly as a `1/1,000,000` browser-normalized timebase and retains the presentation index. It never computes time from nominal FPS. Fixture generation also records raw FFprobe presentation ticks and uses integer-floor conversion for the browser-normalized expectation. If a future codec/container requires original container ticks as a product-visible fact, add a demux-level index before claiming that capability.

## Bounded resource rule

Each yielded frame holds an upper-bound lease for decoded RGBA plus one transferable copy. The source compressed-byte cache is separately bounded at 8 MiB by default. The dedicated Worker shares a 128 MiB working-set limit across at most two active leases, while its acknowledgement protocol permits only one unconsumed artifact per job. Backpressure closes the source sample and returns a structured error; it does not retain a full clip's RGBA frames.

## Evidence so far

- Unit coverage: frame identity is derived from actual decoder fields, invalid/negative/unsafe values fail closed, frame resources are closed idempotently, and scheduler backpressure releases the native sample.
- Browser coverage: `tests/e2e/agent-observation-decode.spec.ts` exercises generated CFR, VFR, B-frame reorder, nonzero-PTS, rotation/SAR, focused flash, backpressure, cancellation, and corrupt-source fixtures through the real browser decoder. It also sends decoded frames through the dedicated browser Worker and verifies bounded JPEG artifacts with the returned presentation timestamps. The test is still the acceptance evidence for the exact supported browser/codec matrix; its final command/output is recorded with the candidate.

## Explicit limitations / next gates

- No claim yet for composition/render observation, audio observation, provider-video transport, production evidence storage, or provider semantic comprehension.
- Codec support is runtime-probed per input. Unsupported/corrupt input produces a structured error rather than an HTML-video fallback or fabricated reference frame.
- Production bundle size, AV1 runtime probe, playback-impact measurements, production source-resolution/epoch wiring, and notices/build inventory remain O2 acceptance work.
- The existing HTML media decoder remains playback-only and is not used as evidence.
