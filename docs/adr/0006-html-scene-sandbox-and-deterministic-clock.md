# ADR-0006: HTML Scenes use a capability-denied deterministic runtime

Status: Accepted
Date: 2026-07-19

## Context

HTML/React scenes are creative content, but unrestricted website code must not run in the editor process (§2.3, §20.4). WP-00.4 needs to prove the authoring/runtime contract: typed inputs, JOY-owned time, reproducible randomness, no default network, and exact 30/60 fps capture.

## Decision

1. A scene is a parameterized React component bundle whose only dynamic input is `JoySceneContext`: exact `timeUs`, `durationUs`, rational frame index/rate, seed, typed variables, and locale.
2. The runtime owns time. Wall-clock APIs, timers, `requestAnimationFrame`, and host DOM/process access are absent from the scene scope. Capture advances one exact rational-frame timestamp at a time.
3. Randomness is supplied as a deterministic, frame-local `context.random()` stream derived from the declared seed and time. Scenes must not depend on uncontrolled `Math.random`.
4. Network and storage permissions are denied in the P00 contract. Scene manifests requesting either are rejected before evaluation; source references to common network APIs fail policy validation.
5. The P00.4 Node `vm` implementation is a deterministic contract harness and test seam, **not a complete untrusted-code security boundary**. Production preview/export will execute scene bundles in a sandboxed iframe or isolated process with CSP, no-network policy, typed postMessage protocol, resource limits, and pinned runtime (P04).
6. The first React scene and its captures are intentionally synthetic. It demonstrates parameters, seed reproducibility, and exact 30/60 fps frame sequences without a browser, assets, or an export pipeline.

## Alternatives considered

- **Run scene code in the main editor directly** — rejected: exposes the host DOM, application state, and network/clock APIs.
- **Use Node `vm` as the long-term security sandbox** — rejected: Node documents it as insufficient for hostile code; it only validates the restricted contract here.
- **Allow network by manifest default** — rejected: remote content undermines deterministic export and introduces privacy/security risks.
- **Let React control animation with timers** — rejected: frame output would depend on scheduler timing rather than the project clock.

## Consequences

- React is an authoring option, not a project-model dependency; the durable project will reference a scene package/manifest rather than React elements.
- P04 must replace the test harness with a real iframe/process sandbox and add asset/font resolvers, typed message validation, cancellation/cleanup, CSP tests, and Chromium capture.
- A scene requiring network must make an explicit future permission request and provide frozen/captured input for deterministic export.

## Validation and rollback

`packages/html-scene-runtime/src/runtime.test.ts` proves deterministic same-seed output, differing seed output, exact end-exclusive 30/60 fps capture, denied host/network globals, and rejected forbidden manifests/source. Revert a runtime change if it changes a pinned deterministic scene output without an intended contract revision.

## Related contracts/tests

`packages/html-scene-runtime/src/runtime.ts` · master plan §2.3, §20.4 · WP-00.4.
