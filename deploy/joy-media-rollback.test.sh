#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ROLLBACK_SCRIPT="$SCRIPT_DIR/joy-media-rollback.sh"
IDENTITY_SCRIPT="$SCRIPT_DIR/joy-media-release-identity.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  [[ "$expected" == "$actual" ]] || fail "$message (expected '$expected', got '$actual')"
}

assert_contains() {
  local needle="$1"
  local file="$2"
  grep -F -- "$needle" "$file" >/dev/null || fail "missing '$needle' in $file"
}

assert_not_contains() {
  local needle="$1"
  local file="$2"
  if grep -F -- "$needle" "$file" >/dev/null; then
    fail "unexpected '$needle' in $file"
  fi
}

create_identity() {
  local destination="$1"
  local tag="$2"
  local commit_digit tree_digit lock_digit
  commit_digit="$(( tag % 10 ))"
  tree_digit="$(( (tag + 1) % 10 ))"
  lock_digit="$(( (tag + 2) % 10 ))"
  bash "$IDENTITY_SCRIPT" write \
    "$destination" \
    "$(printf "%0.s$commit_digit" $(seq 1 40))" \
    "$(printf "%0.s$tree_digit" $(seq 1 40))" \
    "$(printf "%0.s$lock_digit" $(seq 1 64))" \
    "$tag"
}

setup_fixture() {
  FIXTURE_ROOT="$(mktemp -d)"
  API_ROOT="$FIXTURE_ROOT/releases"
  WEB_ROOT="$FIXTURE_ROOT/web-releases"
  mkdir -p "$API_ROOT/release-a/dist" "$API_ROOT/release-b/dist" "$WEB_ROOT/web-a" "$WEB_ROOT/web-b"
  printf 'server-a\n' >"$API_ROOT/release-a/dist/server.js"
  printf 'server-b\n' >"$API_ROOT/release-b/dist/server.js"
  printf '<html>a</html>\n' >"$WEB_ROOT/web-a/index.html"
  printf '<html>b</html>\n' >"$WEB_ROOT/web-b/index.html"
  create_identity "$API_ROOT/release-a/release-identity.env" 3
  create_identity "$API_ROOT/release-b/release-identity.env" 7

  CURRENT_API_LINK="$API_ROOT/current-api"
  CURRENT_WEB_LINK="$FIXTURE_ROOT/web"

  API_ENV_FILE="$FIXTURE_ROOT/api.env"
  cat >"$API_ENV_FILE" <<'EOF'
# secrets stay put
JOY_MEDIA_DATABASE_URL=postgres://secret
JOY_MEDIA_SMTP_PASS=hidden
JOY_MEDIA_RELEASE_COMMIT_SHA=ffffffffffffffffffffffffffffffffffffffff
JOY_MEDIA_RELEASE_TREE_HASH=eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee
JOY_MEDIA_RELEASE_LOCKFILE_SHA256=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
JOY_MEDIA_RELEASE_SCHEMA_VERSION=99
EOF

  LOG_DIR="$FIXTURE_ROOT/logs"
  BIN_DIR="$FIXTURE_ROOT/bin"
  mkdir -p "$LOG_DIR" "$BIN_DIR"

  cat >"$BIN_DIR/systemctl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'systemctl %s\n' "$*" >>"$JOY_MEDIA_TEST_LOG_DIR/commands.log"
if [[ "${JOY_MEDIA_TEST_FAIL_RESTART:-0}" == "1" && "${1:-}" == "restart" ]]; then
  exit 1
fi
EOF
  cat >"$BIN_DIR/nginx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'nginx %s\n' "$*" >>"$JOY_MEDIA_TEST_LOG_DIR/commands.log"
EOF
  cat >"$BIN_DIR/curl" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
endpoint="${@: -1}"
printf 'curl %s\n' "$endpoint" >>"$JOY_MEDIA_TEST_LOG_DIR/commands.log"
EOF
  cat >"$BIN_DIR/sleep" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
exit 0
EOF
  chmod +x "$BIN_DIR/systemctl" "$BIN_DIR/nginx" "$BIN_DIR/curl" "$BIN_DIR/sleep"
}

run_rollback() {
  env \
    PATH="$BIN_DIR:$PATH" \
    JOY_MEDIA_TEST_LOG_DIR="$LOG_DIR" \
    JOY_MEDIA_API_RELEASE_ROOT="$API_ROOT" \
    JOY_MEDIA_WEB_RELEASE_ROOT="$WEB_ROOT" \
    JOY_MEDIA_CURRENT_API_LINK="$CURRENT_API_LINK" \
    JOY_MEDIA_CURRENT_WEB_LINK="$CURRENT_WEB_LINK" \
    JOY_MEDIA_API_ENV_FILE="$API_ENV_FILE" \
    JOY_MEDIA_API_SYSTEMD_UNIT="joy-media@test" \
    JOY_MEDIA_API_LOCAL_ORIGIN="http://127.0.0.1:18790" \
    bash "$ROLLBACK_SCRIPT" "$@"
}

test_apply_switches_symlinks_and_release_identity() {
  setup_fixture
  local before_env_stat
  before_env_stat="$(stat -c '%a:%u:%g' "$API_ENV_FILE")"
  run_rollback --apply "$API_ROOT/release-a" "$WEB_ROOT/web-a"

  assert_eq "server-a" "$(tr -d '\r\n' <"$CURRENT_API_LINK/dist/server.js")" "api active path should point at release-a"
  assert_eq "<html>a</html>" "$(tr -d '\r\n' <"$CURRENT_WEB_LINK/index.html")" "web active path should point at web-a"

  assert_contains "JOY_MEDIA_DATABASE_URL=postgres://secret" "$API_ENV_FILE"
  assert_contains "JOY_MEDIA_SMTP_PASS=hidden" "$API_ENV_FILE"
  assert_contains "JOY_MEDIA_RELEASE_SCHEMA_VERSION=3" "$API_ENV_FILE"
  assert_not_contains "JOY_MEDIA_RELEASE_SCHEMA_VERSION=99" "$API_ENV_FILE"
  assert_eq "$before_env_stat" "$(stat -c '%a:%u:%g' "$API_ENV_FILE")" "api env mode and owner should be preserved"
  assert_contains "systemctl restart joy-media@test" "$LOG_DIR/commands.log"
  assert_contains "systemctl reload nginx" "$LOG_DIR/commands.log"
  assert_contains "nginx -t" "$LOG_DIR/commands.log"
  assert_contains "curl http://127.0.0.1:18790/live" "$LOG_DIR/commands.log"
  assert_contains "curl http://127.0.0.1:18790/ready" "$LOG_DIR/commands.log"

  rm -rf "$FIXTURE_ROOT"
}

test_dry_run_leaves_state_untouched() {
  setup_fixture
  local before_env
  before_env="$(cat "$API_ENV_FILE")"

  run_rollback --dry-run "$API_ROOT/release-a" "$WEB_ROOT/web-a"

  assert_eq "$before_env" "$(cat "$API_ENV_FILE")" "dry run should not rewrite api env"
  [[ ! -e "$CURRENT_API_LINK" ]] || fail "dry run should not create api link"
  [[ ! -e "$CURRENT_WEB_LINK" ]] || fail "dry run should not create web link"
  if [[ -f "$LOG_DIR/commands.log" ]]; then
    fail "dry run should not call external commands"
  fi

  rm -rf "$FIXTURE_ROOT"
}

test_missing_release_identity_fails_closed() {
  setup_fixture
  local before_env
  before_env="$(cat "$API_ENV_FILE")"
  rm -f "$API_ROOT/release-a/release-identity.env"
  if run_rollback --dry-run "$API_ROOT/release-a" "$WEB_ROOT/web-a"; then
    fail "missing release identity should fail"
  fi
  assert_eq "$before_env" "$(cat "$API_ENV_FILE")" "missing release identity should not rewrite api env"
  [[ ! -e "$CURRENT_API_LINK" ]] || fail "missing release identity should not create api link"
  [[ ! -e "$CURRENT_WEB_LINK" ]] || fail "missing release identity should not create web link"
  if [[ -f "$LOG_DIR/commands.log" ]]; then
    fail "missing release identity should not call external commands"
  fi
  rm -rf "$FIXTURE_ROOT"
}

test_invalid_release_identity_fails_closed() {
  setup_fixture
  local before_env
  before_env="$(cat "$API_ENV_FILE")"
  cat >"$API_ROOT/release-a/release-identity.env" <<'EOF'
JOY_MEDIA_RELEASE_COMMIT_SHA=not-a-sha
JOY_MEDIA_RELEASE_TREE_HASH=1111111111111111111111111111111111111111
JOY_MEDIA_RELEASE_LOCKFILE_SHA256=2222222222222222222222222222222222222222222222222222222222222222
JOY_MEDIA_RELEASE_SCHEMA_VERSION=3
EOF
  if run_rollback --apply "$API_ROOT/release-a" "$WEB_ROOT/web-a"; then
    fail "invalid release identity should fail"
  fi
  assert_eq "$before_env" "$(cat "$API_ENV_FILE")" "invalid release identity should not rewrite api env"
  [[ ! -e "$CURRENT_API_LINK" ]] || fail "invalid release identity should not create api link"
  [[ ! -e "$CURRENT_WEB_LINK" ]] || fail "invalid release identity should not create web link"
  if [[ -f "$LOG_DIR/commands.log" ]]; then
    fail "invalid release identity should not call external commands"
  fi
  rm -rf "$FIXTURE_ROOT"
}

test_failed_restart_restores_previous_state() {
  setup_fixture
  local before_env
  before_env="$(cat "$API_ENV_FILE")"
  if env JOY_MEDIA_TEST_FAIL_RESTART=1 \
    PATH="$BIN_DIR:$PATH" \
    JOY_MEDIA_TEST_LOG_DIR="$LOG_DIR" \
    JOY_MEDIA_API_RELEASE_ROOT="$API_ROOT" \
    JOY_MEDIA_WEB_RELEASE_ROOT="$WEB_ROOT" \
    JOY_MEDIA_CURRENT_API_LINK="$CURRENT_API_LINK" \
    JOY_MEDIA_CURRENT_WEB_LINK="$CURRENT_WEB_LINK" \
    JOY_MEDIA_API_ENV_FILE="$API_ENV_FILE" \
    JOY_MEDIA_API_SYSTEMD_UNIT="joy-media@test" \
    JOY_MEDIA_API_LOCAL_ORIGIN="http://127.0.0.1:18790" \
    bash "$ROLLBACK_SCRIPT" --apply "$API_ROOT/release-a" "$WEB_ROOT/web-a"; then
    fail "restart failure should fail the rollback"
  fi
  assert_eq "$before_env" "$(cat "$API_ENV_FILE")" "restart failure should restore api env"
  [[ ! -e "$CURRENT_API_LINK" ]] || fail "restart failure should restore absent api link"
  [[ ! -e "$CURRENT_WEB_LINK" ]] || fail "restart failure should restore absent web link"
  assert_contains "systemctl restart joy-media@test" "$LOG_DIR/commands.log"
  rm -rf "$FIXTURE_ROOT"
}

test_apply_switches_symlinks_and_release_identity
test_dry_run_leaves_state_untouched
test_missing_release_identity_fails_closed
test_invalid_release_identity_fails_closed
test_failed_restart_restores_previous_state
echo "PASS: joy-media rollback rehearsal"
