#!/usr/bin/env bash
# Durably retain the real-service acceptance evidence for one pass.
#
# Usage: retain-evidence.sh <workspace-root> <staging-dir> <persistent-root>
#
#   workspace-root   the job checkout (contains test-output/)
#   staging-dir      a scratch dir this script builds and hands to upload-artifact
#   persistent-root  a location OUTSIDE the checkout and OUTSIDE _work/_temp that
#                    survives the next job's `git clean` (e.g. the runner install
#                    dir). REQUIRED — a run with nowhere durable to keep evidence
#                    must fail, not silently proceed.
#
# What it does:
#   1. Copies ONLY an explicit allowlist of structured evidence JSON.
#   2. Redacts literal / base64 / percent-encoded secret values, Bearer headers,
#      presigned-URL signature params, and `scheme://user:pass@`.
#   3. Leak-guards: any staged file still matching a literal/base64 secret is
#      quarantined (removed + recorded) so a leak is never retained or uploaded.
#   4. Writes MANIFEST.sha256 + MANIFEST.json (path, bytes, sha256 per file).
#   5. Copies the staged tree to
#        <persistent-root>/<candidateSha>/<runId>-<attempt>-p<pass>/
#      and RE-VERIFIES every file there against the manifest (read back, re-hash).
#      A checksum mismatch or a missing persistent copy fails the script.
#
# Exit non-zero => the pass fails. Missing durable evidence is a gate failure.
set -uo pipefail

ws=${1:?workspace root required}
staging=${2:?staging dir required}
persist_root=${3:-}

CANDIDATE_SHA=$( (cd "$ws" && git rev-parse --verify --quiet HEAD) 2>/dev/null || true )
[ -n "$CANDIDATE_SHA" ] || CANDIDATE_SHA=unknown
case "$CANDIDATE_SHA" in *[!0-9a-fA-F]*) CANDIDATE_SHA=unknown ;; esac
if [ "$CANDIDATE_SHA" != unknown ] && [ ${#CANDIDATE_SHA} -ne 40 ]; then
  echo "retain-evidence: WARNING — resolved candidate sha '$CANDIDATE_SHA' is ${#CANDIDATE_SHA} chars, not 40; the workflow verify step keys the path off the 40-char input and may not find this dir" >&2
fi
RUN=${GITHUB_RUN_ID:-local}
ATTEMPT=${GITHUB_RUN_ATTEMPT:-1}
PASS=${JOY_MEDIA_EVIDENCE_PASS:-0}

if [ -z "$persist_root" ]; then
  echo "retain-evidence: FATAL — no persistent-root given (set JOY_MEDIA_CI_EVIDENCE_ROOT on the runner)" >&2
  exit 2
fi
mkdir -p "$persist_root" 2>/dev/null || true
if [ ! -d "$persist_root" ] || [ ! -w "$persist_root" ]; then
  echo "retain-evidence: FATAL — persistent-root not a writable directory: $persist_root" >&2
  exit 2
fi
case "$persist_root" in
  *"/_work/"* | *"/_temp/"* | "$ws"/*)
    echo "retain-evidence: FATAL — persistent-root is inside the checkout / _work / _temp: $persist_root" >&2
    exit 2 ;;
esac

# Redaction ENGINE must be present. A redaction pass that cannot run must fail
# the gate, not silently pass unsanitized evidence through.
command -v perl >/dev/null || { echo 'retain-evidence: FATAL — perl (redaction engine) not found' >&2; exit 2; }
command -v sha256sum >/dev/null || { echo 'retain-evidence: FATAL — sha256sum not found' >&2; exit 2; }

# Secret VALUES the harness holds and could (in principle) write. Only vars that
# are actually in THIS step's environment can be redacted by value; the generic
# post-redaction guard below covers Bearer / presigned / basic-auth shapes and
# runtime-generated tokens regardless.
SECRET_VARS=(
  JOY_MEDIA_CI_S3_ACCESS_KEY
  JOY_MEDIA_CI_S3_SECRET_KEY
  JOY_MEDIA_CI_S3_SECRET_ACCESS_KEY
  JOY_MEDIA_CI_DATABASE_URL
  JOY_MEDIA_CI_S3_ENDPOINT
  JOY_MEDIA_CI_S3_HEALTHCHECK_URL
)

# Explicit allowlist — structured, harness-authored JSON only.
ALLOW=(
  test-output/browser/journeys.json
  test-output/browser/authenticated-editor-1.0/journey-evidence.json
  test-output/browser/real-service-profile-matrix.json
  test-output/browser/journey-failure.json
  test-output/browser/web-dev-server.log
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

rm -rf -- "$staging"
mkdir -p "$staging/test-output"

copied=0
for rel in "${ALLOW[@]}"; do
  src="$ws/$rel"
  [ -f "$src" ] || continue
  mkdir -p "$staging/$(dirname "$rel")"
  cp -- "$src" "$staging/$rel" || { echo "retain-evidence: copy failed for $rel" >&2; exit 1; }
  copied=$((copied + 1))
done

{
  echo "collected_at=$(date -u +%FT%TZ)"
  echo "candidate_sha=$CANDIDATE_SHA"
  echo "run_id=$RUN attempt=$ATTEMPT pass=$PASS"
  echo "files_copied=$copied"
} > "$staging/context.txt"
( cd "$ws" && git status --porcelain=v1 | cut -c1-60 ) > "$staging/git-status.txt" 2>/dev/null || true

b64() { printf '%s' "$1" | base64 -w0 2>/dev/null || printf '%s' "$1" | base64; }
urlenc() {
  local s=$1 o= c i h
  for ((i = 0; i < ${#s}; i++)); do
    c=${s:i:1}
    case "$c" in
      [a-zA-Z0-9.~_-]) o+="$c" ;;
      *) printf -v h '%%%02X' "'$c"; o+="$h" ;;
    esac
  done
  printf '%s' "$o"
}

# A single perl invocation applies every rule. `perl` failing (missing module,
# uncompilable regex after an edit, I/O error) exits non-zero -> the whole
# script fails (no `|| true`). Secret VALUES come from the environment as
# JM_V_0..N so shell metacharacters in them are irrelevant.
redact_file() {
  local f=$1 var value i=0
  local -a env_assign perl_rules
  for var in "${SECRET_VARS[@]}"; do
    value=${!var:-}
    [ -n "$value" ] || continue
    env_assign+=("JM_V_${i}=${value}" "JM_B_${i}=$(b64 "$value")" "JM_U_${i}=$(urlenc "$value")" "JM_N_${i}=${var}")
    perl_rules+=(
      "s/\\Q\$ENV{JM_V_${i}}\\E/<redacted:\$ENV{JM_N_${i}}>/g;"
      "s/\\Q\$ENV{JM_B_${i}}\\E/<redacted:\$ENV{JM_N_${i}}:b64>/g;"
      "s/\\Q\$ENV{JM_U_${i}}\\E/<redacted:\$ENV{JM_N_${i}}:url>/gi;"
    )
    i=$((i + 1))
  done
  # Generic credential shapes — independent of which vars are in scope.
  perl_rules+=(
    's/(?i)(authorization"?\s*[:=]\s*"?\s*Bearer\s+)[A-Za-z0-9._~+\/=-]+/$1<redacted:bearer>/g;'
    's/(?i)(Bearer\s+)[A-Za-z0-9._~+\/=-]{12,}/$1<redacted:bearer>/g;'
    's/(?i)((?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|Expires)=)[^&"'"'"'\s]+/$1<redacted:presign>/g;'
    's/([a-z][a-z0-9+.\-]*:\/\/)[^\/\s:@"]+:[^\/\s@"]+@/$1<redacted:userinfo>@/gi;'
  )
  env "${env_assign[@]}" perl -0777 -pi -e "${perl_rules[*]}" "$f"
}
while IFS= read -r -d '' f; do redact_file "$f"; done < <(find "$staging" -type f -print0)

# Leak guard — quarantine any staged file still carrying a secret in ANY of the
# tracked forms (literal / base64 / url-encoded) or an obvious credential shape.
quarantined=0
quarantine() {
  local hit=$1 why=$2
  echo "retain-evidence: LEAK GUARD ($why) in ${hit#"$staging"/} — quarantining" >&2
  echo "${hit#"$staging"/}: $why after redaction" >> "$staging/REDACTION-FAILURES.txt"
  rm -f -- "$hit"
  quarantined=$((quarantined + 1))
}
for var in "${SECRET_VARS[@]}"; do
  value=${!var:-}
  [ -n "$value" ] || continue
  for needle in "$value" "$(b64 "$value")" "$(urlenc "$value")"; do
    [ ${#needle} -ge 8 ] || continue
    while IFS= read -r -d '' hit; do quarantine "$hit" "still contained $var"; done \
      < <(grep -rlF --null -- "$needle" "$staging" 2>/dev/null)
  done
done
# Residual credential shapes the value-scan cannot see (runtime tokens etc.).
while IFS= read -r -d '' hit; do quarantine "$hit" "unredacted Bearer/presigned/basic-auth shape"; done \
  < <(grep -rlZ -E -e 'Bearer [A-Za-z0-9._~+/=-]{16,}' -e 'X-Amz-Signature=[A-Za-z0-9%]{16,}' -e '://[^/[:space:]:@"]+:[^/[:space:]@"]+@' "$staging" 2>/dev/null)

# Manifest (sha256 + JSON), computed over what actually remains after quarantine.
( cd "$staging" && find . -type f ! -name MANIFEST.sha256 ! -name MANIFEST.json -print0 \
    | sort -z | xargs -0 sha256sum ) > "$staging/MANIFEST.sha256"
{
  printf '{\n  "schemaVersion": 1,\n  "candidateSha": "%s",\n  "runId": "%s",\n  "attempt": "%s",\n  "pass": "%s",\n' \
    "$CANDIDATE_SHA" "$RUN" "$ATTEMPT" "$PASS"
  printf '  "generatedAt": "%s",\n  "redactionApplied": true,\n  "quarantinedCount": %s,\n  "files": [\n' \
    "$(date -u +%FT%TZ)" "$quarantined"
  first=1
  while read -r sum path; do
    rel=${path#\./}
    bytes=$(wc -c < "$staging/$rel" | tr -d ' ')
    [ $first -eq 1 ] || printf ',\n'
    first=0
    printf '    { "path": "%s", "bytes": %s, "sha256": "%s" }' "$rel" "$bytes" "$sum"
  done < "$staging/MANIFEST.sha256"
  printf '\n  ]\n}\n'
} > "$staging/MANIFEST.json"

# Persist OUTSIDE the checkout, uniquely keyed, then re-verify against the manifest.
dest="$persist_root/$CANDIDATE_SHA/${RUN}-${ATTEMPT}-p${PASS}"
rm -rf -- "$dest"
mkdir -p "$dest"
cp -a "$staging/." "$dest/" || { echo "retain-evidence: persist copy failed -> $dest" >&2; exit 1; }

if ! ( cd "$dest" && sha256sum -c --quiet MANIFEST.sha256 ); then
  echo "retain-evidence: FATAL — persistent evidence failed checksum verification" >&2
  exit 1
fi

echo "retain-evidence: staged $copied file(s), $quarantined quarantined; persisted + checksum-verified at:"
echo "  $dest"
find "$dest" -type f | sort
