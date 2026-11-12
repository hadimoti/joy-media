# JOY Media v1.1.0

JOY Media v1.1.0 is a local desktop video editor for Windows. It has no account, no server and no
online plan. You open it, import your media, edit, and export on your own computer. This is a
large change from v1.0.x, which needed a JOY sign-in and a server.

## Download and check it

The files are on the release page: `joy-media-setup.exe` (installer), `joy-media-windows-x64-v1.1.0.zip`
(portable copy), `joy-media.exe`, `joy-worker.exe`, `joy-media-bundle.mjs`,
`joy-media-release-manifest.json` and `SHA256SUMS.txt`.

**The files are not code-signed**, so Windows shows a warning when you download or run the setup.
Check your download before you run it: in PowerShell run `Get-FileHash .\joy-media-setup.exe`, and
compare the result with the `joy-media-setup.exe` line in `SHA256SUMS.txt`. They must be identical.

## What is new

### No account, no server, works offline

The app starts offline. There is no sign-in, no plan screen, no update screen and no usage
reporting. Projects, media and exports stay on your computer. The old server is not used by this
version.

### Connect an AI provider yourself

Joy Code and the AI tools use a provider that you connect. ChatGPT can be connected by signing in.
Kimi and xAI have a sign-in route too. Other providers (for example OpenRouter or DeepSeek) use your
own API key, and you can add a custom endpoint. Your keys are stored encrypted on your computer. If
you have saved provider profiles from v1.0.x, they are shown as disabled with a Later choice, so
nothing is deleted.

### Imports go into your asset library

When you import a file, JOY Media saves it in your asset library folder and shows it in the Media
list at once. If you import the same file again under a new name, the newest name is shown.

### Missing media: relink

When a project uses media whose original is not available (for example a project package opened
without its media), the Assets panel shows a Missing media section. Each item has a Relink button.
A file with a different size or hash is refused, the original stays marked missing and nothing
changes. A file that matches restores the media, and the fix is still there after a restart. A
separate Use different file choice stores the chosen file as a new asset, points the clips at it, and
can be undone.

### Export fixes

Exports were reworked. Colours are tagged consistently, WebM sources no longer repeat frames,
reversed clips no longer judder, and the dissolve between two clips appears in the exported file.
A 10-minute 1080x1920 export finished and gave the same file when repeated.

### Command line

The `joy` and `joy-media` commands are installed with the app and added to your PATH. The command
line can set the AI provider slots (`joy-media agent model get` and `set`).

### Joy Code tab

The Joy Code tab has a close button. It is disabled while Joy Code is running a request. Open Joy
Code in the menu brings the panel back.

### Installer

The installer puts JOY Media in `%LOCALAPPDATA%\Programs\JOY Media`, adds Desktop and Start Menu
shortcuts and puts the folder on your user PATH. Installing over v1.0.2 keeps your app data, and the
setup repairs a PATH entry that the v1.0.x installer could break. Uninstalling removes the program,
the shortcuts, the PATH entry and the `joy://` link, and keeps your projects and settings. These
steps were run in a clean Windows Sandbox: install, open, close, upgrade over v1.0.2, uninstall.
There are no automatic updates: download a new version yourself.

## Known limitations

- **Unsigned.** See "Download and check it" above.
- **GPU crash, cause unknown.** An NVIDIA hardware-encoder crash (the GPU process exiting during an
  export) was seen on one machine before this release. It has not been seen again since 24 Oct 2026
  in the checks we ran, and its cause was not found. If the GPU process exits, the app restarts once
  with a safe encoder setting.
- **High memory on long exports.** The 10-minute export used up to about 8.3 GB of memory on a PC with
  64 GB. Close other large programs before a long export.
- **Not merged with v1.0.2.** v1.1.0 was cut from the main line on 14 Oct 2026 and was not merged with
  v1.0.2. Only Missing media and the Joy Code tab close button were carried over. Other v1.0.2
  changes are not in v1.1.0, among them the shared title compiler and motion templates, the desktop
  title handoff, and the Desktop thumbnail action on Assets cards.
- **Export leaves a staged copy in the asset library.** Each MP4 export can leave a hidden working
  copy in the asset library, listed as `<export name>.mp4.stage` (1.5 MB for a 4-second clip). It is
  not deleted after the export. Delete it from the Assets panel with the card's Delete button. It does
  not change the exported file.
- **Providers.** ChatGPT sign-in was tested end to end. Kimi and xAI sign-in exist, but their model
  answers were not verified. MiniMax sign-in was removed. The old provider profile choice screen
  (Later) was not part of the upgrade test.
- **Project folders are not in this version.** Projects are saved in the app's library as before.
  Folder projects are planned for v1.2.
- **Packaged tests for Missing media did not run.** The packaged test files for Missing media and
  project packages (8 of 9 tests) need a test mode that this version does not have. The relink, the
  refusal of a wrong file, Use different file with Undo, and cancelling the file picker were checked by
  hand in the app instead, in one session on one PC.

## Public custom endpoints

A custom endpoint on a public address is reached only at addresses checked before each request. A
name is refused if it resolves to a private, loopback, link-local or internal address, a cloud
metadata address, a carrier-grade NAT address, a multicast address, an IPv4-compatible address
(`::/96`), a NAT64 local-use address (`64:ff9b:1::/48`) or a 6to4 address (`2002::/16`). Names such
as `localhost`, `.internal` and `.local` are refused too.

Mapped addresses (`::ffff:a.b.c.d`), translated addresses (`::ffff:0:a.b.c.d`) and NAT64 well-known
addresses (`64:ff9b::/96`) are judged by the IPv4 address they carry. A DNS64 network returns these
for public IPv4-only servers, so those servers now work. Before this release, the CLI refused every
NAT64 and translated address, and the desktop check did not judge NAT64 and translated addresses at
all.

### Known limitation: other IPv6 prefixes

A private IPv4 address carried in an ISATAP address (RFC 5214), in a network-specific NAT64 prefix
(RFC 6052) or in a 6rd-style prefix still passes the check. Someone who can change the DNS answer for
a public endpoint name could point the endpoint at a private host, and the request, including the
API key, would be sent there. This predates v1.1.0 and is accepted for this release. No fixed filter
is planned: these prefixes depend on each network operator, and a filter would refuse legitimate
public addresses.
