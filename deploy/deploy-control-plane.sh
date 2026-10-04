#!/usr/bin/env bash
set -Eeuo pipefail

# deploy-control-plane.sh: Full orchestration for JOY Media control plane deployment.
# 1. Takes PostgreSQL backup before migration 009
# 2. Builds and syncs apps/account-web to /opt/joy-media/account-web
# 3. Builds and activates new API release via deploy-cutover.sh
# 4. Migrations (009_agent_usage_ledger) run automatically on API startup
# 5. Applies narrowed Nginx boundary via apply-nginx-cutover.sh
# 6. Runs comprehensive health and edge probe checks

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="${JOY_MEDIA_REPO_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd -P)}"
BACKUP_DIR="${JOY_MEDIA_BACKUP_DIR:-/opt/joy-media/backups}"
ACCOUNT_WEB_TARGET="/opt/joy-media/account-web"

die() {
  echo "deploy-control-plane: $*" >&2
  exit 1
}

log() {
  echo "==> $*"
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must run as root on Sweden VPS"
[[ -d "$REPO_DIR" ]] || die "repository directory missing: $REPO_DIR"

cd -- "$REPO_DIR"

log "Step 1/6: Pre-flight checks"
command -v pnpm >/dev/null 2>&1 || die "pnpm not found"
command -v pg_dump >/dev/null 2>&1 || die "pg_dump not found"
command -v systemctl >/dev/null 2>&1 || die "systemctl not found"
command -v curl >/dev/null 2>&1 || die "curl not found"

mkdir -p "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"

log "Step 2/6: Backing up PostgreSQL before migration 009"
PG_DB="joymedia"
if su - postgres -c "psql -lqt" 2>/dev/null | cut -d \| -f 1 | grep -qw "joy_media"; then
  PG_DB="joy_media"
fi
PG_BACKUP_FILE="$BACKUP_DIR/joy-media-pre-controlplane-${TIMESTAMP}.sql.gz"
if command -v su >/dev/null 2>&1; then
  su - postgres -c "pg_dump $PG_DB" | gzip > "$PG_BACKUP_FILE" || {
    # Fallback to local pg_dump
    pg_dump -U postgres "$PG_DB" | gzip > "$PG_BACKUP_FILE" || die "failed to backup postgres database"
  }
fi
log "PostgreSQL backup secured at $PG_BACKUP_FILE ($(du -h "$PG_BACKUP_FILE" | cut -f1))"

log "Step 3/6: Building @joy-media/account-web"
CI=true npm_config_confirm_modules_purge=false pnpm install --frozen-lockfile
CI=true pnpm --filter @joy-media/account-web build || die "account-web build failed"

log "Deploying account-web build to $ACCOUNT_WEB_TARGET"
TEMP_WEB_STAGE="$(mktemp -d "$ACCOUNT_WEB_TARGET.staging.XXXXXX")"
cp -r apps/account-web/dist/* "$TEMP_WEB_STAGE/"
chmod -R 755 "$TEMP_WEB_STAGE"

if [[ -d "$ACCOUNT_WEB_TARGET" ]]; then
  BACKUP_WEB="${ACCOUNT_WEB_TARGET}.bak-${TIMESTAMP}"
  mv "$ACCOUNT_WEB_TARGET" "$BACKUP_WEB"
fi
mv "$TEMP_WEB_STAGE" "$ACCOUNT_WEB_TARGET"
log "Account Web SPA successfully deployed to $ACCOUNT_WEB_TARGET"

log "Step 4/6: Building and deploying API release via deploy-cutover.sh"
node "$REPO_DIR/tooling/ops/smoke-gateway.mjs" --pre-cutover ||
  die "Pre-cutover Joy Model gateway smoke failed"
bash "$SCRIPT_DIR/deploy-cutover.sh" || die "deploy-cutover.sh failed"

log "Step 5/6: Applying Nginx lean boundary"
bash "$SCRIPT_DIR/apply-nginx-cutover.sh" || die "apply-nginx-cutover.sh failed"

log "Step 6/6: Verifying edge endpoints"
check_endpoint() {
  local url="$1"
  local expected="$2"
  local code
  code="$(curl -k -s -o /dev/null -w "%{http_code}" "$url" -H "Host: joyst.ir")"
  if [[ "$code" != "$expected" ]]; then
    die "Verification failed: $url expected $expected got $code"
  fi
  echo "  OK: $url -> $code"
}

check_endpoint "https://127.0.0.1/api/health" "200"
check_endpoint "https://127.0.0.1/ready" "200"
check_endpoint "https://127.0.0.1/" "200"
check_endpoint "https://127.0.0.1/api/v1/projects" "404"
check_endpoint "https://127.0.0.1/api/v1/media" "404"
check_endpoint "https://127.0.0.1/api/v1/jobs" "404"

log "Post-deploy Joy Model gateway smoke"
node "$REPO_DIR/tooling/ops/smoke-gateway.mjs" || die "Joy Model gateway smoke failed"

log "JOY Media Control Plane and Account Web deployment completed successfully!"
