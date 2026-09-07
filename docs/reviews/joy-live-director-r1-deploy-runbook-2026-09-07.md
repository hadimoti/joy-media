# JOY Live Director R1 — deploy runbook

Recorded: 2026-09-07. Owner deploy go-ahead given ("wait for CI green then
deploy R1"). Independent Opus ("Astra") `APPROVE_FOR_DEPLOY` on the exact
candidate is on file (contingent on CI `34123884446` green). This runbook is
the repository's guarded Sweden release procedure (`deploy/README.md`
"Release order") applied to this candidate. **Surfaced to the owner before
execution.**

## Candidate

| Field  | Value                                                              |
| ------ | --------------------------------------------------------------- |
| commit | `855734cf0c875101a632426983db2638c2adddcd`                      |
| tree   | `54ccefce85daf174b25620b24b64b9d54c130dcc`                      |
| lock   | sha256 `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3` |
| schema | `5` — **unchanged** (`POSTGRES_MIGRATIONS.length` = 5 at both `6a6a336c` and `855734cf`) |
| base   | `6a6a336c` (current live)                                       |

## Blast radius — this is a web-bundle-only release

`git diff --name-only 6a6a336c..855734cf` touches **only**: `apps/editor-web`,
`packages/{agent-tools,audio-core,media-core,test-fixtures,workflow-engine}`,
`tests/`, `tooling/`, `docs/`. **No `apps/api`, no `deploy/`, no
`packages/project-schema`, no Postgres migration, no schema/protocol bump.**

Therefore:

- The API release (`/opt/joy-media/releases/current-api`, `joy-media@api`
  service) does not change. The immutable API archive is still rebuilt for
  release-identity bookkeeping, but its `dist/server.js` is byte-equivalent to
  the live one.
- **No DB migration runs.** The `joymedia` backup is still taken (guarded
  procedure), but there is no schema change to reverse — code rollback fully
  reverses this release.
- The built-in JOY Agent Engine Worker ships inside the editor-web static
  bundle (`verify:joy-agent-worker` gate), so it deploys with the web release.
- One new runtime dependency: `mediabunny@1.55.7` (MPL-2.0, consumed as the
  published package, documented in `joy-observation-decoder-selection.md`, in
  the Astra bundle). `pnpm-lock.yaml` grows 26 lines, additive. The VPS build's
  `pnpm install --frozen-lockfile` pulls it; step 3's sha256 check pins it. The
  previous web bundle does not reference it, so rollback is clean.
- `nginx`: only `joy-media.nginx.conf`'s own server blocks are validated /
  reloaded. No shared config edit, no unrelated service restart, no `joy-vps`
  checkout change, no filesystem sync/delete.

## Pre-flight (local, done / to confirm)

- [x] CodeRabbit clean; `pnpm -w run check` exit 0 (4033 tests).
- [x] `release-candidate.yml` green ×2 on the round-1 code tree
      (`34078187134`, `34097358089`).
- [x] Candidate identity re-verified in the worktree 2026-09-07: commit
      `855734cf` resolves, tree `54ccefce85daf174b25620b24b64b9d54c130dcc`,
      `pnpm-lock.yaml` sha256 `36426937…8427b0b3`, base `6a6a336c` present,
      candidate is an ancestor of branch HEAD. The 4 commits HEAD carries past
      the candidate touch only 2 docs files (this runbook + the acceptance
      bundle) — no runtime/build/lock/migration change, so Astra's approval on
      `855734cf` still stands.
- [ ] `release-candidate.yml` run `34123884446` on `855734cf` — **green,
      every `acceptance` + `real-service-acceptance` job**. Astra's approval is
      void otherwise. (2026-09-07 15:5x: 19/20 green, `real-service-acceptance
      (pass 1)` the last job running, zero failures.)
- [ ] Re-read live Gbrain / Desktop `VPS-AGENT-BRIEF.md` for concurrent JOY
      deployment ownership; coordinate, do not overwrite.
- [ ] Identify the current-good web release name on the VPS for rollback.

## VPS steps (SSH `sweden`, run in order)

> The session's Bash tool is currently **denied SSH to `sweden`** by the
> auto-mode classifier. Either the owner grants that Bash permission, or the
> owner runs these and pastes the output back. Each `systemctl` / symlink step
> is individually gated.

```bash
# 0. Identity + current state
ssh sweden 'set -e; hostname; \
  readlink -f /opt/joy-media/web; \
  readlink -f /opt/joy-media/releases/current-api; \
  cat /opt/joy-media/web/index.html | grep -o "build[^\"]*" | head -1 || true; \
  ls -1t /opt/joy-media/web-releases | head -3'

# 1. Fetch the exact candidate into the VPS bare repo + a clean worktree
ssh sweden 'set -e; cd /opt/joy-media.git && git fetch --prune origin && \
  git rev-parse 855734cf0c875101a632426983db2638c2adddcd'   # must resolve

ssh sweden 'set -e; rm -rf /opt/joy-media/build-855734cf && \
  git --git-dir=/opt/joy-media.git worktree add --detach \
  /opt/joy-media/build-855734cf 855734cf0c875101a632426983db2638c2adddcd && \
  git -C /opt/joy-media/build-855734cf rev-parse HEAD^{tree}'   # == 54ccefce...

# 2. Back up the database (kept until the deploy gate is accepted)
ssh sweden 'set -e; ts=$(date -u +%Y%m%dT%H%M%SZ); \
  pg_dump --format=custom --file=/opt/joy-media/backups/joymedia-pre-r1-$ts.dump \
    "$(grep -oP "JOY_MEDIA_DATABASE_URL=\K.*" /etc/joy-media/api.env)" && \
  ls -lh /opt/joy-media/backups/joymedia-pre-r1-$ts.dump'

# 3. Reconstruct deploy deps from the lockfile, then build
ssh sweden 'set -e; cd /opt/joy-media/build-855734cf && \
  CI=true npm_config_confirm_modules_purge=false pnpm install --frozen-lockfile && \
  sha256sum pnpm-lock.yaml'   # == 36426937...

ssh sweden 'set -e; cd /opt/joy-media/build-855734cf && \
  pnpm --filter @joy-media/editor-web build && \
  pnpm --filter @joy-media/api build && \
  node tooling/release/verify-agent-operation-coverage.mjs && \
  test -f apps/editor-web/dist/index.html'

# 4. Immutable web release + release-identity
ssh sweden 'set -e; cd /opt/joy-media/build-855734cf; \
  rel=r1-855734cf-$(date -u +%Y%m%dT%H%M%SZ); \
  dst=/opt/joy-media/web-releases/$rel; \
  cp -a apps/editor-web/dist "$dst" && \
  bash deploy/joy-media-release-identity.sh write \
    "$dst/release-identity.env" \
    855734cf0c875101a632426983db2638c2adddcd \
    54ccefce85daf174b25620b24b64b9d54c130dcc \
    36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3 \
    5 && \
  echo "WEB_RELEASE=$rel"; \
  ( cd "$dst" && find . -type f | sort | sha256sum )'   # artifact digest

# 4b. Immutable API release (identity bookkeeping; server.js unchanged)
ssh sweden 'set -e; cd /opt/joy-media/build-855734cf && \
  CI=true npm_config_confirm_modules_purge=false pnpm deploy --legacy --prod \
    /opt/joy-media/releases/r1-855734cf-api && \
  bash deploy/joy-media-release-identity.sh write \
    /opt/joy-media/releases/r1-855734cf-api/release-identity.env \
    855734cf0c875101a632426983db2638c2adddcd \
    54ccefce85daf174b25620b24b64b9d54c130dcc \
    36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3 \
    5 && \
  diff -q /opt/joy-media/releases/r1-855734cf-api/dist/server.js \
    "$(readlink -f /opt/joy-media/releases/current-api)/dist/server.js" \
    && echo "server.js unchanged"'

# 5. Validate config, then the atomic switch (nginx JOY Media block only)
ssh sweden 'nginx -t'

ssh sweden 'set -e; \
  ln -sfn /opt/joy-media/releases/r1-855734cf-api /opt/joy-media/releases/.current-api.new && \
  mv -Tf /opt/joy-media/releases/.current-api.new /opt/joy-media/releases/current-api && \
  # merge only JOY_MEDIA_RELEASE_* into api.env from the new release identity
  bash -c '"'"'source deploy/joy-media-release-identity.sh; \
    merge_release_identity_into_env /etc/joy-media/api.env \
      /opt/joy-media/releases/r1-855734cf-api/release-identity.env \
      /etc/joy-media/.api.env.new && \
    cp -p /etc/joy-media/api.env /etc/joy-media/.api.env.pre-r1 && \
    mv -Tf /etc/joy-media/.api.env.new /etc/joy-media/api.env'"'"' && \
  systemctl restart joy-media@api'

ssh sweden 'for i in $(seq 1 45); do curl -fsS --max-time 3 http://127.0.0.1:8790/live >/dev/null && \
  curl -fsS --max-time 3 http://127.0.0.1:8790/ready >/dev/null && { echo API_HEALTHY; break; }; sleep 1; done'

ssh sweden 'set -e; \
  ln -sfn /opt/joy-media/web-releases/<WEB_RELEASE> /opt/joy-media/.web.new && \
  mv -Tf /opt/joy-media/.web.new /opt/joy-media/web && \
  systemctl reload nginx && \
  curl -fsS https://joyst.ir/ | grep -o "<title>[^<]*" '

# 6. Public health
ssh sweden 'curl -fsS -o /dev/null -w "%{http_code}\n" https://joyst.ir/ ; \
  curl -fsS -o /dev/null -w "%{http_code}\n" https://joyst.ir/api/v1/health || true'
```

## Smoke test (Browser pane, joyst.ir, owner is logged in)

Disposable project only; **never** the owner's real API key or browser media
for paid calls.

- [ ] `GET /api/v1/auth/session` via the UI resolves (re-login if dropped).
- [ ] New disposable project → Joy Code panel → **Recipes** tab shows the R1
      picker with honest availability (Audio Balance / Title & Caption Polish
      disabled with their missing capabilities).
- [ ] Connect the **test** provider in Joy Code Settings (fake/dev key,
      spend-capped) → run **Build Rough Cut** → a staged preview renders →
      **Reject** it → canonical timeline unchanged.
- [ ] Run it again → **Approve & apply** → inspect one rendered frame in the
      monitor → the timeline reflects the edit → one **Undo** restores it.
- [ ] Run **Verify Deliverable** → an honest `DirectorVerificationReport`
      (structural real, rendered/audio/encoded `unavailable`).
- [ ] Reload the page → no approval-capable preview revives; the project is
      intact.
- [ ] Confirm the served build identity — the page's release marker matches
      `855734cf` / the artifact digest recorded in step 4.

## On failure

`bash deploy/joy-media-rollback.sh --apply <current-good-api-release> <current-good-web-release>`
(atomic symlink pair + `JOY_MEDIA_RELEASE_*` env rewrite + `systemctl restart
joy-media@api` + `nginx` reload + health poll). Keep the DB backup. Report the
failure honestly; do not relabel a failed smoke as a successful deploy.

## Closeout (orchestrator only)

- [ ] Write the redacted R1 release result to live VPS Gbrain; read it back.
- [ ] `Invoke-VpsGbrainExport.ps1` with **no arguments**; record the verified
      export SHA in a redacted `gbrain-pc` receipt.
- [ ] `Publish-PcReceipt.ps1`.
- [ ] Fresh-read + append the validated R1 release + limitations to Desktop
      `VPS-AGENT-BRIEF.md` (candidate/artifact identity, scope, tests,
      rollback, next open milestone = R2 "Living Looks"); preserve concurrent
      `joy-vps` edits; no secrets.
- [ ] Never edit / push the pull-only Desktop `gbrain` mirror.

Then R2 "Living Looks" begins.
