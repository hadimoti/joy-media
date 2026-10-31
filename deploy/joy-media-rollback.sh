#!/usr/bin/env bash
set -euo pipefail

# Switch both immutable JOY Media pointers back to previously verified API and
# web releases. The default is a dry run; --apply is required for a live switch.
# Usage: joy-media-rollback.sh [--dry-run|--apply] <api-release> <web-release>

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The retained P8 rollback still needs to validate metadata on previously
# deployed API releases. Keep this narrowly scoped reader here so the retired
# API release packaging helper can be removed.
readonly JOY_MEDIA_RELEASE_IDENTITY_KEYS=(
  JOY_MEDIA_RELEASE_COMMIT_SHA
  JOY_MEDIA_RELEASE_TREE_HASH
  JOY_MEDIA_RELEASE_LOCKFILE_SHA256
  JOY_MEDIA_RELEASE_SCHEMA_VERSION
)

is_release_identity_key() {
  local candidate="${1:-}"
  local key
  for key in "${JOY_MEDIA_RELEASE_IDENTITY_KEYS[@]}"; do
    if [[ "$candidate" == "$key" ]]; then
      return 0
    fi
  done
  return 1
}

normalize_release_identity_key() {
  local line="$1"
  line="${line%%#*}"
  line="${line#"${line%%[![:space:]]*}"}"
  line="${line%"${line##*[![:space:]]}"}"
  printf '%s\n' "$line"
}

validate_release_identity_value() {
  local key="$1" value="$2"
  case "$key" in
    JOY_MEDIA_RELEASE_COMMIT_SHA | JOY_MEDIA_RELEASE_TREE_HASH)
      [[ "$value" =~ ^[0-9a-f]{40,64}$ ]] || { echo "invalid $key value: $value" >&2; return 1; }
      ;;
    JOY_MEDIA_RELEASE_LOCKFILE_SHA256)
      [[ "$value" =~ ^[0-9a-f]{64}$ ]] || { echo "invalid $key value: $value" >&2; return 1; }
      ;;
    JOY_MEDIA_RELEASE_SCHEMA_VERSION)
      [[ "$value" =~ ^[0-9]+$ ]] || { echo "invalid $key value: $value" >&2; return 1; }
      ;;
    *)
      echo "unexpected release identity key: $key" >&2
      return 1
      ;;
  esac
}

load_release_identity_file() {
  local identity_file="$1"
  [[ -f "$identity_file" ]] || { echo "release identity file missing: $identity_file" >&2; return 1; }

  declare -gA JOY_MEDIA_RELEASE_IDENTITY=()
  local line trimmed key value
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(normalize_release_identity_key "$line")"
    [[ -z "$trimmed" || "$trimmed" == \#* ]] && continue
    [[ "$trimmed" == *=* ]] || { echo "invalid release identity line: $line" >&2; return 1; }
    key="${trimmed%%=*}"
    value="${trimmed#*=}"
    is_release_identity_key "$key" || {
      echo "unexpected release identity key in $identity_file: $key" >&2
      return 1
    }
    [[ -z "${JOY_MEDIA_RELEASE_IDENTITY[$key]+x}" ]] || {
      echo "duplicate release identity key in $identity_file: $key" >&2
      return 1
    }
    validate_release_identity_value "$key" "$value"
    JOY_MEDIA_RELEASE_IDENTITY["$key"]="$value"
  done <"$identity_file"

  local required_key
  for required_key in "${JOY_MEDIA_RELEASE_IDENTITY_KEYS[@]}"; do
    [[ -n "${JOY_MEDIA_RELEASE_IDENTITY[$required_key]+x}" ]] || {
      echo "missing release identity key in $identity_file: $required_key" >&2
      return 1
    }
  done
}

merge_release_identity_into_env() {
  local base_env_file="$1" identity_file="$2" destination_file="$3"
  [[ -f "$base_env_file" ]] || { echo "base environment file missing: $base_env_file" >&2; return 1; }
  load_release_identity_file "$identity_file"

  local destination_dir temp_file line trimmed key release_key
  destination_dir="$(dirname -- "$destination_file")"
  mkdir -p -- "$destination_dir"
  temp_file="$(mktemp "$destination_dir/.joy-media-api-env.XXXXXX")"
  while IFS= read -r line || [[ -n "$line" ]]; do
    trimmed="$(normalize_release_identity_key "$line")"
    if [[ "$trimmed" == *=* ]]; then
      key="${trimmed%%=*}"
      if is_release_identity_key "$key"; then
        continue
      fi
    fi
    printf '%s\n' "$line" >>"$temp_file"
  done <"$base_env_file"
  for release_key in "${JOY_MEDIA_RELEASE_IDENTITY_KEYS[@]}"; do
    printf '%s=%s\n' "$release_key" "${JOY_MEDIA_RELEASE_IDENTITY[$release_key]}" >>"$temp_file"
  done
  chmod --reference="$base_env_file" "$temp_file"
  chown --reference="$base_env_file" "$temp_file"
  mv -Tf -- "$temp_file" "$destination_file"
}

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
  for attempt in $(seq 1 45); do
    if curl --fail --silent --show-error --max-time 3 "$endpoint" >/dev/null; then
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
