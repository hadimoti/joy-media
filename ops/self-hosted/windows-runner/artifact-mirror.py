#!/usr/bin/env python3
"""Serve verified Windows-runner artifacts and the pnpm Corepack metadata.

This is intentionally a temporary, host-local mirror. It does not proxy or
rewrite artifact bytes: the container still verifies every archive hash. The
small metadata response only rewrites pnpm's tarball URL to the local mirror
so Corepack can install the already-downloaded package without outbound TLS.
"""

from __future__ import annotations

import argparse
import json
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse


class Handler(SimpleHTTPRequestHandler):
    server_version = "JoyArtifactMirror/1.0"

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler API
        parsed = urlparse(self.path)
        if parsed.path == "/npm/pnpm":
            self._serve_pnpm_metadata(version_only=False)
            return
        if parsed.path == "/npm/pnpm/11.15.0":
            self._serve_pnpm_metadata(version_only=True)
            return
        if parsed.path == "/npm/pnpm/-/pnpm-11.15.0.tgz":
            self.path = "/pnpm-11.15.0.tgz"
        super().do_GET()

    def _serve_pnpm_metadata(self, *, version_only: bool) -> None:
        metadata_path: Path = self.server.pnpm_metadata  # type: ignore[attr-defined]
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        version = metadata["versions"]["11.15.0"]
        version["dist"]["tarball"] = (
            f"http://{self.headers.get('Host', 'host.docker.internal')}/"
            "npm/pnpm/-/pnpm-11.15.0.tgz"
        )
        payload = version if version_only else metadata
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format: str, *args: object) -> None:
        print(format % args, flush=True)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--pnpm-metadata", required=True, type=Path)
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args()

    root = args.root.resolve()
    metadata = args.pnpm_metadata.resolve()
    if not root.is_dir() or not metadata.is_file():
        raise SystemExit("mirror root or pnpm metadata file does not exist")

    handler = lambda *handler_args, **handler_kwargs: Handler(  # noqa: E731
        *handler_args, directory=str(root), **handler_kwargs
    )
    server = ThreadingHTTPServer((args.bind, args.port), handler)
    server.pnpm_metadata = metadata  # type: ignore[attr-defined]
    print(f"artifact mirror listening on {args.bind}:{args.port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
