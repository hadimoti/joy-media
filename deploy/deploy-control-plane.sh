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
ACCOUNT_WEB_TARGET="${JOY_MEDIA_ACCOUNT_WEB_TARGET:-/opt/joy-media/account-web}"
EDGE_ADDR="${JOY_MEDIA_EDGE_ADDR:-}"
CA_FILE="${JOY_MEDIA_CA_FILE:-${NODE_EXTRA_CA_CERTS:-/etc/ssl/joyst/origincertificate.pem}}"
EDGE_RESOLVE=""
NGINX_CONF="${JOY_MEDIA_NGINX_CONF:-/etc/nginx/conf.d/joy-wg-bot.conf}"
RELEASE_ROOT="${JOY_MEDIA_API_RELEASE_ROOT:-/opt/joy-media/releases}"
CURRENT_API_LINK="${JOY_MEDIA_CURRENT_API_LINK:-$RELEASE_ROOT/current-api}"
PREVIOUS_API_TARGET=""
NGINX_ROLLBACK_FILE=""
API_CUTOVER_DONE=0
CUTOVER_SCRIPT="${JOY_MEDIA_CUTOVER_SCRIPT:-$SCRIPT_DIR/deploy-cutover.sh}"
NGINX_APPLY_SCRIPT="${JOY_MEDIA_NGINX_APPLY_SCRIPT:-$SCRIPT_DIR/apply-nginx-cutover.sh}"

die() {
  echo "deploy-control-plane: $*" >&2
  exit 1
}

log() {
  echo "==> $*"
}

rollback_cutover() {
  [[ "$API_CUTOVER_DONE" == 1 ]] || return 0
  echo "deploy-control-plane: restoring previous API and Nginx configuration" >&2
  if [[ -n "$NGINX_ROLLBACK_FILE" && -f "$NGINX_ROLLBACK_FILE" ]]; then
    if cp -p "$NGINX_ROLLBACK_FILE" "$NGINX_CONF"; then
      nginx -t && systemctl reload nginx ||
        echo "deploy-control-plane: Nginx restore needs attention" >&2
    else
      echo "deploy-control-plane: could not restore Nginx backup" >&2
    fi
  fi
  if [[ -n "$PREVIOUS_API_TARGET" ]]; then
    local restore_link="${CURRENT_API_LINK}.rollback.$$"
    if ln -s -- "$PREVIOUS_API_TARGET" "$restore_link" &&
      mv -Tf -- "$restore_link" "$CURRENT_API_LINK"; then
      systemctl restart "${JOY_MEDIA_API_SYSTEMD_UNIT:-joy-media@api}" || true
    else
      echo "deploy-control-plane: could not restore previous API pointer" >&2
    fi
  fi
}

edge_failure() {
  rollback_cutover
  die "$*"
}

if [[ "${EUID:-$(id -u)}" -ne 0 && !( "${JOY_DEPLOY_TEST_MODE:-}" == 1 && "${JOY_DEPLOY_TEST_ROOT_OK:-}" == 1 ) ]]; then
  die "must run as root on Sweden VPS (test override requires JOY_DEPLOY_TEST_MODE=1 and JOY_DEPLOY_TEST_ROOT_OK=1)"
fi
[[ -d "$REPO_DIR" ]] || die "repository directory missing: $REPO_DIR"

cd -- "$REPO_DIR"

log "Step 1/6: Pre-flight checks"
command -v pnpm >/dev/null 2>&1 || die "pnpm not found"
command -v pg_dump >/dev/null 2>&1 || die "pg_dump not found"
command -v systemctl >/dev/null 2>&1 || die "systemctl not found"
command -v curl >/dev/null 2>&1 || die "curl not found"
command -v nginx >/dev/null 2>&1 || die "nginx not found"
command -v node >/dev/null 2>&1 || die "node not found"
[[ -n "$EDGE_ADDR" ]] || die "JOY_MEDIA_EDGE_ADDR is required (IPv4 or IPv6 literal)"
[[ -f "$CA_FILE" ]] || die "CA file missing: $CA_FILE (set JOY_MEDIA_CA_FILE)"
EDGE_ADDR="$(python3 - "$EDGE_ADDR" <<'PYEOF'
import ipaddress, sys
try:
    print(ipaddress.ip_address(sys.argv[1].strip("[]")))
except ValueError:
    sys.exit(1)
PYEOF
)" || die "JOY_MEDIA_EDGE_ADDR must be an IP literal"
EDGE_RESOLVE="$EDGE_ADDR"
if [[ "$EDGE_ADDR" == *:* ]]; then EDGE_RESOLVE="[$EDGE_ADDR]"; fi

# Preflight must finish before the account-web build or any live path is changed.
nginx -t || die "nginx -t failed during preflight"
[[ -L "$CURRENT_API_LINK" ]] || die "current API pointer is not a symlink: $CURRENT_API_LINK"
PREVIOUS_API_TARGET="$(readlink -f -- "$CURRENT_API_LINK")"
[[ -d "$PREVIOUS_API_TARGET" ]] || die "current API target is missing: $PREVIOUS_API_TARGET"
[[ -f "$NGINX_CONF" ]] || die "Nginx config missing: $NGINX_CONF"
NGINX_ROLLBACK_FILE="$(mktemp "${TMPDIR:-/tmp}/joy-nginx-before.XXXXXX")"
cp -p "$NGINX_CONF" "$NGINX_ROLLBACK_FILE"

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
bash "$CUTOVER_SCRIPT" || die "deploy-cutover.sh failed"
API_CUTOVER_DONE=1

log "Step 5/6: Applying Nginx lean boundary"
if ! bash "$NGINX_APPLY_SCRIPT"; then
  rollback_cutover
  die "apply-nginx-cutover.sh failed"
fi

log "Step 6/6: Verifying edge endpoints"
check_endpoint() {
  local url="$1"
  local expected="$2"
  local code
  code="$(curl --silent --show-error --output /dev/null --write-out "%{http_code}" \
    --max-time 20 --cacert "$CA_FILE" --resolve "joyst.ir:443:$EDGE_RESOLVE" \
    "$url")" || edge_failure "Verification request failed: $url"
  if [[ "$code" != "$expected" ]]; then
    edge_failure "Verification failed: $url expected $expected got $code"
  fi
  echo "  OK: $url -> $code"
}

check_endpoint "https://joyst.ir/api/health" "200"
check_endpoint "https://joyst.ir/ready" "200"
check_endpoint "https://joyst.ir/" "200"
check_endpoint "https://joyst.ir/api/v1/projects" "404"
check_endpoint "https://joyst.ir/api/v1/media" "404"
check_endpoint "https://joyst.ir/api/v1/jobs" "404"

log "Post-deploy Joy Model gateway smoke"
node "$REPO_DIR/tooling/ops/smoke-gateway.mjs" --edge-addr "$EDGE_ADDR" --ca "$CA_FILE" ||
  edge_failure "Joy Model gateway smoke failed"

log "JOY Media Control Plane and Account Web deployment completed successfully!"
