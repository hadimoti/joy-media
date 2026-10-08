#!/usr/bin/env bash
set -Eeuo pipefail

# Patch only the joyst.ir TLS server's agent location. The shared file also
# contains unrelated sites, so preserve every other server block byte-for-byte.
CONF_FILE="${JOY_MEDIA_NGINX_CONF:-/etc/nginx/conf.d/joy-wg-bot.conf}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
IPS_FILE="${JOY_MEDIA_CLOUDFLARE_IPS_FILE:-$SCRIPT_DIR/cloudflare-ips.txt}"
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
[[ -f "$IPS_FILE" ]] || die "Cloudflare IP list not found: $IPS_FILE"
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
# This host's addresses: EDGE_ADDR must be one of them or a joyst.ir listen address,
# because it is added to the Cloudflare-only allow-list as a self-probe source.
LOCAL_ADDRS="$( (ip -o addr show 2>/dev/null || true) | awk '{print $4}' | tr '\n' ' ')"

mkdir -p -- "$BACKUP_DIR"
TIMESTAMP="$(date +%Y%m%d%H%M%S)"
BACKUP_FILE="$BACKUP_DIR/$(basename -- "$CONF_FILE").pre-agent-location-${TIMESTAMP}"
cp -p "$CONF_FILE" "$BACKUP_FILE"

restore() {
  echo "Restoring backup from $BACKUP_FILE" >&2
  cp -p "$BACKUP_FILE" "$CONF_FILE"
  nginx -t && systemctl reload nginx || true
}

if ! python3 - "$CONF_FILE" "$IPS_FILE" "$EDGE_ADDR" "$LOCAL_ADDRS" <<'PYEOF'
import re, sys
import ipaddress
path = sys.argv[1]
ips_path = sys.argv[2]
edge_addr = ipaddress.ip_address(sys.argv[3])
local_addrs = set()
for token in sys.argv[4].split():
    try:
        local_addrs.add(ipaddress.ip_interface(token).ip)
    except ValueError:
        pass
with open(path, encoding="utf-8", newline="") as source:
    text = source.read()
with open(ips_path, encoding="utf-8-sig") as source:
    ranges = []
    for line_number, raw in enumerate(source, 1):
        value = raw.strip()
        if not value or value.startswith("#"):
            continue
        try:
            network = ipaddress.ip_network(value, strict=True)
        except ValueError as error:
            raise ValueError(f"Invalid Cloudflare CIDR at {ips_path}:{line_number}: {error}")
        # Every trusted range may set the client address, so a typo such as
        # 0.0.0.0/0 or a private range would let anyone spoof CF-Connecting-IP.
        # Floors: /12 (IPv4), one step wider than Cloudflare's broadest /13, and /29 (IPv6).
        if network.prefixlen < {4: 12, 6: 29}[network.version] or not network.is_global:
            raise ValueError(f"Refusing over-broad or non-public Cloudflare CIDR at {ips_path}:{line_number}: {network}")
        ranges.append(str(network))
if not ranges:
    raise ValueError("Cloudflare IP list contains no CIDRs")

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
    for match in re.finditer(r"(?m)^[ \t]*server\s*\{", source):
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
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_buffering off;
        proxy_cache off;
        gzip off;
        proxy_read_timeout 90;
        proxy_send_timeout 90;
    }'''

def location_blocks(server):
    for match in re.finditer(r"(?m)^[ \t]*location\s+([^\n{]+)\{", server):
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

BEGIN_REALIP = "# BEGIN joy-media realip (managed)"
END_REALIP = "# END joy-media realip (managed)"

def attached_comment_start(source, index):
    # Comment lines directly above a location (blank lines allowed) describe it;
    # insert managed content above them instead of between comment and location.
    start = pos = index
    while pos > 0:
        line_start = source.rfind("\n", 0, pos - 1) + 1
        line = source[line_start:pos - 1].strip()
        if line.startswith("#") and not line.startswith(("# BEGIN joy-media", "# END joy-media")):
            start = line_start
        elif line:
            break
        pos = line_start
    return start

def strip_marked(source, begin, end):
    # Drops a managed block and the blank line inserted after it.
    pattern = re.compile(r"(?m)^[ \t]*" + re.escape(begin) + r"\n[\s\S]*?^[ \t]*" + re.escape(end) + r"(?:\n[ \t]*(?=\n))?\n?")
    return pattern.sub("", source)

def strip_managed_realip(server):
    return strip_marked(server, BEGIN_REALIP, END_REALIP)

# Cloudflare-only origin (OL-1). real_ip rewrites $remote_addr from CF-Connecting-IP,
# so the allow list is keyed on $realip_remote_addr: the TCP peer, which a client
# cannot forge. Everything that is not a Cloudflare edge or this host is closed (444).
BEGIN_GEO = "# BEGIN joy-media cloudflare-only geo (managed)"
END_GEO = "# END joy-media cloudflare-only geo (managed)"
BEGIN_CF_ONLY = "# BEGIN joy-media cloudflare-only (managed)"
END_CF_ONLY = "# END joy-media cloudflare-only (managed)"
CF_ONLY = (
    "    " + BEGIN_CF_ONLY + "\n"
    "    # Close connections that did not arrive from a Cloudflare edge or this host.\n"
    "    if ($joy_media_from_cloudflare = 0) {\n"
    "        return 444;\n"
    "    }\n"
    "    " + END_CF_ONLY + "\n"
)

def strip_cf_only(server):
    return strip_marked(server, BEGIN_CF_ONLY, END_CF_ONLY)

def listen_addresses(server):
    found = []
    for item in re.findall(r"(?m)^\s*listen\s+([^;]+);", server):
        token = item.split()[0]
        match = re.match(r"^\[([^\]]+)\](?::\d+)?$", token) or re.match(r"^(\d+\.\d+\.\d+\.\d+)(?::\d+)?$", token)
        if not match: continue
        address = ipaddress.ip_address(match.group(1))
        if not address.is_unspecified: found.append(address)
    return found

def geo_block(server):
    networks = [ipaddress.ip_network(item) for item in ranges]
    # Deploy probes run on the origin and connect to the edge address (normally the
    # joyst.ir listen address), so that address is also their source.
    own = [ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1"), *listen_addresses(server), edge_addr]
    own = [address for address in dict.fromkeys(own) if not any(address in network for network in networks)]
    lines = [BEGIN_GEO,
             "# 1 for Cloudflare edges (deploy/cloudflare-ips.txt) and this host's own probes.",
             "# Keyed on the TCP peer, never on the client address rewritten from CF-Connecting-IP.",
             "geo $realip_remote_addr $joy_media_from_cloudflare {",
             "    default 0;"]
    lines += [f"    {network} 1;" for network in ranges]
    lines += ["    # origin self-probes: loopback, joyst.ir listen address, deploy edge address"]
    lines += [f"    {address} 1;" for address in own]
    lines += ["}", END_GEO]
    return "\n".join(lines) + "\n\n"

def is_joyst_block(block):
    names = re.findall(r"(?m)^\s*server_name\s+([^;]+);", block)
    return any(name in ("joyst.ir", "www.joyst.ir") for entry in names for name in entry.split())

def add_cf_only_after_names(server):
    # For a joyst.ir block without the realip section (e.g. a plain :80 redirect).
    server = strip_cf_only(server)
    names = list(re.finditer(r"(?m)^[ \t]*server_name\s+[^;\n]*;[^\n]*\n", server))
    if not names: raise ValueError("joyst.ir block without server_name")
    insertion = names[-1].end()
    return server[:insertion] + CF_ONLY + server[insertion:]

def outside_servers(source):
    # Everything outside server blocks, without the managed geo.
    result, position = [], 0
    for start, end, _ in server_blocks(source):
        result.append(source[position:start]); position = end
    result.append(source[position:])
    return strip_marked("\x00".join(result), BEGIN_GEO, END_GEO)

def strip_internal_deny(server):
    for start, end, header, block in reversed(list(location_blocks(server))):
        if header == "/internal/" and re.search(r"(?m)^\s*return\s+404\s*;\s*$", block):
            if end < len(server) and server[end] == "\n": end += 1
            server = server[:start] + server[end:]
    return server

def expand_single_line(block):
    # "location = /x { a; b; }" -> one directive per line, so headers can be inserted.
    if "\n" in block:
        return block
    opening, closing = block.index("{"), block.rindex("}")
    indent = re.match(r"^[ \t]*", block).group(0)
    directives = [item.strip() for item in block[opening + 1:closing].split(";") if item.strip()]
    body = "".join(f"{indent}    {item};\n" for item in directives)
    return block[:opening + 1].rstrip() + "\n" + body + indent + "}"

API_UPSTREAM = re.compile(r"(?m)^[^#\n]*\bproxy_pass\s+http://127\.0\.0\.1:8790[/;]")

def canonicalize_proxy_headers(server):
    # Every location that reaches the API (including health/readiness probes)
    # replaces any client-supplied X-Forwarded-For/X-Real-IP with the peer.
    for start, end, header, block in reversed(list(location_blocks(server))):
        if not ("/api/v1/agent" in header or re.search(r"auth\|devices\|account\|entitlements\|releases\|billing", header) or API_UPSTREAM.search(block)):
            continue
        lines = expand_single_line(block).splitlines()
        output = []
        added = False
        for line in lines[:-1]:
            if re.match(r"^[ \t]*proxy_set_header X-(?:Forwarded-For|Real-IP)\s+", line):
                continue
            output.append(line)
            if re.match(r"^[ \t]*proxy_set_header Host\s+", line):
                indent = re.match(r"^[ \t]*", line).group(0)
                output.extend((indent + "proxy_set_header X-Real-IP $remote_addr;", indent + "proxy_set_header X-Forwarded-For $remote_addr;"))
                added = True
        if not added:
            close_indent = re.match(r"^[ \t]*", lines[-1]).group(0)
            indent = close_indent + "    "
            output.extend((indent + "proxy_set_header X-Real-IP $remote_addr;", indent + "proxy_set_header X-Forwarded-For $remote_addr;"))
        output.append(lines[-1])
        body = "\n".join(output)
        server = server[:start] + body + server[end:]
    return server

def normalized_target(server):
    result = strip_agent_locations(server)
    result = strip_managed_realip(result)
    result = strip_cf_only(result)
    result = strip_internal_deny(result)
    result = canonicalize_proxy_headers(result)
    result = re.sub(r"(?m)^[ \t]+$", "", result)
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
    # EDGE_ADDR joins the Cloudflare-only allow-list, so it must really be this host.
    joyst_listens = {address for _, _, block in before if is_joyst_block(block) for address in listen_addresses(block)}
    if edge_addr not in joyst_listens and edge_addr not in local_addrs:
        raise ValueError(
            f"JOY_MEDIA_EDGE_ADDR {edge_addr} is neither a joyst.ir listen address nor an address of this host; "
            "refusing to add it to the Cloudflare-only allow-list")
    changed_target = strip_cf_only(strip_managed_realip(strip_agent_locations(target)))
    changed_target = strip_internal_deny(changed_target)

    managed = "    # BEGIN joy-media realip (managed)\n"
    managed += "    # CF-Connecting-IP is authoritative because only Cloudflare CIDRs are trusted.\n"
    managed += "".join(f"    set_real_ip_from {network};\n" for network in ranges)
    managed += "    real_ip_header CF-Connecting-IP;\n    # END joy-media realip (managed)\n"
    managed += CF_ONLY + "\n"
    first_location = re.search(r"(?m)^[ \t]*location\s+", changed_target)
    insertion = attached_comment_start(changed_target, first_location.start()) if first_location else changed_target.rfind("}")
    if insertion < 0: raise ValueError("Unclosed joyst.ir server block")
    prefix = changed_target[:insertion].rstrip(" \t\r\n") + "\n"
    changed_target = prefix + managed + changed_target[insertion:]

    # Nginx selects the first matching regex in file order. Put the dedicated
    # agent rule before every regex location, including unrelated broad ones.
    regex_location = re.search(r"(?m)^[ \t]*location\s+~\*?\s+", changed_target)
    if regex_location:
        insertion = attached_comment_start(changed_target, regex_location.start())
    else:
        generic = re.search(r"(?m)^[ \t]*location\s+(?:\^~\s+)?/api/[^\n]*\{", changed_target)
        insertion = attached_comment_start(changed_target, generic.start()) if generic else changed_target.rfind("}")
    if insertion < 0: raise ValueError("Unclosed joyst.ir server block")
    changed_target = changed_target[:insertion] + replacement + "\n" + changed_target[insertion:]

    # The public server never proxies diagnostics; only direct loopback smoke can reach the API route.
    deny_internal = "    location /internal/ {\n        return 404;\n    }\n"
    api_prefix = re.search(r"(?m)^[ \t]*location\s+/api/\s*\{", changed_target)
    if api_prefix:
        insertion = attached_comment_start(changed_target, api_prefix.start())
        changed_target = changed_target[:insertion] + deny_internal + changed_target[insertion:]
    else:
        server_close = changed_target.rfind("}")
        changed_target = changed_target[:server_close] + deny_internal + changed_target[server_close:]
    changed_target = canonicalize_proxy_headers(changed_target)

    joyst_indexes = [index for index, (_, _, block) in enumerate(before) if is_joyst_block(block)]
    patched = text
    for index in reversed(range(len(before))):
        start, end, block = before[index]
        if index == target_index:
            patched = patched[:start] + changed_target + patched[end:]
        elif index in joyst_indexes:
            patched = patched[:start] + add_cf_only_after_names(block) + patched[end:]
    patched = strip_marked(patched, BEGIN_GEO, END_GEO)
    first_joyst = server_blocks(patched)[joyst_indexes[0]][0]
    insertion = attached_comment_start(patched, first_joyst)
    patched = patched[:insertion] + geo_block(target) + patched[insertion:]

    after = server_blocks(patched)
    if len(before) != len(after): raise ValueError("Server block count changed")
    for index, ((_, _, old), (_, _, new)) in enumerate(zip(before, after)):
        if index in joyst_indexes and index != target_index:
            if strip_cf_only(old) != strip_cf_only(new):
                raise ValueError("A joyst.ir server block changed beyond the managed Cloudflare-only lock")
        elif index != target_index and old != new:
            raise ValueError("A non-joyst.ir server block changed")
    if outside_servers(text) != outside_servers(patched):
        raise ValueError("Text outside server blocks changed beyond the managed geo")
    if patched.count(BEGIN_GEO) != 1 or after[target_index][2].count("return 444;") != 1:
        raise ValueError("Cloudflare-only lock was not applied exactly once")
    protected = re.compile(r"(?m)^\s*(?:listen|server_name|ssl_certificate(?:_key)?)\s+[^;\n]*;")
    if protected.findall(target) != protected.findall(after[target_index][2]):
        raise ValueError("joyst.ir listen/server_name/ssl_certificate directives changed")
    if normalized_target(target) != normalized_target(after[target_index][2]):
        raise ValueError("joyst.ir changes exceed the managed realip/internal/agent edits")
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

# Probes from this host are allowed, so prove the lock from a loopback source that
# is not (only 127.0.0.1 and ::1 are): nginx must close the connection (444).
check_refused() {
  if [[ "$EDGE_ADDR" == *:* ]]; then
    echo "CF_ONLY_PROBE_SKIPPED (IPv6 edge address; no second loopback source)"
    return 0
  fi
  local code rc=0
  code="$(curl --silent --output /dev/null --write-out '%{http_code}' --max-time 20 \
    --cacert "$CA_FILE" --interface 127.0.0.2 --resolve "joyst.ir:80:$EDGE_ADDR" \
    "http://joyst.ir/api/health")" || rc=$?
  if [[ "$rc" -eq 52 ]]; then
    echo "CF_ONLY_OK non-Cloudflare source refused (444)"
  elif [[ "$rc" -eq 0 ]]; then
    restore
    die "non-Cloudflare source received HTTP $code; Cloudflare-only lock is not effective; prior config restored"
  elif [[ "${JOY_MEDIA_ACCEPT_INCONCLUSIVE_CF_PROBE:-}" == 1 ]]; then
    echo "CF_ONLY_PROBE_INCONCLUSIVE (curl exit $rc); accepted by JOY_MEDIA_ACCEPT_INCONCLUSIVE_CF_PROBE=1, check from outside Cloudflare by hand" >&2
  else
    restore
    die "CF_ONLY_PROBE_INCONCLUSIVE (curl exit $rc): the Cloudflare-only lock could not be proven; prior config restored. Check from outside Cloudflare, then rerun with JOY_MEDIA_ACCEPT_INCONCLUSIVE_CF_PROBE=1 to accept"
  fi
}
check_refused
echo "Nginx agent location applied and verified; backup: $BACKUP_FILE"
