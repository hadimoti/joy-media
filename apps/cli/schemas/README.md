# CLI output contracts

The `v1` directory contains JSON Schema Draft 7 contracts for the CLI's
machine-readable surfaces: command errors, doctor reports, project and timeline
results, agent-run results, and each render NDJSON event. `help-text.v1` pins the
discoverable human help text as a string contract.

The CLI contract tests validate real `bin` and `bundle` subprocess output against
these files. Render event validation covers manifest-only output, real encoded
media, and render errors. Keep a schema version stable for additive, backward
compatible fields; create a new version when a breaking shape change is required.
These source-tree schemas are reviewable contract artifacts and are not embedded
into the installed CLI bundle.

Run the Windows contract and real-output checks with:

```powershell
pnpm dlx pnpm@11.15.0 exec vitest run apps/cli/src/humanized/cli-schemas.e2e.test.ts apps/cli/src/humanized/agent-delivery.e2e.test.ts apps/cli/src/humanized/render-real.e2e.test.ts --no-file-parallelism
```
