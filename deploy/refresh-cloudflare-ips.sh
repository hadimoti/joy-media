#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
OUTPUT_FILE="${JOY_MEDIA_CLOUDFLARE_IPS_FILE:-$SCRIPT_DIR/cloudflare-ips.txt}"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/joy-cloudflare-ips.XXXXXX")"
trap 'rm -rf -- "$TEMP_DIR"' EXIT

curl --fail --silent --show-error --max-time 20 https://www.cloudflare.com/ips-v4 -o "$TEMP_DIR/ips-v4"
curl --fail --silent --show-error --max-time 20 https://www.cloudflare.com/ips-v6 -o "$TEMP_DIR/ips-v6"
FETCHED_AT="$(date -u +%Y-%m-%dT%H:%MZ)"

python3 - "$TEMP_DIR/ips-v4" "$TEMP_DIR/ips-v6" "$TEMP_DIR/cloudflare-ips.txt" "$FETCHED_AT" <<'PYEOF'
import ipaddress
import sys

v4_path, v6_path, output_path, fetched_at = sys.argv[1:]
entries = []
for path, family in ((v4_path, 4), (v6_path, 6)):
    with open(path, encoding="utf-8-sig") as source:
        for line_number, raw in enumerate(source, 1):
            value = raw.strip()
            if not value or value.startswith("#"):
                continue
            try:
                network = ipaddress.ip_network(value, strict=True)
            except ValueError as error:
                raise SystemExit(f"Invalid CIDR at {path}:{line_number}: {error}")
            if network.version != family:
                raise SystemExit(f"Wrong address family at {path}:{line_number}")
            entries.append(str(network))
if not entries or not any(":" not in item for item in entries) or not any(":" in item for item in entries):
    raise SystemExit("Both IPv4 and IPv6 Cloudflare CIDR lists must be non-empty")
with open(output_path, "w", encoding="utf-8", newline="\n") as output:
    output.write("# Source: https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6\n")
    output.write(f"# Fetched: {fetched_at} by deploy/refresh-cloudflare-ips.sh\n")
    output.writelines(f"{entry}\n" for entry in entries)
PYEOF

mv -f -- "$TEMP_DIR/cloudflare-ips.txt" "$OUTPUT_FILE"
echo "Updated Cloudflare CIDRs in $OUTPUT_FILE"
