# JOY Local Masking runners

Masking stays on the paired Local Worker. The API receives an opaque asset ID,
normalized selection settings, progress, and a verified derivative receipt;
it never receives a filesystem path or model credential.

## BiRefNet image setup

Create a Python virtual environment on the Worker PC and install
`requirements-image.txt`. Configure:

```text
JOY_MEDIA_MASKING_PYTHON=/path/to/venv/python
JOY_MEDIA_MASK_IMAGE_RUNNER=/path/to/joy_mask_runner.py
```

The first run downloads the selected rembg/BiRefNet ONNX model into rembg's
normal user cache. `birefnet-general` powers Subject and
`birefnet-portrait` powers Person.

## SAM 2.1 + Grounding DINO image/video setup

For prompt, point, box, and tracked video masks, use the included
`joy_sam2_runner.py` adapter. SAM 2 currently requires Python 3.10+, PyTorch
2.5.1+, TorchVision 0.20.1+, FFmpeg, and FFprobe. On Windows, the upstream SAM
2 project recommends WSL.

Install PyTorch/TorchVision for the Worker's CUDA version, clone the official
SAM 2 repository, run `pip install -e .` in that clone, then install
`requirements-sam2.txt`. Configure:

```text
JOY_MEDIA_MASKING_PYTHON=/path/to/venv/python
JOY_MEDIA_MASKING_RUNNER=/path/to/joy_sam2_runner.py
JOY_MEDIA_MASKING_CAPABILITIES=image,video
```

The default first run downloads `facebook/sam2.1-hiera-large` and
`IDEA-Research/grounding-dino-tiny` to the Hugging Face cache. Override them
with `JOY_MEDIA_SAM2_MODEL` / `JOY_MEDIA_GROUNDING_MODEL`; use
`HF_HUB_OFFLINE=1` after prefetching for a fully offline inference host. The
runner seeds Subject/Person/Prompt through Grounding DINO, accepts normalized
foreground/background points or a box, propagates masks in either direction,
and emits a VP9-alpha WebM with source audio preserved.

## SAM 3.1 / custom runner contract

For text prompts, point/box refinement, and temporal tracking, configure an
custom runner with `JOY_MEDIA_MASKING_RUNNER` and set
`JOY_MEDIA_MASKING_CAPABILITIES=image,video`. The executable receives:

```text
--request <private-json-file> --output <png-or-webm-path>
```

The request uses protocol `joy.masking.v1`; `settings` is the shared
`MaskJobPayload` contract. Image output must be a white-subject grayscale PNG.
Video output must be a VP9 WebM with alpha (and source audio preserved when
present). The Worker validates and hashes the output before upload.

Recommended adapters:

- SAM 3.1 for text/visual prompts and tracked concepts. Its gated checkpoint
  and SAM License must be accepted by the model owner.
- SAM 2.1 plus Grounding DINO / Grounded-SAM-2 through the included runner
  when a permissive Apache-2.0 implementation is required.
- BiRefNet via the bundled runner for high-resolution hair and edge mattes.

Never point this configuration at a shell command. The Worker invokes the
executable directly with `shell: false`.
