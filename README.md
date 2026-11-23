<div align="center">

# JOY Media

### A Windows editor for graphic and motion design

Build layered compositions, refine typography, motion and color, and finish them on a multitrack timeline. JOY Media is a local desktop app; optional AI features connect to the provider you configure.

[Windows downloads](https://github.com/hadimoti/joy-media/releases) · [v1.1.2 designer guide](docs/USER-GUIDE-v1.1.2.md) · [Release notes](RELEASE_NOTES_v1.1.2.md) · [MIT license](LICENSE)

</div>

## Make a composition

1. **Start with a project.** Set its canvas format, bring in media, and organize layers and tracks.
2. **Shape the design.** Create titles and captions, then adjust position, scale, color and motion.
3. **Review timing.** Scrub the Monitor and Timeline together, add keyframes, and refine audio.
4. **Export an MP4.** Choose the output preset, check any warnings, and keep the completed file from Recent processes.

The editor can work with local media without an AI connection. Local speech tools need their models and dependencies configured; AI generation or Joy Code requests use the provider you select and may incur provider charges.

## What's in v1.1.2

- A clearer Asset Library preview for images and videos, plus stricter library-folder checks.
- Monitor smart guides, snapping and an on-canvas position, size and angle readout.
- More reliable timeline selection and dragging, split-at-playhead, and inspector value entry with one Undo step per change.
- On-device speech-to-caption and text-to-speech workflows, with setup and model requirements described in the [designer guide](docs/USER-GUIDE-v1.1.2.md).
- Joy Code improvements for preset lookup, provider errors, chat formatting and Settings navigation.

See [all changes and known limits](RELEASE_NOTES_v1.1.2.md) before upgrading.

## Get the Windows app

Download the installer from the [v1.1.2 release](https://github.com/hadimoti/joy-media/releases). Download `SHA256SUMS.txt` from the same release and compare the installer hash before opening it:

```powershell
Get-FileHash .\joy-media-setup.exe -Algorithm SHA256
```

Match the `Hash` value with the installer entry in `SHA256SUMS.txt`. The v1.1.2 installer is unsigned, so Windows may show a warning. See the [installation and verification steps](docs/USER-GUIDE-v1.1.2.md#install-and-check-the-download).

## Guides

- [v1.1.2 guide for designers](docs/USER-GUIDE-v1.1.2.md)
- [v1.1.2 release notes and known limits](RELEASE_NOTES_v1.1.2.md)
- [Developer and contributor guide](docs/DEVELOPMENT.md)

## Project

JOY Media is licensed under the [MIT License](LICENSE). The desktop editor is built with Electron and React. Project and media data stay on the computer unless you choose an external AI provider or export files to another location.
