#!/usr/bin/env python3
"""JOY image masking runner using rembg's BiRefNet sessions.

The Node Worker passes a private request file containing local paths. Nothing
from this file is sent to the control plane. SAM 3/SAM 2 video runners can use
the same --request/--output contract documented beside this script.
"""

from __future__ import annotations

import argparse
import io
import json
import os
from pathlib import Path
import shutil

from PIL import Image, ImageFilter, ImageOps
from rembg import new_session, remove


def provision_local_birefnet_model(model: str) -> None:
    """Expose owner-supplied model files under rembg's expected cache names."""
    source_directory = os.environ.get("JOY_MEDIA_BIREFNET_MODEL_DIR", "").strip()
    if not source_directory:
        return
    source_name = {
        "birefnet-general": "BiRefNet-general-epoch_244.onnx",
        "birefnet-portrait": "BiRefNet-portrait-epoch_150.onnx",
    }.get(model)
    if source_name is None:
        return
    source = Path(source_directory) / source_name
    cache = Path(os.environ.get("U2NET_HOME", source_directory))
    destination = cache / f"{model}.onnx"
    if not source.is_file() or destination.exists():
        return
    cache.mkdir(parents=True, exist_ok=True)
    try:
        os.link(source, destination)
    except OSError:
        shutil.copy2(source, destination)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def adjusted_mask(mask_bytes: bytes, edge: dict, invert: bool) -> Image.Image:
    mask = Image.open(io.BytesIO(mask_bytes)).convert("L")
    expansion = int(round(float(edge.get("expansionPx", 0))))
    if expansion:
        radius = min(101, abs(expansion) * 2 + 1)
        mask = mask.filter(ImageFilter.MaxFilter(radius) if expansion > 0 else ImageFilter.MinFilter(radius))
    feather = max(0.0, min(100.0, float(edge.get("featherPx", 0))))
    if feather:
        mask = mask.filter(ImageFilter.GaussianBlur(feather))
    if invert:
        mask = ImageOps.invert(mask)
    return mask


def main() -> None:
    args = parse_args()
    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    if request.get("protocol") != "joy.masking.v1" or request.get("sourceKind") != "image":
        raise RuntimeError("This bundled runner supports image masks; configure a SAM video runner for video")
    settings = request["settings"]
    selection = settings["selection"]
    if selection.get("mode") not in {"subject", "person"}:
        raise RuntimeError("BiRefNet supports Subject and Person; use a SAM runner for prompts, points, or boxes")
    provider = settings.get("provider", "auto")
    if provider not in {"auto", "birefnet"}:
        raise RuntimeError("The selected provider requires an external SAM runner")

    source_path = Path(request["sourcePath"])
    output_path = Path(args.output)
    source_bytes = source_path.read_bytes()
    model = "birefnet-portrait" if selection.get("mode") == "person" else "birefnet-general"
    provision_local_birefnet_model(model)
    session = new_session(model)
    raw_mask = remove(
        source_bytes,
        session=session,
        only_mask=True,
        alpha_matting=bool(settings["edge"].get("decontaminate", True)),
    )
    mask = adjusted_mask(raw_mask, settings["edge"], bool(settings.get("invert", False)))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    mask.save(output_path, format="PNG", optimize=True)


if __name__ == "__main__":
    main()
