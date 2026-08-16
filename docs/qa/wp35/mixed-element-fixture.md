# WP-35 Mixed-Element Fixture (Deterministic, Local Only)

The deterministic fixture is assembled by the project-schema and evaluator
tests without reading media from disk or the network. It uses one composition,
stable IDs, two neutral unlocked tracks, and overlapping intervals at
`0..5_000_000` microseconds. The normalized representation covers:

- two video asset items;
- one alpha-image object binding;
- one text object binding;
- one shape object binding;
- one HTML-scene object binding;
- one audio asset item;
- one caption item;
- one nested composition item.

The fixture is intentionally a test document rather than a user project. It is
safe to recreate and discard, and it does not constitute browser or production
evidence. The current source-level assertions are in:

- `packages/project-schema/src/universal-timeline.test.ts`;
- `packages/evaluator/src/active-timeline-render-plan.test.ts`;
- `apps/editor-web/src/universal-placement.test.ts`.

Required follow-up evidence is a browser run that places the same kinds on at
least two unlocked tracks, captures the Timeline/Monitor state, and compares
the Monitor and Full Export overlap ordering.
