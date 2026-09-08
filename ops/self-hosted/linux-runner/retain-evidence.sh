#!/usr/bin/env bash
# Snapshot the real-service acceptance evidence out of the workspace BEFORE the
# next job's `git clean -ffdx` wipes it, and redact literal secret values.
#
# Usage: retain-evidence.sh <source-test-output-dir> <dest-evidence-dir>
#
# Runs on success AND failure — a failed effects soak or a non-clean teardown is
# exactly when this evidence must survive. Never exits non-zero for a missing
# source (there may be nothing to keep); only a genuine copy error fails it.
set -uo pipefail

src=${1:?source test-output dir required}
dest=${2:?destination evidence dir required}

# Literal secret values to scrub from every retained text file.
SECRET_VARS=(
  JOY_MEDIA_CI_S3_ACCESS_KEY
  JOY_MEDIA_CI_S3_SECRET_KEY
  JOY_MEDIA_CI_DATABASE_URL
  JOY_MEDIA_CI_S3_ENDPOINT
  JOY_MEDIA_CI_S3_HEALTHCHECK_URL
  JOY_MEDIA_RELEASE_OBSERVER_TOKEN
)

rm -rf -- "$dest"
mkdir -p "$dest"

if [ -d "$src" ]; then
  cp -a "$src" "$dest/test-output" || { echo "retain-evidence: copy failed" >&2; exit 1; }
fi

{
  echo "collected_at=$(date -u +%FT%TZ)"
  echo "run_id=${GITHUB_RUN_ID:-} attempt=${GITHUB_RUN_ATTEMPT:-} pass=${JOY_MEDIA_EVIDENCE_PASS:-}"
} > "$dest/context.txt"
git status --porcelain=v1 > "$dest/git-status.txt" 2>&1 || true
git rev-parse HEAD > "$dest/candidate-sha.txt" 2>&1 || true

# Redact. `perl \Q..\E` matches the value literally; name/value come from the
# environment so shell metacharacters in either are irrelevant.
while IFS= read -r -d '' file; do
  for var in "${SECRET_VARS[@]}"; do
    value=${!var:-}
    [ -n "$value" ] || continue
    JM_RV="$value" JM_RN="$var" perl -0777 -pi -e \
      's/\Q$ENV{JM_RV}\E/<redacted:$ENV{JM_RN}>/g' "$file" 2>/dev/null || true
  done
done < <(find "$dest" -type f -print0)

echo "retain-evidence: kept the following under $dest"
find "$dest" -type f | sort
