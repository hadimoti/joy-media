# WP-34 final live closeout — 2026-08-14

## Accepted product

- Product SHA: `630c8ade4c80eea4ca13565204f744c66dd0b67b`
- GitHub Actions: `31737233944`
- GitHub result: `check` and `browser-e2e` passed
- Repository: clean at the accepted product SHA before this documentation-only closeout

## Production release

- API: `/opt/joy-media/releases/wp34-api-20260813T194630Z-630c8ad`
- Web: `/opt/joy-media/web-releases/editor-web-20260813T194630Z-630c8ad-wp34-staging`
- Previous API rollback target: `/opt/joy-media/releases/wp32-api-20260812T181000Z-6d3b467`
- Previous web rollback target: `/opt/joy-media/web-releases/editor-web-20260813T013000Z-2d2ea90-color-clip-render`
- Direct and public API health: `{"ok":true,"service":"joy-media-api","controlPlane":true}`
- Built and served editor index SHA-256:
  `e16190559c1811ce184a37d24fd30bfa20b96181705457bdf10785197782e39f`

## Backup evidence

- Pre-deploy database archive:
  `/opt/joy-media/data/backups/wp34-predeploy-20260813T204128Z.sql.gz`
- Database SHA-256:
  `ce52cff7762f93749e99c1a9faf05f8f7f5894877e5643f341123a003480c5c8`
- Full ParsPack backup prefix:
  `parspack:c212734/sweden-backups/daily/20260813-204550`
- Config archive: `joy-vps-full-20260813-204550.tar.gz`
- Config archive SHA-256:
  `39be59f6a7dc8f8b339ab59da4cfdf2f07b38de27cf0c80b7eb82ab874842a3e`
- Remote verification: zero differences for 4 Matrix artifacts and 11
  project artifacts; backup rotation was disabled to preserve older backups.

## Cleanup and known notes

- Removed the stale `/opt/joy-media/worktrees/wp29-closeout-20260810-0621`
  worktree and its orphaned esbuild process.
- Retained the evidence worktree, immutable releases, rollback targets, and
  runtime data.
- GBrain `joy-media-wp34` was updated and the `joy-media-state` timeline was
  advanced with this closeout.
- GBrain doctor health score was 85 with pre-existing infrastructure warnings
  for configured DB connectivity, retrieval-reflex policy/serve activity, and
  an old post-upgrade migration notice. None are WP-34 product failures.

This file is documentation-only and does not require a second product deploy.
