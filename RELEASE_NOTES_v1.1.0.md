# JOY Media v1.1.0 — Draft Release Notes

This file is a draft. The rest of the v1.1.0 notes, the downloads and the checksums are added before the release.

---

### Public custom endpoints

A custom endpoint on a public address is reached only at addresses checked before each request. A name is refused if it resolves to a private, loopback, link-local or internal address, a cloud metadata address, a carrier-grade NAT address, a multicast address, an IPv4-compatible address (`::/96`), a NAT64 local-use address (`64:ff9b:1::/48`) or a 6to4 address (`2002::/16`). Names such as `localhost`, `.internal` and `.local` are refused too.

Mapped addresses (`::ffff:a.b.c.d`), translated addresses (`::ffff:0:a.b.c.d`) and NAT64 well-known addresses (`64:ff9b::/96`) are judged by the IPv4 address they carry. A DNS64 network returns these for public IPv4-only servers, so those servers now work. Before this release, the CLI refused every NAT64 and translated address, and the desktop check did not judge NAT64 and translated addresses at all.

### Known limitation: other IPv6 prefixes

A private IPv4 address carried in an ISATAP address (RFC 5214), in a network-specific NAT64 prefix (RFC 6052) or in a 6rd-style prefix still passes the check. Someone who can change the DNS answer for a public endpoint name could point the endpoint at a private host, and the request, including the API key, would be sent there. This predates v1.1.0 and is accepted for this release. No fixed filter is planned: these prefixes depend on each network operator, and a filter would refuse legitimate public addresses.
