# Redistributable browser-audit media fixtures

These files are deterministic, synthetic fixtures generated locally by
`tooling/generate-media-fixtures.mjs`. They contain no personal media and are
released under the repository's existing test-fixture terms. Regenerate with:

```text
node tooling/generate-media-fixtures.mjs
```

`manifest.json` records SHA-256, byte length, MIME, duration, dimensions, and
audio properties. The corrupt/invalid fixtures are intentionally invalid and
must be rejected before catalog mutation.
