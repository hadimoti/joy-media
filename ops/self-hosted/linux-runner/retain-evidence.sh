#!/usr/bin/env bash
# Snapshot the real-service acceptance evidence out of the workspace BEFORE the
# next job's `git clean -ffdx` wipes it, sanitize it, and stage it for artifact
# upload.
#
# Usage: retain-evidence.sh <workspace-root> <dest-evidence-dir>
#
# Only an EXPLICIT allowlist of structured evidence files is copied — never a
# blanket `cp -a test-output`. Each copied text file is then scrubbed of:
#   - literal secret values (env), plus their base64 and percent-encoded forms
#   - `Authorization: Bearer …` headers
#   - presigned-URL signature params (X-Amz-Signature / Signature / Credential /
#     Security-Token)
#   - `scheme://user:pass@host` credentials
# A final guard re-scans the staged tree for any surviving literal/base64 secret
# and QUARANTINES (removes + records) any file that still matches, so a leak is
# never uploaded.
#
# Runs on success AND failure. Never exits non-zero for missing inputs (a failed
# pass may not have produced every file); only a real copy error fails it.
set -uo pipefail

ws=${1:?workspace root required}
dest=${2:?destination evidence dir required}

SECRET_VARS=(
  JOY_MEDIA_CI_S3_ACCESS_KEY
  JOY_MEDIA_CI_S3_SECRET_KEY
  JOY_MEDIA_CI_DATABASE_URL
  JOY_MEDIA_CI_S3_ENDPOINT
  JOY_MEDIA_CI_S3_HEALTHCHECK_URL
  JOY_MEDIA_RELEASE_OBSERVER_TOKEN
  JOY_MEDIA_CI_S3_SECRET_ACCESS_KEY
)

# Explicit allowlist — structured evidence only, all harness-authored JSON.
ALLOW=(
  test-output/browser/journeys.json
  test-output/browser/authenticated-editor-1.0/journey-evidence.json
  test-output/browser/real-service-profile-matrix.json
  test-output/release-performance/polling.json
  test-output/release-performance/effects-soak.json
  test-output/release-performance/timeline-integrity.json
  test-output/release-performance/editor.json
  test-output/delivery/result.json
  test-output/operations/restore.json
  test-output/operations/teardown.json
  test-output/ci-janitor/inventory.json
  test-output/windows/acceptance.json
)

rm -rf -- "$dest"
mkdir -p "$dest/test-output"

copied=0
for rel in "${ALLOW[@]}"; do
  src="$ws/$rel"
  [ -f "$src" ] || continue
  mkdir -p "$dest/$(dirname "$rel")"
  cp -- "$src" "$dest/$rel" || { echo "retain-evidence: copy failed for $rel" >&2; exit 1; }
  copied=$((copied + 1))
done

{
  echo "collected_at=$(date -u +%FT%TZ)"
  echo "run_id=${GITHUB_RUN_ID:-} attempt=${GITHUB_RUN_ATTEMPT:-} pass=${JOY_MEDIA_EVIDENCE_PASS:-}"
  echo "files_copied=$copied"
} > "$dest/context.txt"
( cd "$ws" && git rev-parse HEAD ) > "$dest/candidate-sha.txt" 2>/dev/null || true
# filenames only, no diff content
( cd "$ws" && git status --porcelain=v1 | cut -c1-3,4- ) > "$dest/git-status.txt" 2>/dev/null || true

b64() { printf '%s' "$1" | base64 -w0 2>/dev/null || printf '%s' "$1" | base64; }
urlenc() { local s=$1 o= c i; for ((i=0;i<${#s};i++)); do c=${s:i:1}
  case "$c" in [a-zA-Z0-9.~_-]) o+="$c";; *) printf -v h '%%%02X' "'$c"; o+="$h";; esac; done; printf '%s' "$o"; }

redact_file() {
  local f=$1 var val
  for var in "${SECRET_VARS[@]}"; do
    val=${!var:-}
    [ -n "$val" ] || continue
    JM_V="$val"           JM_N="$var"        perl -0777 -pi -e 's/\Q$ENV{JM_V}\E/<redacted:$ENV{JM_N}>/g'          "$f" 2>/dev/null || true
    JM_V="$(b64 "$val")"  JM_N="$var:b64"    perl -0777 -pi -e 's/\Q$ENV{JM_V}\E/<redacted:$ENV{JM_N}>/g'          "$f" 2>/dev/null || true
    JM_V="$(urlenc "$val")" JM_N="$var:url"  perl -0777 -pi -e 's/\Q$ENV{JM_V}\E/<redacted:$ENV{JM_N}>/gi'         "$f" 2>/dev/null || true
  done
  perl -0777 -pi -e 's/(?i)(authorization"?\s*[:=]\s*"?\s*Bearer\s+)[A-Za-z0-9._~+\/=-]+/$1<redacted>/g'            "$f" 2>/dev/null || true
  perl -0777 -pi -e 's/(?i)(Bearer\s+)[A-Za-z0-9._~+\/=-]{12,}/$1<redacted>/g'                                     "$f" 2>/dev/null || true
  perl -0777 -pi -e 's/(?i)((?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature)=)[^&"'"'"'\s]+/$1<redacted>/g' "$f" 2>/dev/null || true
  perl -0777 -pi -e 's/([a-z][a-z0-9+.\-]*:\/\/)[^\/\s:@"]+:[^\/\s@"]+@/$1<redacted>@/gi'                          "$f" 2>/dev/null || true
}

while IFS= read -r -d '' f; do redact_file "$f"; done < <(find "$dest" -type f -print0)

# Final leak guard: quarantine any staged file that STILL contains a literal or
# base64 secret value. Never upload a leak.
quarantined=0
for var in "${SECRET_VARS[@]}"; do
  val=${!var:-}
  [ -n "$val" ] || continue
  for needle in "$val" "$(b64 "$val")"; do
    [ ${#needle} -ge 8 ] || continue
    while IFS= read -r -d '' hit; do
      echo "retain-evidence: LEAK GUARD tripped for $var in ${hit#$dest/} — quarantining" >&2
      echo "${hit#$dest/}: still contained $var after redaction" >> "$dest/REDACTION-FAILURES.txt"
      rm -f -- "$hit"
      quarantined=$((quarantined + 1))
    done < <(grep -rlF --null -- "$needle" "$dest" 2>/dev/null)
  done
done

echo "retain-evidence: staged $copied file(s) under $dest ($quarantined quarantined)"
find "$dest" -type f | sort
