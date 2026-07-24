# P14 — Pro Tools Hermes Runbook

**Executable residual plan** for CapCut + Premiere + AE + DaVinci tooling after Phases 0–6 + icon polish.  
Hermes copy: `/root/.hermes/plans/2026-07-24_055929-joy-media-pro-tools-hermes-runbook.md` (keep in sync when editing).

Baseline tip when authored: **`937f388`**. Live web: `/opt/joy-media/web` → `web-releases/937f388`.

---

## Standing rules

### UI
- Actions = **SVG only** + `aria-label` + `title` + `data-guide`.
- No toolbar text labels (`icon-button-labeled` with visible words).

### Git (every STEP)
```bash
cd /opt/joy-media/repo
git add <step paths>
git commit -m "$(cat <<'EOF'
joy-media(P14.<step>): <why>

EOF
)"
```
- No push unless owner asks. No `--force`, no `--no-verify`, no secrets.
- Prefix: `joy-media(P14.n):`.

### Review before commit
1. `pnpm --filter @joy-media/editor-web exec tsc --noEmit`
2. Rebuild touched packages (`pnpm --filter @joy-media/<pkg> build`)
3. Targeted vitest
4. Honest agent/workflow results (no fake success)
5. Tick checkbox here + STATE handoff line if user-visible

### Deploy (when STEP says yes)
```bash
pnpm --filter @joy-media/editor-web build
SHA=$(git rev-parse --short HEAD)
mkdir -p /opt/joy-media/web-releases/$SHA
cp -a apps/editor-web/dist/. /opt/joy-media/web-releases/$SHA/
ln -sfn /opt/joy-media/web-releases/$SHA /opt/joy-media/web
systemctl restart joy-media@api
curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8790/health
```

---

## Work packages

- [ ] **P14.0** Audit live editor vs shipped tip; fix regressions only (deploy if needed)
- [ ] **P14.1** Preview/export honor mixer mute/solo/gain (deploy)
- [x] **P14.2** Durable spatial path schema + UI persistence
- [ ] **P14.3** Mixer graph drives audible preview/export end-to-end (deploy)
- [x] **P14.4** Transitions icon browser + Pixi/export apply (deploy)
- [ ] **P14.5** Effects + color grade apply in Pixi/export; scopes honesty (deploy)
- [ ] **P14.6** Agent/workflow stub retirement + caption burn-in icon (deploy)
- [ ] **P14.7** STATE + Hermes skill sync (+ GBrain staging if asked)

Related: [P11](P11-pro-nle.md) · [P12](P12-expert-motion.md) · [P13](P13-color-effects.md)

## Exit
Each STEP leaves typecheck green, one reviewable commit, and (when required) live symlink on the new SHA. Full P14 exit = P14.0–P14.7 checked with no fabricated agent diffs and transitions/FX/grade visible in Monitor.

## Hermes prompt
```text
Run the next unchecked STEP in plan/P14-pro-tools-hermes-runbook.md.
Obey Standing rules. One STEP only. Review → commit → deploy if required. Report SHA.
```
