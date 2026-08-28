#!/usr/bin/env bash
set -euo pipefail

# Switch both immutable JOY Media pointers back to previously verified API and
# web releases. The default is a dry run; --apply is required for a live switch.
# Usage: joy-media-rollback.sh [--dry-run|--apply] <api-release> <web-release>

MODE="dry-run"
if [[ "${1:-}" == "--apply" || "${1:-}" == "--dry-run" ]]; then
  MODE="${1#--}"
  shift
fi

if [[ "$#" -ne 2 ]]; then
  echo "usage: $0 [--dry-run|--apply] <api-release> <web-release>" >&2
  exit 2
fi

API_ROOT="/opt/joy-media/releases"
WEB_ROOT="/opt/joy-media/web-releases"
API_TARGET="$1"
WEB_TARGET="$2"
CURRENT_API="$API_ROOT/current-api"
WEB="/opt/joy-media/web"

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

echo "API rollback target: $API_RELEASE"
echo "web rollback target: $WEB_RELEASE"
echo "current-api: $CURRENT_API"
echo "web: $WEB"
echo "mode: $MODE"

if [[ "$MODE" != "apply" ]]; then
  exit 0
fi

TMP_API="$API_ROOT/.current-api.rollback.$$"
TMP_WEB="$WEB_ROOT/.web.rollback.$$"
cleanup() { rm -f -- "$TMP_API" "$TMP_WEB"; }
trap cleanup EXIT

ln -s -- "$API_RELEASE" "$TMP_API"
ln -s -- "$WEB_RELEASE" "$TMP_WEB"
mv -Tf -- "$TMP_API" "$CURRENT_API"
mv -Tf -- "$TMP_WEB" "$WEB"

systemctl restart joy-media@api
nginx -t
systemctl reload nginx
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8790/live >/dev/null
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:8790/ready >/dev/null
echo "rollback complete"
