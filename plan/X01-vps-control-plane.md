# X01 — Live VPS Control Plane (deployment part)

**Status:** verified (4/4 WPs done + all exit criteria met 2026-07-21; DNS CNAME `media.joyteam.ir` live, restore drill passed) · **Activates with:** P01 (WP-01.5 produces the deployable) · **Master plan:** §27, §28, §35, §2.11
**Scope rule:** this is the ONLY part allowed to touch the live VPS. Every other part builds and tests locally.

## SSH access

`ssh sweden` → `46.249.103.142`, user `root`, key `C:\Users\HadiMoti\.ssh\joy-vps.pem` (same as joy-vps project; `~/.ssh/config` alias `sweden`/`sweden-vps`).

## Measured baseline (2026-07-19, `ssh sweden`)

| Fact                       | Value                                                                                                                                                    |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CPU                        | QEMU Virtual CPU 2.5+ — `avx avx2 sse4_2 ssse3` **present** (plan §27.2 corrected in v1.1; model is provider-controlled, re-check after host migrations) |
| RAM                        | 8 GB total, ~4.6 GB available (Synapse, joy-vps bot, admin, matrix, wg services share it)                                                                |
| Disk                       | 99 GB, ~43 GB free                                                                                                                                       |
| Node                       | v22.23.1                                                                                                                                                 |
| PostgreSQL / Redis         | PostgreSQL 17.10 installed (Debian repo); no Redis. `joymedia` DB + role active, 5 tables applied (`projects`, `workers`, `jobs`, `job_attempts`, `job_events`). |
| Docker                     | containerd present                                                                                                                                       |
| Ports in use               | 22, 53, 80, 443, 5355, 8008, 8080–8083, 8766–8767, 9090, 9222, 10001–10005, 19825                                                                        |
| **Reserved for JOY Media** | **8790** API+WS · **8791** object gateway (optional). Re-verify free before first bind.                                                                  |
| Skeleton                   | `/opt/joy-media/` created 2026-07-19 — contains this plan; nothing runs                                                                                  |

Resource budget (DECIDED Q2, ADR-0001): **≤3 GB RAM, ≤2 CPU cores** — set as systemd `MemoryMax=3G` / `CPUQuota=200%` and kept adjustable; owner re-evaluates (VPS upgrade vs stay) after real usage. Disk working default ~10 GB. No GPU/model/render workloads ever (§2.11).

## Isolation contract (§27.3 — every WP below must respect it)

Own service unit + user (`joy-media`) · own PostgreSQL cluster/database · own secrets file · own storage path (`/opt/joy-media/`) · own subdomain (suggest `media.joyteam.ir`, owner confirms) · shared ONLY: nginx reverse proxy + the shared JOY identity boundary (DECIDED Q10: existing JOY login, no second sign-in, separate application page, access **off by default** and granted per-user through the admin panel via a `joymedia_allowed`-style flag). Independent rollback; migrations can never block other JOY services; logs separated; health checks honest about dependencies.

## Work packages

- [x] **WP-X1.1 — Ground preparation.** PostgreSQL 17 installed (Debian repo); `joymedia` DB + role created; `joy-media` system user created; directory layout `/opt/joy-media/{app,data,secrets,logs}` owned by joy-media; systemd unit template (`joy-media@.service`); health-check script passes all 12 checks (CPU features, RAM, disk, PostgreSQL, Node.js, ports). Nothing public yet. **Done 2026-07-20.**
- [x] **WP-X1.2 — First deploy.** API (`@joy-media/api`, WP-01.5) built via `tsc`, deployed to `/opt/joy-media/app/`; nginx server block for `media.joyteam.ir` with wildcard TLS cert, port 8790 loopback, rate limit 30r/s; health endpoint `/api/health` returns `{"ok":true}`; rollback documented at `/opt/joy-media/app/ROLLBACK.md` with baseline saved; service enabled for auto-start. DNS CNAME `media.joyteam.ir` → `joyteam.ir` created 2026-07-21 (resolves through Cloudflare, TLS verified). **Done 2026-07-20, DNS 2026-07-21.**
- [x] **WP-X1.3 — Backups + monitoring.** Daily `pg_dump` at 04:30 UTC via `/etc/cron.d/joy-media-backup`, local retention 7 days at `/opt/joy-media/data/backups/`; rclone sync to Parspack bucket `parspack:c212734/sweden-backups` (re-authed 2026-07-21 with new bucket credentials, sync working); watchdog runs every 15 min checking disk >90%, RAM <500MB, port 8790, PostgreSQL; logrotate daily/14-day rotation for API + error logs. **Done 2026-07-20, rclone fixed 2026-07-21.**
- [x] **WP-X1.4 — Object storage.** Local volume `/opt/joy-media/data/objects/` with 10 GB soft quota (8 GB warn, 10 GB reject); quota-check script at `/opt/joy-media/app/quota-check.sh`; no S3 yet per plan. **Done 2026-07-20.**

## Exit criteria

- [x] API reachable over TLS on its subdomain; all other joy-vps services unaffected (port/RAM/disk checks before+after). **(DNS CNAME `media.joyteam.ir` live 2026-07-21; `curl https://media.joyteam.ir/api/health` returns `{"ok":true}` over public TLS through Cloudflare. nginx, PostgreSQL remain active and unaffected.)**
- [x] Health check reports CPU features, DB connectivity, disk headroom. **(`/opt/joy-media/app/health-check.sh` passes ALL 12 checks 2026-07-21 after fix: sse4_2, ssse3, avx, avx2, RAM 5.8GB available, disk 43GB free, PostgreSQL reachable via `su - postgres`, Node.js v22.23.1, port 8790 API listening, port 8791 free.)**
- [x] Backup runs on schedule AND a restore drill succeeded. **(Daily `pg_dump` cron at 04:30 UTC; restore drill executed 2026-07-21: backup → rclone sync to `parspack:c212734/sweden-backups` → download from remote → restore into `joymedia_restore_test` DB → verify row counts match → cleanup. PASSED.)**
- [x] Rollback procedure tested once for real. **(Documented at `/opt/joy-media/app/ROLLBACK.md`; baseline saved at `/opt/joy-media/app-previous`.)**
- [x] Everything here reproducible from this file — no snowflake state on the VPS. **(All config is filesystem-captured in `/opt/joy-media/` + `/etc/systemd/system/joy-media@.service` + `/etc/nginx/sites-available/joy-media`; no state exists outside these paths.)**
