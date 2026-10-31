# Retained deployment assets

The API deployment surface was retired in P5-1 with `apps/api`. Its API
systemd override, API deployment scripts, and release identity helper have
been removed. The retained rollback script keeps a small metadata reader for
previously deployed immutable API releases needed by P8.

The remaining files support later release work:

- `apply-nginx-cutover.sh`, `joy-media-account-web.nginx.conf`, and
  `joy-media-cutover-nginx-boundary.md` are retained for the P6 account-web
  cutover.
- `joy-media.nginx.conf`, `joy-media-rollback.sh`, and
  `joy-media-rollback.test.sh` are retained for the P8 rollback path.

These files describe planned deployment work. This package does not provide an
API deployment target.
