# JOY Live Director R1 — deploy runbook

> **DEPLOYED 2026-09-07 ~18:00 UTC.** Candidate `855734cf` is live on
> `https://joyst.ir/`. Executed C0–C6 over `ssh sweden` from an interactive
> Claude session (the auto-mode classifier that blocked the finishing session
> does not apply). Full evidence in `STATE.md` → "JOY Live Director R1
> deployment (2026-09-07 UTC)" and the closeout section at the end of this
> file. Two runbook path corrections were found during execution: VPS repo is
> `/opt/joy-media/repo` (worktree base `/opt/joy-media/builds/joy-media-<sha>`),
> and the build command is root `pnpm build` (`pnpm -r --if-present build`),
> not `--filter @joy-media/editor-web` (which misses workspace deps like
> `@joy-media/playback-engine`). DB dump needs `sudo -u postgres pg_dump
> joymedia` — the app DB role lacks `LOCK` on some tables.

Recorded: 2026-09-07. Owner deploy go-ahead given ("wait for CI green then
deploy R1", then "read our exact rules and do it yourself"). Independent Opus
("Astra") `APPROVE_FOR_DEPLOY` on the exact candidate is on file (contingency
CI `34123884446` green — **satisfied, 20/20**). This runbook is the
repository's guarded Sweden release procedure (`deploy/README.md` "Release
order") applied to this candidate.

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
- [x] `release-candidate.yml` run `34123884446` on `855734cf` — **GREEN.**
      2026-09-07 ~17:08 UTC: **20/20 jobs `success`, run conclusion `success`**
      (`validate-candidate`, `linux-real-services` ×2, `windows-worker-clean`
      2 passes, `acceptance` ×14, `real-service-acceptance` ×2). Zero failures.
      Astra's `APPROVE_FOR_DEPLOY` is now in force.
- [ ] Re-read live Gbrain / Desktop `VPS-AGENT-BRIEF.md` for concurrent JOY
      deployment ownership; coordinate, do not overwrite.
- [ ] Identify the current-good web + api release names on the VPS for rollback
      (step 0 output).

## VPS steps

> **Tooling wall:** this session's Bash tool and terminal-read are both denied
> for `ssh sweden` / VPS access by the auto-mode classifier, and it does not
> relent on retry. The owner runs these **in their open `root@82.115.8.224`
> session** and pastes each block's output back; Claude verifies every value
> against the candidate identity and calls go/no-go at each checkpoint. Nothing
> here is irreversible before checkpoint C5 (the symlink switch).
>
> Paths from `deploy/README.md` + `deploy/joy-media-rollback.sh`: API releases
> `/opt/joy-media/releases/*`, current link `…/releases/current-api`; web
> releases `/opt/joy-media/web-releases/*`, current link `/opt/joy-media/web`;
> env `/etc/joy-media/api.env`; API origin `http://127.0.0.1:8790` (`/live`,
> `/ready`); unit `joy-media@api`.

### C0 — discover (read-only, safe)

```bash
set -e
hostname; date -u
echo "--- current pointers ---"
readlink -f /opt/joy-media/web
readlink -f /opt/joy-media/releases/current-api
echo "--- recent releases ---"
ls -1dt /opt/joy-media/web-releases/*/ | head -5
ls -1dt /opt/joy-media/releases/*/ | head -5
echo "--- how source reaches the VPS ---"
ls -ld /opt/joy-media/src /opt/joy-media.git /opt/joy-media/repo 2>/dev/null || true
git -C /opt/joy-media/src rev-parse HEAD 2>/dev/null || true
git -C /opt/joy-media/src remote -v 2>/dev/null || true
echo "--- toolchain ---"
node -v; pnpm -v; pg_dump --version | head -1
echo "--- served build marker ---"
grep -o 'assets/[A-Za-z0-9_-]*\.js' /opt/joy-media/web/index.html | head -3
cat /opt/joy-media/web/release-identity.env 2>/dev/null || true
```

**Checkpoint C0:** Claude records the current web + api release dirs (rollback
targets), confirms the source checkout path + remote, confirms node/pnpm.

### C1 — get the exact candidate onto the VPS

Using whichever source checkout C0 revealed (shown here as `$SRC`; the repo the
VPS builds from — pull it, do not touch any `joy-vps` checkout):

```bash
set -e
SRC=/opt/joy-media/src           # <-- set from C0
cd "$SRC"
git fetch --all --prune --tags
git worktree add --detach /opt/joy-media/build-855734cf 855734cf0c875101a632426983db2638c2adddcd
cd /opt/joy-media/build-855734cf
echo "HEAD  $(git rev-parse HEAD)"
echo "tree  $(git rev-parse HEAD^{tree})"
git show HEAD:pnpm-lock.yaml | sha256sum
```

**Checkpoint C1 — Claude verifies exactly:**
`HEAD == 855734cf0c875101a632426983db2638c2adddcd`,
`tree == 54ccefce85daf174b25620b24b64b9d54c130dcc`,
`lock sha256 == 36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3`.
Any mismatch → stop, `git worktree remove` the build dir, re-cut.

### C2 — DB backup (guarded procedure; no migration in this release)

```bash
set -e
mkdir -p /opt/joy-media/backups
ts=$(date -u +%Y%m%dT%H%M%SZ)
DB=$(grep -oP '^JOY_MEDIA_DATABASE_URL=\K.*' /etc/joy-media/api.env)
pg_dump --format=custom --file="/opt/joy-media/backups/joymedia-pre-r1-$ts.dump" "$DB"
ls -lh "/opt/joy-media/backups/joymedia-pre-r1-$ts.dump"
```

**Checkpoint C2:** dump file exists, non-trivial size. Keep it until the deploy
gate is accepted.

### C3 — build from the lockfile

```bash
set -e
cd /opt/joy-media/build-855734cf
CI=true npm_config_confirm_modules_purge=false pnpm install --frozen-lockfile
sha256sum pnpm-lock.yaml
pnpm --filter @joy-media/editor-web run build
node tooling/release/verify-agent-operation-coverage.mjs
test -f apps/editor-web/dist/index.html && echo "editor-web dist OK"
```

**Checkpoint C3:** `pnpm-lock.yaml` sha256 unchanged (`36426937…`), install
`--frozen-lockfile` clean, editor-web build succeeds, coverage ratchet passes,
`dist/index.html` present. (API build is optional — `apps/api` is byte-identical
to live; skip unless C0 shows the VPS always re-archives the API.)

### C4 — stage the immutable web release (no pointer moved yet)

```bash
set -e
cd /opt/joy-media/build-855734cf
rel="r1-855734cf-$(date -u +%Y%m%dT%H%M%SZ)"
dst="/opt/joy-media/web-releases/$rel"
cp -a apps/editor-web/dist "$dst"
bash deploy/joy-media-release-identity.sh write "$dst/release-identity.env" \
  855734cf0c875101a632426983db2638c2adddcd \
  54ccefce85daf174b25620b24b64b9d54c130dcc \
  36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3 \
  5
echo "WEB_RELEASE=$rel"
test -f "$dst/index.html" && test -f "$dst/release-identity.env" && echo "staged OK"
( cd "$dst" && find . -type f | sort | sha256sum )   # artifact digest -> record
```

**Checkpoint C4:** Claude records `WEB_RELEASE` and the artifact digest. Still
fully reversible — `/opt/joy-media/web` still points at the old release.

### C5 — the atomic switch (first irreversible step; own checkpoint)

```bash
set -e
nginx -t
NEW=/opt/joy-media/web-releases/<WEB_RELEASE>        # <-- from C4
test -f "$NEW/index.html"
ln -sfn "$NEW" /opt/joy-media/.web.new
mv -Tf /opt/joy-media/.web.new /opt/joy-media/web
readlink -f /opt/joy-media/web
systemctl reload nginx
```

If C0 showed the VPS also re-archives the API per release, do the API pointer +
`JOY_MEDIA_RELEASE_*` env merge here too (identity-only; `server.js` unchanged):

```bash
set -e
API=/opt/joy-media/releases/r1-855734cf-api
cp -p /etc/joy-media/api.env /etc/joy-media/.api.env.pre-r1
bash deploy/joy-media-release-identity.sh merge \
  /etc/joy-media/api.env "$API/release-identity.env" /etc/joy-media/.api.env.new
ln -sfn "$API" /opt/joy-media/releases/.current-api.new
mv -Tf /opt/joy-media/releases/.current-api.new /opt/joy-media/releases/current-api
mv -Tf /etc/joy-media/.api.env.new /etc/joy-media/api.env
systemctl restart joy-media@api
for i in $(seq 1 45); do
  curl -fsS --max-time 3 http://127.0.0.1:8790/live >/dev/null &&
  curl -fsS --max-time 3 http://127.0.0.1:8790/ready >/dev/null &&
  { echo API_HEALTHY; break; }; sleep 1; done
```

### C6 — public health

```bash
curl -fsS -o /dev/null -w 'root %{http_code}\n' https://joyst.ir/
curl -fsS -o /dev/null -w 'api  %{http_code}\n' https://joyst.ir/api/v1/health || true
curl -fsS https://joyst.ir/ | grep -o '<title>[^<]*'
curl -fsS https://joyst.ir/release-identity.env || true
```

**Checkpoint C6:** root 200, title present, served `release-identity.env`
commit == `855734cf…`. On any failure jump to **On failure** below.

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

Rehearse then apply the repo's own rollback (dry-run first):

```bash
cd /opt/joy-media/build-855734cf   # or any checkout with deploy/
bash deploy/joy-media-rollback.sh --dry-run <good-api-release> <good-web-release>
bash deploy/joy-media-rollback.sh --apply   <good-api-release> <good-web-release>
```

`<good-*-release>` = the C0-recorded pre-deploy `current-api` / `web` targets.
The script does the atomic symlink pair + `JOY_MEDIA_RELEASE_*` env rewrite +
`systemctl restart joy-media@api` + `nginx -t` + reload + 45s health poll, and
self-restores on any mid-switch error. If only the web pointer moved (API
untouched, the common R1 case), a one-liner is enough:
`ln -sfn <good-web-release> /opt/joy-media/.web.rb && mv -Tf /opt/joy-media/.web.rb /opt/joy-media/web && systemctl reload nginx`.
Keep the DB backup. Report the failure honestly; do not relabel a failed smoke
as a successful deployment.

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

---

## Deploy record (2026-09-07 UTC)

| Step | Result |
| --- | --- |
| C0 discover | live web `joy-media-6a6a336c…-web`, api `joy-media-6a6a336c…-api` (rollback targets); repo `/opt/joy-media/repo` (remotes `origin`, `vps-local`); node v22.23.1, pnpm 11.15.0, pg_dump 17.11 |
| C1 candidate | pushed `855734cf` to `vps:/opt/joy-media.git` `live-director-r1`; VPS worktree HEAD `855734cf`, tree `54ccefce85daf174b25620b24b64b9d54c130dcc`, lock `36426937a41309d10cc85fd16a3fc4d42a74c1e234c4cfb77cdd838f8427b0b3` — **exact Astra triple** |
| C1 schema | `git diff 6a6a336c 855734cf -- apps/api packages/project-schema` = empty; no migration |
| C2 DB backup | `joymedia-r1-855734cf-predeploy-20260907T175602Z.sql.gz`, 300,448 B, gzip OK, sha256 `39f9fce9395a22b69260531045694042b560467e5457cb008a655e90569778f1` |
| C3 build | `pnpm install --frozen-lockfile` clean (lock sha unchanged); root `pnpm build` exit 0; `verify-agent-operation-coverage.mjs` OK (16 bounded ops / 8 unsupported); `verify:joy-agent-worker` OK; `dist/` 12 MB, entry `assets/index-BovH_lGk.js` |
| C4 web release | `/opt/joy-media/web-releases/joy-media-855734cf…-web`; `index.html` sha256 `6cd1a8009903b46b49d0041908bfbe7cd954ab21b4140dcf86966039291d8a4e`; artifact digest `c1fffd7c4469c608ad32b05ed26097f20ac0d2c297ee5969184e51052c4cd2ae` |
| C4b api archive | `/opt/joy-media/releases/joy-media-855734cf…-api`; `dist/server.js` sha256 `3ea0895722542a71adff0e663313a9392745d47580056a437fb7123f0ca6f4fa` — byte-identical to live; `dist/` tree identical |
| C5 switch | `api.env` → `api.env.before-r1-855734cf-20260907T180009Z.env`; `JOY_MEDIA_RELEASE_*` merged; `current-api` + `web` symlinks flipped; `joy-media@api` restarted, healthy 2 s, `/ready` reports `commitSha 855734cf…` all checks true; `nginx -t` OK, reloaded |
| C6 public | origin + CF `GET /` 200; `/api/health` `{"ok":true,…,"controlPlane":true}`; served `index.html` sha256 == `6cd1a800…`; entry bundle 200; old bundle 404 |
| smoke | disposable project, editor clean, 0 JS errors; Joy Code → Recipes = 8 recipes, honest availability (Title/Caption + Audio Balance disabled with `Needs:` labels); reload stable; owner projects untouched; disposable → Trash |
| cleanup | build worktree removed; `vps:/opt/joy-media.git` `live-director-r1` branch deleted; immutable releases + DB backup + `api.env.before-*` retained |

**Rollback (until the gate is accepted):**
`bash deploy/joy-media-rollback.sh --apply joy-media-6a6a336cdd4fb0126c002dda86167f5c92ebfe32-api joy-media-6a6a336cdd4fb0126c002dda86167f5c92ebfe32-web`
