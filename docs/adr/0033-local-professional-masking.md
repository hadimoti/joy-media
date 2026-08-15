# ADR-0033 — Local professional image/video masking

**Status:** Accepted
**Date:** 2026-08-15

## Decision

JOY exposes one provider-neutral `joy.masking.v1` contract through the
Inspector, Joy Code async jobs, the Media API, and paired Local Workers.

- `mask.image` produces a white-subject grayscale PNG matte.
- `mask.video` produces a tracked VP9 WebM with alpha and preserves source
  audio when present.
- Prompts, normalized points/boxes, edge treatment, inversion, and temporal
  tracking options are stored as JSON in the private job lease. Browser job
  listings intentionally omit that payload.
- Worker capabilities are advertised only when an executable model runner is
  explicitly configured. A mask job leases only to a capable paired Worker
  that reports the opaque source asset ID as local.
- Verified outputs upload as private `mask` derivatives. Applying an image
  binds the durable image-matte map; applying a video binds the durable
  clip-to-alpha-source map used by preview and export resolution.

## Model strategy

1. **SAM 3.1** is the preferred high-end adapter for concept prompts and video
   tracking when the owner accepts Meta's gated checkpoint and SAM License.
2. **SAM 2.1 + Grounding DINO / Grounded-SAM-2** is the included permissive
   Apache-2.0 path for points, boxes, text grounding, and tracking.
3. **BiRefNet through rembg** is the built-in image runner for high-resolution
   subject/person mattes and fine edge work.

Model packages and checkpoints stay on the Local Worker. The VPS does not
download gated models, run GPU inference, or learn local filesystem paths.

## Runner boundary

The Worker invokes a configured executable with `shell: false`:

```text
runner --request <private-json-file> --output <png-or-webm>
```

The request file exists only in a mode-0600 temporary directory and is deleted
after completion/cancellation. The Worker validates output media, hashes it,
retains it under a bounded opaque reference, and uploads bytes only after the
control plane authorizes the lease.

## Consequences

- Model installation can be large and hardware-specific, but UI/API semantics
  stay stable across models.
- BiRefNet image masking and SAM 2.1 image/video tracking work with included
  Python adapters. SAM 3 adapters can evolve independently without editor or
  API migrations.
- Point coordinates are normalized, so future direct Program Monitor picking
  can reuse the same durable contract.
- GPL/AGPL background-removal projects are not embedded in the product.
