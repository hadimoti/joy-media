# apps/account-web: the joyst.ir web root

JOY Media v1.1.0 is a local app with no account, so joyst.ir is only a landing page: the download page and the GitHub link.

`pnpm --filter @joy-media/account-web build` now builds that landing page (the generator lives in `apps/site`) into `apps/account-web/dist`. The VPS deploy script `deploy/deploy-control-plane.sh` runs exactly that command and copies `dist/*` into `/opt/joy-media/account-web`, which is the web root of `joyst.ir` and `www.joyst.ir`. So a deploy publishes the landing page, never the old account page.

- The old account page (React, sign-in and devices) is kept in this folder only as source. Its build is `pnpm --filter @joy-media/account-web build:legacy-account-page`. Do not deploy it: v1.1.0 has no server for it to talk to.
- The page shows the real SHA-256 values of the published release. They come from `apps/site/release/<tag>/SHA256SUMS.txt`. When a new version is released, add that folder for the new tag and change the default tag in `apps/site/scripts/build.mjs` (or set `SITE_RELEASE_TAG`).
- Live state on 12 Nov 2026: the web root was replaced with this landing page by hand. The previous root is kept on the server as `/opt/joy-media/account-web.bak-20261112101343` (first page) and `.bak-20261112110510`.
