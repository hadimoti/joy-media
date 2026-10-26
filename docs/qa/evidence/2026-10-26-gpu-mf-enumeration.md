# Media Foundation H.264 encoder enumeration, outside Chromium, 2026-10-26

Scope: preparation for the attended GPU diagnosis (plan section 3.2, step 3). **Not a diagnosis, and not a session receipt.**
It lists the hardware H.264 video encoders that Media Foundation offers on this PC, from a process that is not Chromium.

## What was built

- `tooling/diagnostics/mf-probe/MfProbe.cs`: C# 5 (csc v4.0.30319, the compiler `build-installer.ps1` already uses). It calls
  `MFStartup`, `MFTEnumEx(MFT_CATEGORY_VIDEO_ENCODER, hardware | sort-and-filter, output H.264)`, reads each activation object's
  friendly name through `IMFAttributes::GetAllocatedString`, and prints one JSON line per encoder.
- `tooling/diagnostics/mf-probe/build-mf-probe.ps1`: builds the probe into a folder outside the repository.
- Not built: the activation of one encoder and the one-frame encode (plan step 3, second half). That needs the attended session G1,
  where a crash in the encoder can be observed with the owner present.

## How the hand-declared interface was checked

No Windows SDK headers are installed here, so the GUIDs and vtable slots were declared by hand. The first run returned
`MF_E_ATTRIBUTENOTFOUND` for the friendly-name key, so the probe was changed to list the attribute keys each activation object
carries. The listing showed the friendly-name key as `{314ffbae-5b41-4c95-9c19-4e7d586face3}`, which corrected the constant.
The vtable slot for `GetAllocatedString` was confirmed by the call returning a meaningful HRESULT rather than a crash.

## Result (this PC, run once, enumeration only)

| Encoder friendly name      | Count |
| -------------------------- | ----- |
| `AMDh264Encoder`           | 2     |
| `NVIDIA H.264 Encoder MFT` | 1     |

All three names read back as printable text (`unreadable: 0`), and the probe exits 0.

What this does and does not show:

- It shows that Media Foundation offers an NVIDIA hardware H.264 encoder, which is the encoder the crash involves.
- It also offers two AMD hardware H.264 encoders. That is a question for the G1 inventory (plan step 1): whether this PC has a
  second adapter that is active, or only stale encoder registrations. This run does not establish which.
- It does not show that the encoder works, or that it crashes. Those need the activation and encode step, which is not built.

## Remaining for the attended session G1

- The activation and one-frame encode (plan step 3), then the stage bisect (plan steps 2 to 3), the dumps (step 4) and the
  cross-checks (steps 5 to 11). Each needs the owner: the desktop session, admin approvals, driver changes or exploit-protection
  toggles, as listed in plan section 3.2.
