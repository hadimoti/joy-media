#!/usr/bin/env bash
set -Eeuo pipefail

# apply-nginx-cutover.sh: Apply lean boundary to joyst.ir in /etc/nginx/conf.d/joy-wg-bot.conf
# Wave 6: Reduce joyst.ir edge surface to auth, account, entitlements, releases, and billing.

CONF_FILE="/etc/nginx/conf.d/joy-wg-bot.conf"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_FILE="${CONF_FILE}.pre-cutover-${TIMESTAMP}"

die() {
  echo "apply-nginx-cutover: $*" >&2
  exit 1
}

[[ "${EUID:-$(id -u)}" -eq 0 ]] || die "must run as root on Sweden VPS"
[[ -f "$CONF_FILE" ]] || die "Nginx config not found: $CONF_FILE"

echo "Backing up $CONF_FILE to $BACKUP_FILE"
cp -p "$CONF_FILE" "$BACKUP_FILE"

restore() {
  echo "Restoring backup from $BACKUP_FILE"
  cp -p "$BACKUP_FILE" "$CONF_FILE"
  systemctl reload nginx || true
}

# Python helper to perform surgical block replacement
python3 - <<'PYEOF'
import sys

conf_path = "/etc/nginx/conf.d/joy-wg-bot.conf"
with open(conf_path, "r", encoding="utf-8") as f:
    content = f.read()

# Locate the server block for joyst.ir
marker = "server_name joyst.ir www.joyst.ir;"
if marker not in content:
    sys.stderr.write("Could not find joyst.ir server block\n")
    sys.exit(1)

# 1. Update client_max_body_size from 1200m to 10m in the joyst.ir block
parts = content.split(marker)
before_marker = parts[0]
after_marker = parts[1]

# In after_marker, replace the first client_max_body_size 1200m; with 10m;
after_marker = after_marker.replace("client_max_body_size 1200m;", "client_max_body_size 10m;", 1)

# 2. Replace the api proxy block with the narrowed cutover proxy block
target_old_api = """    location /api/ {
        proxy_pass http://127.0.0.1:8790/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180;
        proxy_send_timeout 180;
    }

    location = /api/health {
        proxy_pass http://127.0.0.1:8790/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }"""

replacement_api = """    # Narrowed from "proxy everything" to exactly the surfaces wave 4/5 kept:
    # OTP auth, devices, account, entitlements, release metadata, and USDC billing.
    location ~ ^/api/v1/(?:auth|devices|account|entitlements|releases|billing)(?:/|$) {
        rewrite ^/api/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 180;
        proxy_send_timeout 180;
    }

    location = /api/health {
        proxy_pass http://127.0.0.1:8790/health;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }

    location = /live {
        proxy_pass http://127.0.0.1:8790/live;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }

    location = /ready {
        proxy_pass http://127.0.0.1:8790/ready;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }

    location = /health/ready {
        proxy_pass http://127.0.0.1:8790/health/ready;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        access_log off;
    }

    # Catch-all: all other /api/ paths are 404 at the edge
    location /api/ {
        return 404;
    }"""

if target_old_api not in after_marker:
    sys.stderr.write("Could not find target api block in joyst.ir section\n")
    sys.exit(1)

after_marker = after_marker.replace(target_old_api, replacement_api, 1)

new_content = before_marker + marker + after_marker
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
