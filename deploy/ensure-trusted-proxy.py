#!/usr/bin/env python3
"""Ensure the API trusts the local Nginx hop in a staged api.env file.

The file is a systemd EnvironmentFile. Every assignment of the key (with any
surrounding whitespace or quotes) is merged into one unquoted line at the
first assignment's position, keeping that line's ending. The API refuses to
start unless the list holds at most 64 exact IP literals, so anything else
fails here, before the release is switched, and the file is left unchanged.
"""

from pathlib import Path
import ipaddress
import re
import sys


KEY = "JOY_MEDIA_TRUSTED_PROXY_ADDRESSES"
LOOPBACK = "127.0.0.1"
MAX_ADDRESSES = 64  # MAX_TRUSTED_PROXY_ADDRESSES in apps/api/src/client-address.ts
ASSIGNMENT = re.compile(r"^[ \t]*" + re.escape(KEY) + r"[ \t]*=(?P<value>.*?)(?P<ending>\r?\n|\r)?$", re.S)


def fail(message: str) -> None:
    raise SystemExit(f"ensure-trusted-proxy: {KEY} {message}")


def unquote(value: str) -> str:
    value = value.strip()
    if value[:1] in ("'", '"'):
        if len(value) < 2 or value[-1] != value[0]:
            fail("has an unbalanced quote")
        value = value[1:-1].strip()
    return value


def canonical(address: str) -> str:
    if "%" in address or "/" in address:
        fail(f"must list exact IP literals, not {address!r}")
    try:
        return str(ipaddress.ip_address(address))
    except ValueError:
        fail(f"must list exact IP literals, not {address!r}")
    raise AssertionError("unreachable")


def main(path: Path) -> None:
    content = path.read_bytes().decode("utf-8")
    lines = content.splitlines(keepends=True)
    matches = [(index, ASSIGNMENT.match(line)) for index, line in enumerate(lines)]
    matches = [(index, match) for index, match in matches if match]

    addresses: dict[str, str] = {}
    for _, match in matches:
        for item in unquote(match.group("value")).split(","):
            item = item.strip()
            if item:
                addresses.setdefault(canonical(item), item)
    addresses.setdefault(canonical(LOOPBACK), LOOPBACK)
    if len(addresses) > MAX_ADDRESSES:
        fail(f"would list {len(addresses)} addresses; the API accepts at most {MAX_ADDRESSES}")
    value = f"{KEY}={','.join(addresses.values())}"

    if matches:
        first_index, first_match = matches[0]
        lines[first_index] = value + (first_match.group("ending") or "\n")
        for index, _ in reversed(matches[1:]):
            del lines[index]
    else:
        ending = "\r\n" if lines and lines[0].endswith("\r\n") else "\n"
        if lines and not lines[-1].endswith(("\n", "\r")):
            lines[-1] += ending
        lines.append(value + ending)

    path.write_bytes("".join(lines).encode("utf-8"))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: ensure-trusted-proxy.py <staged-api-env>")
    main(Path(sys.argv[1]))
