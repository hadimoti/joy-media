#!/usr/bin/env bash
set -Eeuo pipefail

cd /opt/actions-runner

if [[ ! -f .runner ]]; then
  : "${RUNNER_TOKEN:?RUNNER_TOKEN is required only for first-time registration}"
  : "${RUNNER_NAME:?RUNNER_NAME is required only for first-time registration}"
  : "${RUNNER_LABELS:?RUNNER_LABELS is required only for first-time registration}"
  ./config.sh \
    --unattended \
    --url "https://github.com/hadimoti/joy-media" \
    --token "$RUNNER_TOKEN" \
    --name "$RUNNER_NAME" \
    --labels "$RUNNER_LABELS" \
    --work _work \
    --replace
fi

if [[ "${1:-}" == "--configure-only" ]]; then
  exit 0
fi

exec ./run.sh
