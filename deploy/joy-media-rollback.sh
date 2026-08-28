#!/usr/bin/env bash
set -euo pipefail

# Switch both immutable JOY Media pointers back to previously verified API and
# web releases. The default is a dry run; --apply is required for a live switch.
# Usage: joy-media-rollback.sh [--dry-run|--apply] <api-release> <web-release>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./joy-media-release-identity.sh
source "$SCRIPT_DIR/joy-media-release-identity.sh"

MODE="dry-run"
if [[ "${1:-}" == "--apply" || "${1:-}" == "--dry-run" ]]; then
  MODE="${1#--}"
  shift
fi

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 [--dry-run|--apply] <api-release> <web-release>" >&2
  exit 2
fi

API_ROOT="${JOY_MEDIA_API_RELEASE_ROOT:-/opt/joy-media/releases}"
WEB_ROOT="${JOY_MEDIA_WEB_RELEASE_ROOT:-/opt/joy-media/web-releases}"
API_TARGET="$1"
WEB_TARGET="$2"
CURRENT_API="${JOY_MEDIA_CURRENT_API_LINK:-$API_ROOT/current-api}"
WEB="${JOY_MEDIA_CURRENT_WEB_LINK:-/opt/joy-media/web}"
API_ENV_FILE="${JOY_MEDIA_API_ENV_FILE:-/etc/joy-media/api.env}"
# Default live unit remains: systemctl restart joy-media@api
API_SYSTEMD_UNIT="${JOY_MEDIA_API_SYSTEMD_UNIT:-joy-media@api}"
API_LOCAL_ORIGIN="${JOY_MEDIA_API_LOCAL_ORIGIN:-http://127.0.0.1:8790}"

resolve_release() {
  local root="$1" candidate="$2" resolved
  resolved="$(readlink -f -- "$candidate")"
  case "$resolved" in
    "$root"/*) ;;
    *) echo "release is outside $root: $candidate" >&2; exit 1 ;;
  esac
  [[ -d "$resolved" ]] || { echo "release directory missing: $resolved" >&2; exit 1; }
  [[ "$resolved" != "$root" ]] || { echo "release root is not a release" >&2; exit 1; }
  printf '%s\n' "$resolved"
}

API_RELEASE="$(resolve_release "$API_ROOT" "$API_TARGET")"
WEB_RELEASE="$(resolve_release "$WEB_ROOT" "$WEB_TARGET")"
[[ -d "$API_RELEASE/dist" ]] || { echo "API dist missing: $API_RELEASE/dist" >&2; exit 1; }
[[ -f "$API_RELEASE/dist/server.js" ]] || { echo "API entrypoint missing" >&2; exit 1; }
[[ -f "$WEB_RELEASE/index.html" ]] || { echo "web index missing: $WEB_RELEASE/index.html" >&2; exit 1; }
[[ -f "$API_ENV_FILE" ]] || { echo "API env file missing: $API_ENV_FILE" >&2; exit 1; }

RELEASE_IDENTITY_FILE="$API_RELEASE/release-identity.env"
load_release_identity_file "$RELEASE_IDENTITY_FILE"

echo "API rollback target: $API_RELEASE"
echo "web rollback target: $WEB_RELEASE"
echo "current-api: $CURRENT_API"
echo "web: $WEB"
echo "api env: $API_ENV_FILE"
echo "release identity: $RELEASE_IDENTITY_FILE"
echo "mode: $MODE"

if [[ "$MODE" != "apply" ]]; then
  exit 0
fi

TMP_API="$API_ROOT/.current-api.rollback.$$"
TMP_WEB="$WEB_ROOT/.web.rollback.$$"
TMP_ENV="$(dirname -- "$API_ENV_FILE")/.api.env.rollback.$$"
PREVIOUS_ENV_BACKUP="$(dirname -- "$API_ENV_FILE")/.api.env.before-rollback.$$"
PREVIOUS_API=""
if [[ -e "$CURRENT_API" || -L "$CURRENT_API" ]]; then
  PREVIOUS_API="$(readlink -f -- "$CURRENT_API")"
fi
PREVIOUS_WEB=""
if [[ -e "$WEB" || -L "$WEB" ]]; then
  PREVIOUS_WEB="$(readlink -f -- "$WEB")"
fi
ROLLBACK_SWITCHED=0
cleanup_path() {
  local path="$1"
  if [[ -L "$path" ]]; then
    unlink -- "$path" 2>/dev/null || rm -f -- "$path" 2>/dev/null || true
    return 0
  fi
  rm -f -- "$path" 2>/dev/null || true
  rmdir -- "$path" 2>/dev/null || true
}
cleanup() {
  cleanup_path "$TMP_API"
  cleanup_path "$TMP_WEB"
  cleanup_path "$TMP_ENV"
  cleanup_path "$PREVIOUS_ENV_BACKUP"
}
remove_active_path() {
  local path="$1"
  local allowed_parent="$2"
  if [[ -L "$path" || -f "$path" ]]; then
    cleanup_path "$path"
    return 0
  fi
  if [[ -d "$path" ]]; then
    local resolved_parent
    resolved_parent="$(readlink -f -- "$allowed_parent")"
    case "$resolved_parent" in
      "") echo "unable to validate active path parent for removal: $path" >&2; return 1 ;;
    esac
    case "$(readlink -f -- "$(dirname -- "$path")")" in
      "$resolved_parent") ;;
      *) echo "refusing to remove active path outside $resolved_parent: $path" >&2; return 1 ;;
    esac
    rm -rf -- "$path"
  fi
}
replace_path() {
  local source="$1"
  local destination="$2"
  if mv -Tf -- "$source" "$destination" 2>/dev/null; then
    return 0
  fi
  cleanup_path "$destination"
  mv -f -- "$source" "$destination"
}
restore_previous_state() {
  [[ "$ROLLBACK_SWITCHED" == "1" ]] || return 0

  if [[ -n "$PREVIOUS_API" ]]; then
    ln -s -- "$PREVIOUS_API" "$TMP_API"
    replace_path "$TMP_API" "$CURRENT_API"
  else
    remove_active_path "$CURRENT_API" "$API_ROOT"
  fi

  if [[ -n "$PREVIOUS_WEB" ]]; then
    ln -s -- "$PREVIOUS_WEB" "$TMP_WEB"
    replace_path "$TMP_WEB" "$WEB"
  else
    remove_active_path "$WEB" "$(dirname -- "$WEB")"
  fi

  if [[ -f "$PREVIOUS_ENV_BACKUP" ]]; then
    replace_path "$PREVIOUS_ENV_BACKUP" "$API_ENV_FILE"
  fi

  systemctl restart "$API_SYSTEMD_UNIT" || true
  systemctl reload nginx || true
}
finish() {
  local status="$1"
  if [[ "$status" -ne 0 ]]; then
    restore_previous_state || true
  fi
  cleanup
  exit "$status"
}
trap 'finish "$?"' EXIT

ln -s -- "$API_RELEASE" "$TMP_API"
ln -s -- "$WEB_RELEASE" "$TMP_WEB"
merge_release_identity_into_env "$API_ENV_FILE" "$RELEASE_IDENTITY_FILE" "$TMP_ENV"
cp -p -- "$API_ENV_FILE" "$PREVIOUS_ENV_BACKUP"
nginx -t
ROLLBACK_SWITCHED=1
replace_path "$TMP_API" "$CURRENT_API"
replace_path "$TMP_WEB" "$WEB"
replace_path "$TMP_ENV" "$API_ENV_FILE"

systemctl restart "$API_SYSTEMD_UNIT"
systemctl reload nginx

# systemd reports the process started before Node has bound the socket. Poll
# briefly so an otherwise healthy rollback is not reported as failed during
# that normal startup window.
wait_for_endpoint() {
  local endpoint="$1"
  local attempt
  for attempt in $(seq 1 20); do
    if curl --fail --silent --show-error --max-time 2 "$endpoint" >/dev/null; then
      return 0
    fi
    sleep 1
  done
  echo "rollback health check timed out: $endpoint" >&2
  return 1
}

wait_for_endpoint "$API_LOCAL_ORIGIN/live"
wait_for_endpoint "$API_LOCAL_ORIGIN/ready"
ROLLBACK_SWITCHED=0
echo "rollback complete"
