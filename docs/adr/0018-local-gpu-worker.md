# ADR-0018: Local GPU Worker for Comfy and ML denoise

Status: Accepted
Date: 2026-07-24

## Context

The VPS hosting JOY Media has no NVIDIA GPU. Residual GPU work (ComfyUI image
generation, ML denoise such as DeepFilterNet) cannot run as a server-side
`JOY_MEDIA_COMFYUI_URL` endpoint on this host. Owner direction: GPU providers
execute on the **owner’s PC** via the existing outbound local Worker
(WP-12/13), or browser-local where feasible — not on the VPS.

## Decision

1. **No VPS Comfy/ML GPU endpoint.** Do not configure ComfyUI on the Media API
   host. Keep `adapter-comfyui` fail-closed for empty/direct URL use.
2. **Worker capabilities** advertise GPU-backed job kinds from the local PC:
   - `image.comfy` — local ComfyUI (or equivalent) on the paired Worker machine
   - `audio.ml-denoise` — local ML denoise (DeepFilterNet preferred)
3. Existing `asset.thumbnail` remains the FFmpeg-backed local derivative path.
4. The API/control plane leases GPU jobs only to Workers that advertise the
   matching capability; Jobs UI states clearly when no local GPU Worker is
   paired.
5. Spectral denoise (`ffmpeg afftdn`) and edge-tts / Whisper stay on the VPS
   API (CPU) per D-W23-*.

## Alternatives considered

- **VPS GPU / cloud GPU pool:** Rejected for this deployment (no GPU; ADR-0014
  pool remains deferred).
- **Server-side Comfy HTTP from API:** Rejected — would require a GPU host and
  contradicts owner direction.
- **Browser-only WebGPU ML:** Allowed as a future enhancement; not required to
  close the Worker contract.

## Consequences

- Closing residual “Comfy works” requires a paired PC Worker with ComfyUI (or
  tools) installed locally — Media ships the contract and UX, not the VPS GPU.
- Provider adapters remain libraries; scheduling goes through job-protocol
  Worker capabilities, not provider `CapabilityId` aliases.

## Validation and rollback

- Unit: `WorkerCapability` union + `isWorkerCompatible` / Jobs status helpers.
- Live: Worker hello lists `image.comfy` / `audio.ml-denoise` only when local
  tools/env enabled; without them Jobs copy says local GPU Worker required.
- Execution: Worker `run()` invokes local Comfy (`JOY_MEDIA_LOCAL_COMFY_URL`)
  or ML denoise (`JOY_MEDIA_ML_DENOISE_CMD` / ffmpeg `arnndn`) and completes
  with a `LocalGpuWorkerReceipt`.
- Rollback: remove new capability strings; thumbnail path unchanged.

## Related contracts/tests

ADR-0009 (Worker protocol) · ADR-0007 (roles) · ADR-0014 (GPU pool deferred) ·
`packages/job-protocol` · `apps/worker` · `apps/editor-web` Jobs panel.
