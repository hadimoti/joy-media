# JOY Live Director R2 ("Living Looks") — deploy runbook

> **NOT YET DEPLOYED.** This is the guarded Sweden release procedure prepared for
> the R2 candidate. It must not be executed until: CodeRabbit clean +
> `r2-candidate.yml` (or the agreed CI topology) green ×2 on the exact candidate
>
> - independent Opus ("Astra") `APPROVE_FOR_DEPLOY <sha> <tree> <lock>` on file +
>   **explicit owner go-ahead** + every pack's `OWNER_TASTE_REVIEW` verdict
>   recorded in the scorecard. The implementer never self-approves.

Recorded: 2026-09-08. Shape follows `deploy/README.md` "Release order" and the
proven R1 runbook (`joy-live-director-r1-deploy-runbook-2026-09-07.md`), with the
two path corrections R1 execution found baked in: VPS repo is
`/opt/joy-media/repo` (build worktree base `/opt/joy-media/builds/joy-media-<sha>`),
build is root `pnpm build` (`pnpm -r --if-present build`), DB dump needs
`sudo -u postgres pg_dump joymedia`.

## Candidate

| Field  | Value                                                         |
| ------ | ------------------------------------------------------------- |
| commit | `PENDING`                                                     |
| tree   | `PENDING`                                                     |
| lock   | `PENDING` (sha256 of `pnpm-lock.yaml`)                        |
| schema | `5` — **unchanged**                                           |
| base   | `855734cf0c875101a632426983db2638c2adddcd` (R1, current live) |

## Blast radius — web-bundle-only, cleaner than R1

`git diff --name-only 855734cf..<candidate>` (at the current branch tip) touches
**only**: `apps/editor-web`, `packages/{motion-core,project-schema}`, `tests/`,
`tooling/`, `docs/`, `.github/`. Verified at branch HEAD:

- **No Postgres migration.** `apps/api/src/postgres-migrations.ts`
  `POSTGRES_MIGRATIONS` is byte-identical at `855734cf` and the candidate —
  same five ids `001-baseline` … `005-stock-video`. Schema stays `5`.
- **No `apps/api` runtime change.** The only `apps/api` diff is
  `resumable-original-upload.test.ts` (a test-only poll-budget widen). The API
  release / `joy-media@api` service does not change; its `dist/server.js` is
  byte-equivalent to live.
- **No new dependency.** `pnpm-lock.yaml` and every `package.json` are unchanged
  `855734cf..<candidate>` — zero lock delta. (R1 added `mediabunny`; R2 adds
  nothing.) Rollback is a pure pointer flip.
- **`packages/project-schema`**: schema **v3** lands additively
  (`living-look.ts`, `v3.ts`, `migrateV2ToV3`). It ships inside the editor-web
  bundle, but the editor still reads `JoyProjectV1` (v2 and v3 dual-lens are
  dormant), so no persisted-document behaviour changes. `LookInstance`
  persistence is an explicit R2 follow-up (see the acceptance bundle).
- **`packages/motion-core`**: the pure Look compiler + six packs + audio-reactive
  baker. No renderer, no wall-clock, no I/O; consumed by the editor bundle.
- The built-in JOY Agent Engine Worker still ships inside the editor-web static
  bundle (`verify:joy-agent-worker` gate) — deploys with the web release.
- `.github/workflows/r2-candidate.yml` is CI config only; it does not ship.
- `nginx`: no change. joyst.ir is served from the **shared**
  `/etc/nginx/conf.d/joy-wg-bot.conf` `root /opt/joy-media/web` — do NOT edit it;
  the symlink swap is transparent. `nginx -t` + reload only.

## Pre-flight (local)

- [ ] CodeRabbit clean on the R2 delta (`855734cf..<candidate>`).
- [ ] CI green ×2 on the exact candidate (topology per the Opus infra decision —
      hosted `r2-candidate.yml`, self-hosted `release-candidate.yml` adapted, or
      the agreed hybrid). Record run ids.
- [ ] `pnpm run verify:ci` locally exit 0 at the candidate. (At branch tip:
      full `pnpm test` = **4196 passed / 38 skipped / 0 failed**, 526 files.)
- [ ] Candidate identity re-verified in the worktree: `git rev-parse <candidate>`,
      `git rev-parse <candidate>^{tree}`, `git show <candidate>:pnpm-lock.yaml |
    sha256sum`, base `855734cf` is an ancestor, candidate is an ancestor of
      branch HEAD, and any commits HEAD carries past the candidate touch only
      docs.
- [ ] Astra `APPROVE_FOR_DEPLOY <sha> <tree> <lock>` on file for this exact
      triple.
- [ ] Every pack `OWNER_TASTE_REVIEW: APPROVED` (or an owner-recorded
      ship-with-N-packs decision) in
      `joy-live-director-r2-look-scorecard-2026-09-08.md`.
- [ ] Owner deploy go-ahead in chat.
- [ ] Re-read live Gbrain + Desktop `VPS-AGENT-BRIEF.md` for concurrent JOY
      deployment ownership; coordinate, do not overwrite.

## VPS steps (guarded; owner runs each block in their root session, pastes output back; Claude verifies against the candidate and calls go/no-go)

Paths: repo `/opt/joy-media/repo` (remotes `origin`→GitHub, `vps-local`→`/opt/joy-media.git`);
build worktree base `/opt/joy-media/builds/joy-media-<sha>`; web releases
`/opt/joy-media/web-releases/*`, current link `/opt/joy-media/web`; API releases
`/opt/joy-media/releases/*`, current link `…/releases/current-api`; env
`/etc/joy-media/api.env`; API origin `http://127.0.0.1:8790` (`/live`, `/ready`);
unit `joy-media@api`. `pnpm` is on PATH (11.15.0) + shim `/usr/local/bin/pnpm`.

### C0 — discover (read-only)

```bash
set -e
hostname; date -u
readlink -f /opt/joy-media/web
readlink -f /opt/joy-media/releases/current-api
ls -1dt /opt/joy-media/web-releases/*/ | head -5
git -C /opt/joy-media/repo remote -v
git -C /opt/joy-media/repo log --oneline -1
node -v; pnpm -v; sudo -u postgres pg_dump --version | head -1
grep -o 'assets/[A-Za-z0-9_-]*\.js' /opt/joy-media/web/index.html | head -3
cat /opt/joy-media/web/release-identity.env 2>/dev/null || true
```

**Checkpoint C0:** record current web + api release dirs (rollback targets),
confirm repo remote + toolchain.

### C1 — get the exact candidate onto the VPS

```bash
set -e
cd /opt/joy-media/repo
git fetch origin --prune --tags
CAND=<candidate-sha>
git worktree add --detach /opt/joy-media/builds/joy-media-$CAND $CAND
cd /opt/joy-media/builds/joy-media-$CAND
echo "HEAD  $(git rev-parse HEAD)"
echo "tree  $(git rev-parse HEAD^{tree})"
git show HEAD:pnpm-lock.yaml | sha256sum
git diff --name-only 855734cf..HEAD -- apps/api packages/project-schema/src/index.ts | grep -v '\.test\.' || echo "no api/schema-surface runtime change"
```

**Checkpoint C1:** `HEAD`, `tree`, `lock sha256` == the Astra triple exactly.
Any mismatch → `git worktree remove` and re-cut.

### C2 — DB backup (guarded procedure; no migration in this release)

```bash
set -e
mkdir -p /opt/joy-media/data/backups
ts=$(date -u +%Y%m%dT%H%M%SZ)
sudo -u postgres pg_dump --format=custom joymedia \
  > /opt/joy-media/data/backups/joymedia-r2-$CAND-predeploy-$ts.dump
ls -lh /opt/joy-media/data/backups/joymedia-r2-$CAND-predeploy-$ts.dump
sha256sum /opt/joy-media/data/backups/joymedia-r2-$CAND-predeploy-$ts.dump
```

**Checkpoint C2:** dump exists, non-trivial size. Keep until the deploy gate is
accepted. (No schema change to reverse — code rollback fully reverses R2.)

### C3 — build from the lockfile

```bash
set -e
cd /opt/joy-media/builds/joy-media-$CAND
CI=true pnpm install --frozen-lockfile
sha256sum pnpm-lock.yaml
CI=true pnpm build
node tooling/release/verify-agent-operation-coverage.mjs
node tooling/release/verify-joy-agent-worker.mjs 2>/dev/null || pnpm run verify:joy-agent-worker
test -f apps/editor-web/dist/index.html && echo "editor-web dist OK"
```

**Checkpoint C3:** `pnpm-lock.yaml` sha256 unchanged, `--frozen-lockfile` clean,
root `pnpm build` exit 0, coverage ratchet passes (still 16 bounded ops — R2
adds none), Worker size gate passes, `dist/index.html` present.

### C4 — stage the immutable web release (no pointer moved)

```bash
set -e
cd /opt/joy-media/builds/joy-media-$CAND
rel="joy-media-$CAND-web"
dst="/opt/joy-media/web-releases/$rel"
cp -a apps/editor-web/dist "$dst"
bash deploy/joy-media-release-identity.sh write "$dst/release-identity.env" \
  $CAND <tree-sha> <lock-sha256> 5
test -f "$dst/index.html" && test -f "$dst/release-identity.env" && echo "staged OK"
( cd "$dst" && find . -type f | sort | sha256sum )   # artifact digest -> record
sha256sum "$dst/index.html"
```

**Checkpoint C4:** record `rel`, the artifact digest, and the `index.html`
sha256. Still fully reversible.

### C5 — the atomic switch (first irreversible step)

```bash
set -e
nginx -t
NEW=/opt/joy-media/web-releases/joy-media-$CAND-web
test -f "$NEW/index.html"
ln -sfn "$NEW" /opt/joy-media/.web.new
mv -Tf /opt/joy-media/.web.new /opt/joy-media/web
readlink -f /opt/joy-media/web
systemctl reload nginx
```

**API identity bookkeeping** (only if C0 shows the VPS re-archives the API per
release; `server.js` is unchanged so this is identity-only — merge **only**
`JOY_MEDIA_RELEASE_*`):

```bash
set -e
API=/opt/joy-media/releases/joy-media-$CAND-api   # if archived in C3/C4
cp -p /etc/joy-media/api.env /etc/joy-media/api.env.before-r2-$CAND-$(date -u +%Y%m%dT%H%M%SZ).env
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

If the API is not re-archived per release, skip the block above — R2 changes no
API code, and R1's `JOY_MEDIA_RELEASE_*` values simply remain until the next
API-touching release.

### C6 — public health

```bash
curl -k --noproxy '*' --resolve joyst.ir:443:127.0.0.1 -fsS -o /dev/null -w 'origin root %{http_code}\n' https://joyst.ir/
curl -fsS -o /dev/null -w 'cf root %{http_code}\n' https://joyst.ir/
curl -fsS -o /dev/null -w 'api health %{http_code}\n' https://joyst.ir/api/health
curl -fsS https://joyst.ir/ | grep -o '<title>[^<]*'
curl -fsS https://joyst.ir/release-identity.env || true
```

**Checkpoint C6:** origin + CF root 200, `/api/health` `{"ok":true,…}`, served
`release-identity.env` commit == the candidate, served `index.html` sha256 ==
the C4 value, old entry bundle 404. On any failure → **On failure**.

## Smoke test (Browser pane, joyst.ir, owner logged in)

Disposable project only; never the owner's real API key or browser media for
paid calls. Re-verify `GET /api/v1/auth/session` via the UI first (re-login if
dropped).

- [ ] New disposable project → editor loads clean, 0 JS console errors.
- [ ] Joy Code panel → **Looks** capability → the **six** built-in packs render
      with honest availability (any unavailable pack shows its `Needs:` labels,
      not a broken control).
- [ ] Pick **Editorial Clean** → bind the Headline slot to a text object →
      **Run** → a staged JOY Agent live proposal renders
      (`data-agent-preview-ready="true"`) → **Approve** applies it → the headline
      has the compiled entrance keyframes → one **Undo** restores it.
- [ ] Reject path: run again → **Reject** → the canonical project is unchanged.
- [ ] An unavailable-by-design pack (e.g. one needing a font not bundled, if any)
      shows disabled Run with the reason — never a partial apply.
- [ ] Reload → no approval-capable preview revives; the project is intact; the
      owner's real projects are untouched.
- [ ] Served build identity matches the candidate / the C4 artifact digest.

## On failure

```bash
cd /opt/joy-media/builds/joy-media-$CAND   # or any checkout with deploy/
bash deploy/joy-media-rollback.sh --dry-run <good-api-release> <good-web-release>
bash deploy/joy-media-rollback.sh --apply   <good-api-release> <good-web-release>
```

`<good-*-release>` = the C0-recorded pre-deploy targets. If only the web pointer
moved (the expected R2 case — API untouched), a one-liner is enough:
`ln -sfn <good-web-release> /opt/joy-media/.web.rb && mv -Tf /opt/joy-media/.web.rb /opt/joy-media/web && systemctl reload nginx`.
Keep the DB backup. Report the failure honestly; never relabel a failed smoke as
a successful deploy.

## Closeout (orchestrator only)

- [ ] Write the redacted R2 release result to live VPS Gbrain
      (`ops/joy-media-live-director-r2-deploy-<date>`); read it back.
- [ ] `Invoke-VpsGbrainExport.ps1` with **no arguments**; record the verified
      export SHA in a redacted `gbrain-pc` receipt; `Publish-PcReceipt.ps1`.
- [ ] Fresh-read + append the validated R2 release + limitations to Desktop
      `VPS-AGENT-BRIEF.md` (candidate/artifact identity, scope, tests, rollback,
      the documented follow-ups, next milestone = R3 "Linked Versions");
      preserve concurrent `joy-vps` edits; no secrets.
- [ ] Update `STATE.md` with an "R2 deployment" section.
- [ ] Never edit / push the pull-only Desktop `gbrain` mirror.

Then R3 "Linked Versions" begins.

---

## Deploy record

_(empty — fill on execution)_
