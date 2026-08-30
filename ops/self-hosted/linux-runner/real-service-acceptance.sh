#!/usr/bin/env bash
set -Eeuo pipefail

candidate_sha=${1:-}
run_id=${2:-}
run_attempt=${3:-}
pass=${4:-}

[[ "$candidate_sha" =~ ^[0-9a-f]{40}$ ]] || { echo 'candidate SHA is invalid' >&2; exit 1; }
[[ "$run_id" =~ ^[0-9]+$ ]] || { echo 'run id is invalid' >&2; exit 1; }
[[ "$run_attempt" =~ ^[0-9]+$ ]] || { echo 'run attempt is invalid' >&2; exit 1; }
[[ "$pass" =~ ^[12]$ ]] || { echo 'pass must be 1 or 2' >&2; exit 1; }
[[ "$(git rev-parse HEAD)" == "$candidate_sha" ]] || { echo 'checkout is not the requested candidate' >&2; exit 1; }

: "${JOY_MEDIA_CI_DATABASE_URL:?JOY_MEDIA_CI_DATABASE_URL is required}"
: "${JOY_MEDIA_CI_S3_ENDPOINT:?JOY_MEDIA_CI_S3_ENDPOINT is required}"
: "${JOY_MEDIA_CI_S3_ACCESS_KEY:?JOY_MEDIA_CI_S3_ACCESS_KEY is required}"
: "${JOY_MEDIA_CI_S3_SECRET_KEY:?JOY_MEDIA_CI_S3_SECRET_KEY is required}"

node ops/self-hosted/linux-runner/real-service-acceptance.mjs \
  "$candidate_sha" "$run_id" "$run_attempt" "$pass"
