# Windows staged CLI acceptance — 2026-10-18

This is local unsigned-staging evidence for source commit
`4bc719b0f9e15147079f4a62ffdff11b0a24ae92`. It is not a frozen-candidate,
installer-lifecycle, or release approval receipt.

## Artifact identity

- Build command: `pnpm --filter @joy-media/desktop package:installer` (invoked with pnpm 11.25.0)
- Acceptance toolchain: Node 24.19.0, pinned pnpm 11.15.0 for tests, FFmpeg/FFprobe 8.1.1
- Portable archive: `joy-media-windows-x64-v1.0.1.zip`, 188.96 MB
- Portable archive SHA-256: `2ef43f9edd03d71f66bfdc2773eb5120057cb2c7a0aca31e72ce4d87e569ac41`
- `joy.cmd` and `joy-media.cmd` SHA-256: `d7c56e12a7ef44c3836e8d8eed29dff8fe1e12d99fcd708f5d775719eaf7664a`
- `joy-media.exe` SHA-256: `e048632e03fabc96de5e10afbebc0aa31f4e1674155ea3d270597fe7523f9d80`
- Bundled CLI SHA-256: `9d71e8dff86612bf7881f7882f5077ce0e084fce391deea9bf80452fdf21b011`
- Worker executable SHA-256: `21c358ae4fae3e1b24ea09ea133c8e4262499a170da64824e2c54afe2e374cc5`
- Lockfile SHA-256: `3cbd22ddd008bb7829c3f1ebabb223fbd8b33b6d0a7a8ad08c9f223d1839f922`
- Fixture manifest SHA-256: `eb35da63d4450236a71299a5241e0ef2680897e066f689f27a9ac42bcb1d41df`
- Render fixture SHA-256: `ca3deb99602a39bc747e89599b3e05393f404721a7c99683b83399596248f24f`

## Acceptance results

`tests/desktop/installed-cli-acceptance.mjs` passed independently through both
staged launchers. Each run used a new direct child of the OS temporary directory,
passed the packaged worker self-test, created a Persian-titled project, attached the
checked-in MP4 fixture, reopened the project in a fresh CLI process, and rendered a
3-second MP4. FFprobe identified H.264 video and AAC audio; FFmpeg fully decoded the
file. Both renders had SHA-256
`013f898e2b988ec83ca8d54a22d3c7b4582f34bad815f4defd4f6c37d4b125e9`.

The acceptance harness now also validates every versioned CLI schema through both
staged launchers: help text; command errors; doctor; project create, list, show, and
transfer; timeline mutation; agent-run result; and every event in the playable-render
NDJSON stream. The agent result uses an ephemeral `127.0.0.1` mock provider and a
synthetic key. Each launcher also attempts `project export --output NUL`; both exit
with usage code 2 and a schema-valid error before writing output. No external provider
or production endpoint is contacted.

Schema SHA-256 values checked by that run:

```text
agent-run-result.v1.schema.json  bf1f4c9440f36baa99afb37c07afa70b47c71113466faeeec3c9d42b0ff8c0a9
command-error.v1.schema.json    a18b830c02a27e5ffa8fb66127eb63b0ca0b67a99c870bc17ce0bcbd5602e804
doctor-report.v1.schema.json    5f59244d3151513885342ab6589de98ac23e4e366422996997b8f4d24e4aadea
help-text.v1.schema.json        62060355555dc29891b930ab6c9c20597bbf8d100cc78a5869abfa1cf343befe
project-create.v1.schema.json   62ff1d230048d6246c88ee7fad1f19c58344d5059b7b042566c23ef42c57d700
project-list.v1.schema.json     bb8752d1453672af507e4eba8877b161e4186e4a7ef0aa52d4d48519de51285d
project-show.v1.schema.json     06680e125778ff396c4f132d3372868d01e43ef89f1ecd63d64e130f6ce041a2
project-transfer.v1.schema.json bf7ab7d52f04764a512f9372705ac40dcf4892f5cedeec56f1ed8d44b1d541e0
render-event.v1.schema.json     28d9723d3f6ffb673b1737df9860d7cba173310b81e6cb967aa497fec556c2de
timeline-mutation.v1.schema.json 13d3944634141826bf2fed64c505b05a2d712a4b3fb2e5d989b2137641eab625
```

The package built from the same source commit passed:

- `pnpm --filter @joy-media/desktop test:smoke-packaged`
- `pnpm --filter @joy-media/desktop test:smoke-standalone`
- `node tests/desktop/installer-package-check.mjs` (all seven checks)
- `pnpm dlx pnpm@11.15.0 exec playwright test --config playwright.desktop.config.ts --retries=0` (1 packaged editor journey passed in 12.9s)

The package checker reports Node `DEP0190` because its test harness launches batch
files with `shell: true`; the assertions still pass. This warning is in the checker,
not the packaged CLI output.

## Limits

The package is unsigned staging output. No actual install, upgrade, rollback, or
uninstall was run. The generated setup script modifies the current Windows user's
PATH, uninstall registry key, desktop shortcut, and Start Menu shortcut even when
given a temporary `-InstallPath`; those operations require the designated disposable
Windows user or VM. The exact-candidate two-pass workflow, independent external
reviews, owner release decision, and final release evidence remain open.
