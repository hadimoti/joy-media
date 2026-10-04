#!/usr/bin/env bash
set -Eeuo pipefail

# Patch only the joyst.ir TLS server's agent location. The shared file also
# contains unrelated sites, so preserve every other server block byte-for-byte.
CONF_FILE="${JOY_MEDIA_NGINX_CONF:-/etc/nginx/conf.d/joy-wg-bot.conf}"
CA_FILE="${JOY_MEDIA_CA_FILE:-${NODE_EXTRA_CA_CERTS:-/etc/ssl/joyst/origincertificate.pem}}"
EDGE_ADDR="${JOY_MEDIA_EDGE_ADDR:-}"
BACKUP_DIR="${JOY_MEDIA_NGINX_BACKUP_DIR:-$(dirname -- "$CONF_FILE")}"

die() {
  echo "apply-nginx-cutover: $*" >&2
  exit 1
}

if [[ "${EUID:-$(id -u)}" -ne 0 && !( "${JOY_DEPLOY_TEST_MODE:-}" == 1 && "${JOY_DEPLOY_TEST_ROOT_OK:-}" == 1 ) ]]; then
  die "must run as root on Sweden VPS (test override requires JOY_DEPLOY_TEST_MODE=1 and JOY_DEPLOY_TEST_ROOT_OK=1)"
fi
[[ -f "$CONF_FILE" ]] || die "Nginx config not found: $CONF_FILE"
[[ -f "$CA_FILE" ]] || die "CA file missing: $CA_FILE (set JOY_MEDIA_CA_FILE)"
[[ -n "$EDGE_ADDR" ]] || die "JOY_MEDIA_EDGE_ADDR is required (IPv4 or IPv6 literal)"

EDGE_ADDR="$(python3 - "$EDGE_ADDR" <<'PYEOF'
import ipaddress, sys
try:
    print(ipaddress.ip_address(sys.argv[1].strip("[]")))
except ValueError:
    sys.exit(1)
PYEOF
)" || die "JOY_MEDIA_EDGE_ADDR must be an IP literal"
EDGE_RESOLVE="$EDGE_ADDR"
if [[ "$EDGE_ADDR" == *:* ]]; then EDGE_RESOLVE="[$EDGE_ADDR]"; fi

mkdir -p -- "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/$(basename -- "$CONF_FILE").pre-agent-location-${TIMESTAMP}"
cp -p "$CONF_FILE" "$BACKUP_FILE"

restore() {
  echo "Restoring backup from $BACKUP_FILE" >&2
  cp -p "$BACKUP_FILE" "$CONF_FILE"
  nginx -t && systemctl reload nginx || true
}

if ! python3 - "$CONF_FILE" <<'PYEOF'
import re, sys
path = sys.argv[1]
with open(path, encoding="utf-8", newline="") as source:
    text = source.read()

def matching_brace(source, opening):
    depth, quote, escaped, comment = 0, None, False, False
    for index in range(opening, len(source)):
        char = source[index]
        if comment:
            if char == "\n": comment = False
            continue
        if quote:
            if escaped: escaped = False
            elif char == "\\": escaped = True
            elif char == quote: quote = None
            continue
        if char == "#": comment = True
        elif char in ("'", '"'): quote = char
        elif char == "{": depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0: return index + 1
    return -1

def server_blocks(source):
    found = []
    for match in re.finditer(r"(?m)^\s*server\s*\{", source):
        opening = source.find("{", match.start())
        end = matching_brace(source, opening)
        if end < 0: raise ValueError("Unclosed Nginx server block")
        found.append((match.start(), end, source[match.start():end]))
    return found

replacement = '''    location ~ ^/api/v1/agent(?:/|$) {
        rewrite ^/api/(.*)$ /$1 break;
        proxy_pass http://127.0.0.1:8790;
        proxy_http_version 1.1;
        proxy_set_header Connection "";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 90;
        proxy_send_timeout 90;
    }'''

def location_blocks(server):
    for match in re.finditer(r"(?m)^\s*location\s+([^\n{]+)\{", server):
        opening = server.find("{", match.start())
        end = matching_brace(server, opening)
        if end < 0: raise ValueError("Unclosed joyst.ir location")
        yield match.start(), end, match.group(1).strip(), server[match.start():end]

def drop_agent_alternation(line):
    match = re.search(r"\(\?:([^)]*)\)\(\?:/\|\$\)", line)
    if not match: return line
    members = match.group(1).split("|")
    if "agent" not in members: return line
    remaining = [member for member in members if member != "agent"]
    if not remaining: return None
    return line[:match.start(1)] + "|".join(remaining) + line[match.end(1):]

def strip_agent_locations(server):
    result = server
    for start, end, header, block in reversed(list(location_blocks(result))):
        dedicated = re.match(r"~\s+\^/api/v1/agent\(\?:/\|\$\)", header)
        changed_header = drop_agent_alternation(header)
        if dedicated or (changed_header is None and "agent" in header):
            if end < len(result) and result[end] == "\n": end += 1
            result = result[:start] + result[end:]
        elif changed_header != header:
            result = result[:start] + block.replace(header, changed_header, 1) + result[end:]
    return result

def normalized_target(server):
    result = strip_agent_locations(server)
    return re.sub(r"\n[ \t]*\n+", "\n", result)

try:
    before = server_blocks(text)
    target_index = None
    for index, (_, _, block) in enumerate(before):
        names = re.findall(r"(?m)^\s*server_name\s+([^;]+);", block)
        listens = re.findall(r"(?m)^\s*listen\s+([^;]+);", block)
        is_joyst = any("joyst.ir" in name.split() for name in names)
        is_tls = any(re.search(r"(?:^|\s)(?:\[[^]]+\]|[0-9.]+|\*):443(?:\s|$)|(?:^|\s)443(?:\s|$)", item) for item in listens)
        if is_joyst and is_tls:
            target_index = index
            break
    if target_index is None: raise ValueError("Could not find joyst.ir TLS server block")

    block_start, block_end, target = before[target_index]
    changed_target = strip_agent_locations(target)

    # Nginx selects the first matching regex in file order. Put the dedicated
    # agent rule before every regex location, including unrelated broad ones.
    regex_location = re.search(r"(?m)^\s*location\s+~\*?\s+", changed_target)
    if regex_location:
        insertion = regex_location.start()
    else:
        generic = re.search(r"(?m)^\s*location\s+(?:\^~\s+)?/api/[^\n]*\{", changed_target)
        insertion = generic.start() if generic else changed_target.rfind("}")
    if insertion < 0: raise ValueError("Unclosed joyst.ir server block")
    changed_target = changed_target[:insertion] + replacement + "\n" + changed_target[insertion:]

    patched = text[:block_start] + changed_target + text[block_end:]
    after = server_blocks(patched)
    if len(before) != len(after): raise ValueError("Server block count changed")
    for index, ((_, _, old), (_, _, new)) in enumerate(zip(before, after)):
        if index != target_index and old != new:
            raise ValueError("A non-joyst.ir server block changed")
    protected = re.compile(r"(?m)^\s*(?:listen|server_name|ssl_certificate(?:_key)?)\s+[^;\n]*;")
    if protected.findall(target) != protected.findall(after[target_index][2]):
        raise ValueError("joyst.ir listen/server_name/ssl_certificate directives changed")
    if normalized_target(target) != normalized_target(after[target_index][2]):
        raise ValueError("joyst.ir changes exceed the agent location and combined regex edit")
    with open(path, "w", encoding="utf-8", newline="") as destination:
        destination.write(patched)
except (ValueError, StopIteration) as error:
    sys.stderr.write(str(error) + "\n")
    sys.exit(1)
PYEOF
then
  restore
  die "failed to patch only the joyst.ir agent location"
fi

if ! nginx -t; then
  restore
  die "Nginx syntax test failed; prior config restored"
fi
if ! systemctl reload nginx; then
  restore
  die "Nginx reload failed; prior config restored"
fi

check_probe() {
  local path="$1" expected="$2" code
  code="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --max-time 20 --cacert "$CA_FILE" --resolve "joyst.ir:443:$EDGE_RESOLVE" \
    "https://joyst.ir$path")" || { restore; die "probe failed: $path"; }
  [[ "$code" == "$expected" ]] || { restore; die "probe $path expected $expected, received $code"; }
  echo "PROBE_OK $path -> $code"
}

check_probe "/api/health" "200"
check_probe "/ready" "200"
check_probe "/api/v1/projects" "404"
check_probe "/api/v1/media" "404"
check_probe "/api/v1/jobs" "404"
echo "Nginx agent location applied and verified; backup: $BACKUP_FILE"
