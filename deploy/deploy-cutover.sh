#!/usr/bin/env bash
set -Eeuo pipefail

# Build and activate the API only. Database migrations are deliberately run by
# the API's startup path: PostgresControlPlane.initialize() calls
# runPostgresMigrations(), which executes BEGIN + pg_advisory_xact_lock() before
# applying the ordered ledger. This keeps the deploy and application migration
# contract identical and prevents an untracked psql schema fork.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_DIR="${JOY_MEDIA_REPO_DIR:-$(cd -- "$SCRIPT_DIR/.." && pwd -P)}"
RELEASE_ROOT="${JOY_MEDIA_API_RELEASE_ROOT:-/opt/joy-media/releases}"
CURRENT_API="${JOY_MEDIA_CURRENT_API_LINK:-$RELEASE_ROOT/current-api}"
API_ENV_FILE="${JOY_MEDIA_API_ENV_FILE:-/etc/joy-media/api.env}"
API_SYSTEMD_UNIT="${JOY_MEDIA_API_SYSTEMD_UNIT:-joy-media@api}"
API_ORIGIN="${JOY_MEDIA_API_LOCAL_ORIGIN:-http://127.0.0.1:8790}"
HEALTH_PATH="${JOY_MEDIA_API_HEALTH_PATH:-/health}"
HEALTH_ATTEMPTS="${JOY_MEDIA_HEALTH_ATTEMPTS:-45}"
HEALTH_DELAY_SECONDS="${JOY_MEDIA_HEALTH_DELAY_SECONDS:-1}"

die() {
  echo "deploy-cutover: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command missing: $1"
}

for command_name in awk bash cp curl date dirname git grep ln mktemp mv node pnpm readlink sha256sum sleep systemctl; do
  require_command "$command_name"
done

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must run as root on the VPS"
[[ -d "$REPO_DIR" ]] || die "repository directory missing: $REPO_DIR"
[[ -f "$REPO_DIR/pnpm-lock.yaml" ]] || die "pnpm-lock.yaml missing from $REPO_DIR"
[[ -f "$API_ENV_FILE" ]] || die "API environment file missing: $API_ENV_FILE"
[[ "$HEALTH_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "invalid JOY_MEDIA_HEALTH_ATTEMPTS"
[[ "$HEALTH_DELAY_SECONDS" =~ ^[0-9]+$ ]] || die "invalid JOY_MEDIA_HEALTH_DELAY_SECONDS"

cd -- "$REPO_DIR"
[[ "$(git rev-parse --is-inside-work-tree 2>/dev/null)" == true ]] || die "not a git worktree: $REPO_DIR"
[[ -z "$(git status --porcelain)" ]] || die "worktree is not clean: $REPO_DIR"

COMMIT_SHA="$(git rev-parse HEAD)"
TREE_HASH="$(git rev-parse HEAD^{tree})"
LOCKFILE_SHA256="$(sha256sum pnpm-lock.yaml | awk '{print $1}')"
SHORT_SHA="${COMMIT_SHA:0:12}"

RELEASE_NAME="${JOY_MEDIA_RELEASE_NAME:-joy-media-api-${SHORT_SHA}-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$RELEASE_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "invalid release name"
[[ "$RELEASE_NAME" != current-api ]] || die "current-api is reserved"
RELEASE_DIR="$RELEASE_ROOT/$RELEASE_NAME"
[[ ! -e "$RELEASE_DIR" && ! -L "$RELEASE_DIR" ]] || die "release already exists: $RELEASE_DIR"

mkdir -p -- "$RELEASE_ROOT"
[[ -w "$RELEASE_ROOT" ]] || die "release root is not writable: $RELEASE_ROOT"
[[ -L "$CURRENT_API" ]] || die "current API pointer is not a symlink: $CURRENT_API"
PREVIOUS_API="$(readlink -f -- "$CURRENT_API")"
case "$PREVIOUS_API" in
  "$RELEASE_ROOT"/*) ;;
  *) die "current API target is outside release root: $PREVIOUS_API" ;;
esac
[[ -d "$PREVIOUS_API" ]] || die "current API target is missing: $PREVIOUS_API"

STAGING_DIR="$(mktemp -d "$RELEASE_ROOT/.deploy-${SHORT_SHA}.XXXXXX")"
SWITCH_DIR="$(mktemp -d "$RELEASE_ROOT/.switch-${SHORT_SHA}.XXXXXX")"
API_ENV_STAGE="$SWITCH_DIR/api.env"
SWITCH_API_LINK="$SWITCH_DIR/current-api"
API_ENV_BACKUP="${API_ENV_FILE}.before-${RELEASE_NAME}.env"
ENV_SWITCHED=0
API_SWITCHED=0

cleanup() {
  rm -rf -- "$STAGING_DIR" "$SWITCH_DIR"
}

restore_previous() {
  local restore_link restore_env
  if [[ "$API_SWITCHED" == 1 ]]; then
    restore_link="$SWITCH_DIR/restore-current-api"
    ln -s -- "$PREVIOUS_API" "$restore_link"
    mv -Tf -- "$restore_link" "$CURRENT_API"
  fi
  if [[ "$ENV_SWITCHED" == 1 ]]; then
    restore_env="$SWITCH_DIR/restore-api.env"
    cp -p -- "$API_ENV_BACKUP" "$restore_env"
    mv -Tf -- "$restore_env" "$API_ENV_FILE"
  fi
  if [[ "$API_SWITCHED" == 1 || "$ENV_SWITCHED" == 1 ]]; then
    systemctl restart "$API_SYSTEMD_UNIT" || true
  fi
}

finish() {
  local status="$1"
  if [[ "$status" -ne 0 ]]; then
    restore_previous || true
  fi
  cleanup
  exit "$status"
}
trap 'finish "$?"' EXIT

echo "building API $COMMIT_SHA"
CI=true npm_config_confirm_modules_purge=false pnpm install --frozen-lockfile
pnpm --filter @joy-media/api build
grep -q 'pg_advisory_xact_lock' apps/api/dist/postgres-migrations.js ||
  die "built migrations do not contain the transaction advisory lock"
grep -q "session.query('BEGIN')" apps/api/dist/postgres-migrations.js ||
  die "built migrations do not begin a transaction"
SCHEMA_VERSION="$(node --input-type=module -e "import('./apps/api/dist/postgres-migrations.js').then(({POSTGRES_MIGRATIONS}) => console.log(POSTGRES_MIGRATIONS.length))")"
[[ "$SCHEMA_VERSION" =~ ^[1-9][0-9]*$ ]] || die "unable to determine migration schema version"

echo "staging release $RELEASE_NAME"
CI=true npm_config_confirm_modules_purge=false pnpm --filter @joy-media/api deploy --legacy --prod "$STAGING_DIR"
[[ -f "$STAGING_DIR/dist/server.js" ]] || die "API entrypoint missing from staged release"

bash "$SCRIPT_DIR/joy-media-release-identity.sh" write \
  "$STAGING_DIR/release-identity.env" \
  "$COMMIT_SHA" "$TREE_HASH" "$LOCKFILE_SHA256" "$SCHEMA_VERSION"
mv -T -- "$STAGING_DIR" "$RELEASE_DIR"

# Validate the replacement environment before moving either live pointer.
[[ ! -e "$API_ENV_BACKUP" && ! -L "$API_ENV_BACKUP" ]] || die "environment backup already exists: $API_ENV_BACKUP"
cp -p -- "$API_ENV_FILE" "$API_ENV_BACKUP"
bash "$SCRIPT_DIR/joy-media-release-identity.sh" merge \
  "$API_ENV_FILE" "$RELEASE_DIR/release-identity.env" "$API_ENV_STAGE"
[[ -s "$API_ENV_STAGE" ]] || die "staged API environment is empty"
ln -s -- "$RELEASE_DIR" "$SWITCH_API_LINK"

mv -Tf -- "$API_ENV_STAGE" "$API_ENV_FILE"
ENV_SWITCHED=1
mv -Tf -- "$SWITCH_API_LINK" "$CURRENT_API"
API_SWITCHED=1

echo "restarting $API_SYSTEMD_UNIT; startup migrations hold the PostgreSQL transaction lock"
systemctl restart "$API_SYSTEMD_UNIT"

HEALTH_URL="${API_ORIGIN%/}${HEALTH_PATH}"
healthy=0
for ((attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1)); do
  if systemctl is-active --quiet "$API_SYSTEMD_UNIT" &&
    curl --fail --silent --show-error --max-time 3 "$HEALTH_URL" >/dev/null; then
    healthy=1
    echo "API_HEALTHY $HEALTH_URL"
    break
  fi
  sleep "$HEALTH_DELAY_SECONDS"
done
[[ "$healthy" -eq 1 ]] || die "API health probe failed: $HEALTH_URL"

ENV_SWITCHED=0
API_SWITCHED=0
echo "cutover complete: $CURRENT_API -> $RELEASE_DIR"
