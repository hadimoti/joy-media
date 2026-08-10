# Browser media fixtures

This directory contains small, redistributable fixtures for the WP-29 browser
golden path. They are generated locally with the repository's
`tooling/generate-media-fixtures.mjs` script using FFmpeg's built-in generators; no personal media,
provider output, or credentials are included.

Run:

```text
node tooling/generate-media-fixtures.mjs
```

The generated `manifest.json` records byte length, SHA-256, media kind, MIME,
duration, and dimensions. Browser tests must verify the manifest before upload.
