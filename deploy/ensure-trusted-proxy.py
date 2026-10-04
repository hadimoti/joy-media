#!/usr/bin/env python3
"""Ensure the API trusts the local Nginx hop in a staged api.env file."""

from pathlib import Path
import sys


KEY = "JOY_MEDIA_TRUSTED_PROXY_ADDRESSES"
LOOPBACK = "127.0.0.1"


def main(path: Path) -> None:
    content = path.read_text(encoding="utf-8")
    lines = content.splitlines(keepends=True)
    matches = [index for index, line in enumerate(lines) if line.partition("=")[0] == KEY]

    if matches:
        addresses = []
        for index in matches:
            value = lines[index].partition("=")[2].strip()
            addresses.extend(item.strip() for item in value.split(",") if item.strip())
        if LOOPBACK not in addresses:
            addresses.append(LOOPBACK)
        replacement = f"{KEY}={','.join(dict.fromkeys(addresses))}\n"
        first = matches[0]
        lines[first] = replacement
        for index in reversed(matches[1:]):
            del lines[index]
    else:
        if lines and not lines[-1].endswith(("\n", "\r")):
            lines[-1] += "\n"
        lines.append(f"{KEY}={LOOPBACK}\n")

    path.write_text("".join(lines), encoding="utf-8")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: ensure-trusted-proxy.py <staged-api-env>")
    main(Path(sys.argv[1]))
