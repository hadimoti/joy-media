#!/usr/bin/env bash
set -euo pipefail

# Switch both immutable JOY Media pointers back to one previously verified
# release. The default is a dry run; --apply is required for a live switch.
# Usage: joy-media-rollback.sh [--dry-run|--apply] <release-directory>

MODE="dry-run"
if [[ "${1:-}" == "--apply" || "${1:-}" == "--dry-run" ]]; then
  MODE="${1#--}"
  shift
fi

if [[ "$#" -ne 1 ]]; then
  echo "usage: $0 [--dry-run|--apply] <release-directory>" >&2
  exit 2
fi

ROOT="/opt/joy-media/releases"
TARGET="$1"
CURRENT_API="$ROOT/current-api"
WEB="$ROOT/web"

resolve_release() {
  local candidate="$1" resolved
  resolved="$(readlink -f -- "$candidate")"
  case "$resolved" in
    "$ROOT"/*) ;;
    *) echo "release is outside $ROOT: $candidate" >&2; exit 1 ;;
  esac
  [[ -d "$resolved" ]] || { echo "release directory missing: $resolved" >&2; exit 1; }
  [[ "$resolved" != "$ROOT" ]] || { echo "release root is not a release" >&2; exit 1; }
  printf '%s\n' "$resolved"
}

TARGET_RELEASE="$(resolve_release "$TARGET")"
[[ -d "$TARGET_RELEASE/dist" ]] || { echo "API dist missing: $TARGET_RELEASE/dist" >&2; exit 1; }
[[ -f "$TARGET_RELEASE/dist/server.js" ]] || { echo "API entrypoint missing" >&2; exit 1; }

echo "rollback target: $TARGET_RELEASE"
echo "current-api: $CURRENT_API"
echo "web: $WEB"
echo "mode: $MODE"

if [[ "$MODE" != "apply" ]]; then
  exit 0
fi

TMP_API="$ROOT/.current-api.rollback.$$"
TMP_WEB="$ROOT/.web.rollback.$$"
cleanup() { rm -f -- "$TMP_API" "$TMP_WEB"; }
trap cleanup EXIT

ln -s -- "$TARGET_RELEASE" "$TMP_API"
ln -s -- "$TARGET_RELEASE" "$TMP_WEB"
mv -Tf -- "$TMP_API" "$CURRENT_API"
mv -Tf -- "$TMP_WEB" "$WEB"

systemctl restart joy-media@api
nginx -t
systemctl reload nginx
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8790/live >/dev/null
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8790/ready >/dev/null
echo "rollback complete"
