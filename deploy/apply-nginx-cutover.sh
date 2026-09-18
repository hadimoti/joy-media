#!/usr/bin/env bash
set -Eeuo pipefail

# apply-nginx-cutover.sh: Apply lean boundary to joyst.ir in /etc/nginx/conf.d/joy-wg-bot.conf
# Wave 6: Reduce joyst.ir edge surface to auth, account, entitlements, releases, billing, and agent.

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
CONF_FILE="/etc/nginx/conf.d/joy-wg-bot.conf"
TARGET_CONF="$SCRIPT_DIR/joy-media-account-web.nginx.conf"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_FILE="${CONF_FILE}.pre-cutover-${TIMESTAMP}"

die() {
  echo "apply-nginx-cutover: $*" >&2
  exit 1
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must run as root on Sweden VPS"
[[ -f "$CONF_FILE" ]] || die "Nginx config not found: $CONF_FILE"
[[ -f "$TARGET_CONF" ]] || die "Target template not found: $TARGET_CONF"

echo "Backing up $CONF_FILE to $BACKUP_FILE"
cp -p "$CONF_FILE" "$BACKUP_FILE"

restore() {
  echo "Restoring backup from $BACKUP_FILE"
  cp -p "$BACKUP_FILE" "$CONF_FILE"
  systemctl reload nginx || true
}

python3 - "$CONF_FILE" "$TARGET_CONF" <<'PYEOF'
import sys

conf_path = sys.argv[1]
target_path = sys.argv[2]

with open(conf_path, "r", encoding="utf-8") as f:
    content = f.read()

with open(target_path, "r", encoding="utf-8") as f:
    target_content = f.read()

marker = "server_name joyst.ir www.joyst.ir;"
if marker not in content:
    sys.stderr.write("Could not find joyst.ir in " + conf_path + "\n")
    sys.exit(1)

# Find joyst.ir server block in existing conf
idx_marker = content.find(marker)
idx_start = content.rfind("server {", 0, idx_marker)
if idx_start == -1:
    sys.stderr.write("Could not find server block start for joyst.ir\n")
    sys.exit(1)

depth = 0
idx_end = -1
for i in range(idx_start, len(content)):
    if content[i] == '{':
        depth += 1
    elif content[i] == '}':
        depth -= 1
        if depth == 0:
            idx_end = i + 1
            break

if idx_end == -1:
    sys.stderr.write("Could not find server block end for joyst.ir\n")
    sys.exit(1)

# Extract joyst.ir server block from target template
t_marker = "server_name joyst.ir www.joyst.ir;"
t_idx_marker = target_content.find(t_marker)
t_idx_start = target_content.rfind("server {", 0, t_idx_marker)
depth = 0
t_idx_end = -1
for i in range(t_idx_start, len(target_content)):
    if target_content[i] == '{':
        depth += 1
    elif target_content[i] == '}':
        depth -= 1
        if depth == 0:
            t_idx_end = i + 1
            break

if t_idx_end == -1:
    sys.stderr.write("Could not find target block in " + target_path + "\n")
    sys.exit(1)

replacement_block = target_content[t_idx_start:t_idx_end]

new_content = content[:idx_start] + replacement_block + content[idx_end:]
with open(conf_path, "w", encoding="utf-8") as f:
    f.write(new_content)

print("Updated /etc/nginx/conf.d/joy-wg-bot.conf with lean cutover boundary")
PYEOF

echo "Testing Nginx configuration syntax..."
if ! nginx -t; then
  echo "Nginx syntax test FAILED! Rolling back..." >&2
  restore
  exit 1
fi

echo "Nginx syntax OK. Reloading nginx service..."
systemctl reload nginx

echo "Running probe verifications against local edge..."
sleep 1

check_probe() {
  local url="$1"
  local expected="$2"
  local code
  code="$(curl -k -s -o /dev/null -w "%{http_code}" "$url" -H "Host: joyst.ir")"
  if [[ "$code" != "$expected" ]]; then
    echo "PROBE_FAIL $url expected $expected got $code" >&2
    restore
    exit 1
  fi
  echo "PROBE_OK $url -> $code"
}

check_probe "https://127.0.0.1/api/health" "200"
check_probe "https://127.0.0.1/ready" "200"
check_probe "https://127.0.0.1/api/v1/projects" "404"
check_probe "https://127.0.0.1/api/v1/media" "404"
check_probe "https://127.0.0.1/api/v1/jobs" "404"

echo "Nginx lean cutover boundary applied and verified successfully!"
