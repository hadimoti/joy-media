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

# S3 bucket names must be DNS-compatible; keep the same run/pass uniqueness
# while avoiding underscores, which MinIO rejects as invalid bucket names.
namespace="joy-${run_id}-${run_attempt}-${pass}"
schema="ci_${run_id}_${run_attempt}_${pass}"
bucket="joy-media-${namespace}"
tmp_dir=$(mktemp -d)
mc_config=$(mktemp -d)

cleanup() {
  local exit_code=$?
  export MC_CONFIG_DIR="$mc_config"
  mc alias set joy-ci "$JOY_MEDIA_CI_S3_ENDPOINT" "$JOY_MEDIA_CI_S3_ACCESS_KEY" "$JOY_MEDIA_CI_S3_SECRET_KEY" --api S3v4 >/dev/null 2>&1 || true
  mc rm --quiet --recursive --force "joy-ci/$bucket" >/dev/null 2>&1 || true
  mc rb --quiet "joy-ci/$bucket" >/dev/null 2>&1 || true
  unset MC_CONFIG_DIR
  PGOPTIONS="" psql "$JOY_MEDIA_CI_DATABASE_URL" -v ON_ERROR_STOP=1 -c "DROP SCHEMA IF EXISTS \"$schema\" CASCADE" >/dev/null 2>&1 || true
  rm -rf -- "$tmp_dir" "$mc_config"
  exit "$exit_code"
}

trap cleanup EXIT

psql "$JOY_MEDIA_CI_DATABASE_URL" -v ON_ERROR_STOP=1 -c "CREATE SCHEMA \"$schema\"" >/dev/null

# Run the real migration code inside the unique PostgreSQL schema.
export PGOPTIONS="-c search_path=$schema,public"
node ops/self-hosted/linux-runner/real-service-smoke.mjs
unset PGOPTIONS

export MC_CONFIG_DIR="$mc_config"
mc alias set joy-ci "$JOY_MEDIA_CI_S3_ENDPOINT" "$JOY_MEDIA_CI_S3_ACCESS_KEY" "$JOY_MEDIA_CI_S3_SECRET_KEY" --api S3v4 >/dev/null
mc mb --quiet "joy-ci/$bucket"
printf '%s\n' "$candidate_sha" > "$tmp_dir/candidate.sha"
mc cp --quiet "$tmp_dir/candidate.sha" "joy-ci/$bucket/provenance/candidate.sha"
mc stat --quiet "joy-ci/$bucket/provenance/candidate.sha" >/dev/null
mc rm --quiet --recursive --force "joy-ci/$bucket" >/dev/null
mc rb --quiet "joy-ci/$bucket" >/dev/null
unset MC_CONFIG_DIR

echo "real-services pass $pass verified and cleaned (namespace $namespace)"
