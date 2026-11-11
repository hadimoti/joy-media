# JOY Media v1.1.0 — Draft Release Notes

This file is a draft. The rest of the v1.1.0 notes, the downloads and the checksums are added before the release.

---

### Missing media: relink

When a project uses media whose original is not available (for example a project package opened without its media), the Assets panel shows a Missing media section. Each item has a Relink button. A file with a different size or hash is refused, the original stays marked missing and nothing changes. A file that matches restores the media, and the fix is still there after a restart. A separate Use different file choice stores the chosen file as a new asset, points the clips at it, and can be undone.

### Joy Code tab

The Joy Code tab has a close button. It is disabled while Joy Code is running a request. Open Joy Code in the menu brings the panel back.

### Known limitations

- **Not merged with v1.0.2.** v1.1.0 was cut from the main line on 14 Oct 2026 and was not merged with v1.0.2. Only the two items above were carried over from it. Other v1.0.2 changes are not in v1.1.0, among them the shared title compiler and motion templates, the desktop title handoff, and the Desktop thumbnail action on Assets cards.
- **Export leaves a staged copy in the asset library.** Each MP4 export can leave a hidden working copy in the asset library, listed as `<export name>.mp4.stage` (1.5 MB for a 4-second clip). It is not deleted after the export. Delete it from the Assets panel with the card's Delete button. It does not change the exported file.
- **Not tested in the app.** Use different file with Undo, and cancelling the file picker, are covered by unit tests only. The packaged test files for Missing media (8 of 9 tests) did not run, because they need a test mode that this version does not have.

---

### Public custom endpoints

A custom endpoint on a public address is reached only at addresses checked before each request. A name is refused if it resolves to a private, loopback, link-local or internal address, a cloud metadata address, a carrier-grade NAT address, a multicast address, an IPv4-compatible address (`::/96`), a NAT64 local-use address (`64:ff9b:1::/48`) or a 6to4 address (`2002::/16`). Names such as `localhost`, `.internal` and `.local` are refused too.

Mapped addresses (`::ffff:a.b.c.d`), translated addresses (`::ffff:0:a.b.c.d`) and NAT64 well-known addresses (`64:ff9b::/96`) are judged by the IPv4 address they carry. A DNS64 network returns these for public IPv4-only servers, so those servers now work. Before this release, the CLI refused every NAT64 and translated address, and the desktop check did not judge NAT64 and translated addresses at all.

### Known limitation: other IPv6 prefixes

A private IPv4 address carried in an ISATAP address (RFC 5214), in a network-specific NAT64 prefix (RFC 6052) or in a 6rd-style prefix still passes the check. Someone who can change the DNS answer for a public endpoint name could point the endpoint at a private host, and the request, including the API key, would be sent there. This predates v1.1.0 and is accepted for this release. No fixed filter is planned: these prefixes depend on each network operator, and a filter would refuse legitimate public addresses.
