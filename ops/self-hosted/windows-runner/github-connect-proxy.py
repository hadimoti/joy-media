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
}


def allowed(host: str) -> bool:
    host = host.lower().rstrip(".")
    return host in ALLOWED_HOSTS or host.endswith(".githubusercontent.com")


class ProxyHandler(socketserver.BaseRequestHandler):
    def handle(self) -> None:
        request = self.request.recv(8192)
        first_line = request.split(b"\r\n", 1)[0].decode("ascii", "replace")
        parts = first_line.split()
        if len(parts) != 3 or parts[0].upper() != "CONNECT":
            self.request.sendall(b"HTTP/1.1 405 Method Not Allowed\r\n\r\n")
            return
        try:
            host, port_text = parts[1].rsplit(":", 1)
            port = int(port_text)
        except (ValueError, TypeError):
            self.request.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
            return
        if port != 443 or not allowed(host):
            self.request.sendall(b"HTTP/1.1 403 Forbidden\r\n\r\n")
            return
        try:
            upstream = socket.create_connection((host, port), timeout=20)
        except OSError:
            self.request.sendall(b"HTTP/1.1 502 Bad Gateway\r\n\r\n")
            return
        with upstream:
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
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
