#!/usr/bin/env python3
"""Small allow-listed CONNECT proxy for the Windows runner container.

The owner PC can reach GitHub directly while the Windows-container NAT can
only establish DNS/TCP. This host-local proxy lets the runner use the host's
working TLS path without exposing a general-purpose open proxy.
"""

from __future__ import annotations

import argparse
import select
import socket
import socketserver


ALLOWED_HOSTS = {
    "api.github.com",
    "github.com",
    "objects.githubusercontent.com",
    "release-assets.githubusercontent.com",
    "codeload.github.com",
    "actions.githubusercontent.com",
    "pipelines.actions.githubusercontent.com",
    "broker.actions.githubusercontent.com",
    # Python CI dependencies; no general-purpose outbound proxy is allowed.
    "pypi.org",
    "files.pythonhosted.org",
    "bootstrap.pypa.io",
    "www.python.org",
    # Node CI dependencies; no general npm proxy is permitted.
    "registry.npmjs.org",
    # Playwright browser artifacts used by the Windows acceptance lane.
    # Keep the list explicit because this proxy is intentionally not general
    # outbound HTTPS. Playwright may redirect between the CDN and its Azure
    # fallback during regional delivery.
    "cdn.playwright.dev",
    "playwright.download.prss.microsoft.com",
    "playwright.azureedge.net",
    # cdn.playwright.dev currently redirects Chrome-for-Testing archives here.
    "storage.googleapis.com",
}


def allowed(host: str) -> bool:
    host = host.lower().rstrip(".")
    return (
        host in ALLOWED_HOSTS
        or host.endswith(".githubusercontent.com")
        or host.endswith(".blob.core.windows.net")
    )


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        request = self.request.recv(8192)
        header_end = request.find(b"\r\n\r\n")
        first_line = request.split(b"\r\n", 1)[0].decode("ascii", "replace")
        parts = first_line.split()
        if len(parts) != 3 or parts[0].upper() != "CONNECT":
            self.request.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return
        try:
            host, port_text = parts[1].rsplit(":", 1)
            port = int(port_text)
        except (ValueError, TypeError):
            print(f"DENY malformed CONNECT {first_line}", flush=True)
            self.request.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return
        if port != 443 or not allowed(host):
            print(f"DENY CONNECT host={host.lower().rstrip('.')} port={port}", flush=True)
            self.request.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            return
        try:
            upstream = socket.create_connection((host, port), timeout=20)
        except OSError:
            self.request.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return
        with upstream:
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            # A client may send the TLS ClientHello in the same TCP read as
            # CONNECT. Preserve and forward bytes beyond the HTTP headers;
            # dropping them leaves TLS stuck after a successful tunnel.
            if header_end >= 0 and len(request) > header_end + 4:
                upstream.sendall(request[header_end + 4 :])
            sockets = [self.request, upstream]
            while True:
                readable, _, exceptional = select.select(sockets, [], sockets, 60)
                if exceptional or not readable:
                    return
                for source in readable:
                    target = upstream if source is self.request else self.request
                    data = source.recv(64 * 1024)
                    if not data:
                        return
                    target.sendall(data)


class ThreadingProxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default="0.0.0.0")
    parser.add_argument("--port", required=True, type=int)
    args = parser.parse_args()
    with ThreadingProxy((args.bind, args.port), ProxyHandler) as server:
        print(f"github CONNECT proxy listening on {args.bind}:{args.port}", flush=True)
        server.serve_forever()


if __name__ == "__main__":
    main()
