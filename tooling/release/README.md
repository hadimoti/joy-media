# JOY Studio 1.0 release gate

The release gate is a non-deploying evidence check. Run `pnpm release:gate` locally or in CI; it
writes `test-output/release-gate/{report,manifest,sbom,artifact-hashes}.json` and exits non-zero
unless every critical check is proven. These generated outputs are ignored and should be archived
in local/CI evidence storage, not committed. Set `JOY_RELEASE_EVIDENCE` to a local or CI-generated
JSON evidence file to evaluate a real run. Missing evidence fails closed.

The gate requires non-zero passing tests, clean generated artifacts, no fixture handlers in
production registries, successful editor/API/Worker builds, a manifest and SBOM, a verified
authenticated editor journey, and a feature-status audit no older than 45 days. Only non-critical
status documentation may be waived, and every waiver needs an owner, reason, and future expiry.

This command never pushes, deploys, changes VPS state, or contacts GitHub. Deployment is a separate
approved operational action documented in `deploy/README.md`.
