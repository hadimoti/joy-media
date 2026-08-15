"""JOY Media Real-ESRGAN image runner.

The Node Worker owns the request/output paths and launches this file with
shell=False. Model files and Python dependencies stay on the Worker machine.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    settings = request["settings"]
    source_path = Path(request["sourcePath"])
    output_path = Path(args.output)
    model_path = Path(os.environ.get("JOY_MEDIA_REAL_ESRGAN_MODEL", ""))
    if not source_path.is_file():
        raise RuntimeError("source image is unavailable")
    if not model_path.is_file():
        raise RuntimeError(
            "Real-ESRGAN checkpoint is not installed; set JOY_MEDIA_REAL_ESRGAN_MODEL"
        )

    from PIL import Image
    import torch
    from basicsr.archs.rrdbnet_arch import RRDBNet
    from realesrgan import RealESRGANer

    image = Image.open(source_path)
    image.load()
    image_format = settings.get("output", {}).get("imageFormat", "png")
    if image.mode not in ("RGB", "RGBA"):
        image = image.convert("RGBA" if "A" in image.getbands() else "RGB")

    model = RRDBNet(
        num_in_ch=3,
        num_out_ch=3,
        num_feat=64,
        num_block=23,
        num_grow_ch=32,
        scale=4,
    )
    upsampler = RealESRGANer(
        scale=4,
        model_path=str(model_path),
        model=model,
        tile=0,
        tile_pad=10,
        pre_pad=0,
        half=torch.cuda.is_available(),
    )
    bgr = __import__("numpy").array(image.convert("RGB"))[:, :, ::-1]
    output, _ = upsampler.enhance(bgr, outscale=4)
    enhanced = Image.fromarray(output[:, :, ::-1])
    requested_scale = settings.get("output", {}).get("scale", 4)
    if requested_scale == 2:
        enhanced = enhanced.resize(
            (max(1, image.width * 2), max(1, image.height * 2)),
            Image.Resampling.LANCZOS,
        )
    if image.mode == "RGBA":
        alpha = image.getchannel("A").resize(enhanced.size, Image.Resampling.LANCZOS)
        enhanced.putalpha(alpha)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    enhanced.save(output_path, format="JPEG" if image_format == "jpeg" else "PNG")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
