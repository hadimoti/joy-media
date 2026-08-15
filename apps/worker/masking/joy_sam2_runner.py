#!/usr/bin/env python3
"""Promptable JOY image/video masks with SAM 2.1 and Grounding DINO.

The runner is intentionally process-isolated. Model weights, source paths, and
temporary frames stay on the paired Worker; only the verified derivative is
uploaded by the Node Worker after this process exits successfully.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import subprocess
import tempfile
from fractions import Fraction
from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image, ImageFilter, ImageOps


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    parser.add_argument("--output", required=True)
    return parser.parse_args()


def run(command: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        check=True,
        shell=False,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )


def device_name() -> str:
    configured = os.environ.get("JOY_MEDIA_SAM2_DEVICE", "").strip()
    if configured:
        return configured
    return "cuda" if torch.cuda.is_available() else "cpu"


def inference_context(device: str) -> contextlib.AbstractContextManager[Any]:
    if device.startswith("cuda"):
        return torch.autocast("cuda", dtype=torch.bfloat16)
    return contextlib.nullcontext()


def load_image_predictor(device: str):
    from sam2.sam2_image_predictor import SAM2ImagePredictor

    model_id = os.environ.get(
        "JOY_MEDIA_SAM2_MODEL", "facebook/sam2.1-hiera-large"
    ).strip()
    return SAM2ImagePredictor.from_pretrained(model_id, device=device)


def load_video_predictor(device: str):
    from sam2.sam2_video_predictor import SAM2VideoPredictor

    model_id = os.environ.get(
        "JOY_MEDIA_SAM2_MODEL", "facebook/sam2.1-hiera-large"
    ).strip()
    return SAM2VideoPredictor.from_pretrained(model_id, device=device)


def grounding_box(image: Image.Image, prompt: str, device: str) -> np.ndarray:
    from transformers import AutoModelForZeroShotObjectDetection, AutoProcessor

    model_id = os.environ.get(
        "JOY_MEDIA_GROUNDING_MODEL", "IDEA-Research/grounding-dino-tiny"
    ).strip()
    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForZeroShotObjectDetection.from_pretrained(model_id).to(device)
    labels = [[prompt.strip().rstrip(".")]]
    inputs = processor(images=image, text=labels, return_tensors="pt").to(device)
    with torch.no_grad():
        outputs = model(**inputs)
    result = processor.post_process_grounded_object_detection(
        outputs,
        inputs.input_ids,
        threshold=float(os.environ.get("JOY_MEDIA_GROUNDING_BOX_THRESHOLD", "0.35")),
        text_threshold=float(os.environ.get("JOY_MEDIA_GROUNDING_TEXT_THRESHOLD", "0.25")),
        target_sizes=[image.size[::-1]],
    )[0]
    scores = result["scores"]
    if len(scores) == 0:
        raise RuntimeError(f"Grounding DINO found no subject for: {prompt}")
    best = int(torch.argmax(scores).item())
    return result["boxes"][best].detach().cpu().numpy().astype(np.float32)


def prompt_for(selection: dict[str, Any]) -> str:
    mode = selection.get("mode")
    if mode == "person":
        return "primary person"
    if mode == "prompt":
        prompt = str(selection.get("prompt", "")).strip()
        if not prompt:
            raise RuntimeError("Prompt selection requires text")
        return prompt
    return "main subject"


def normalized_box(selection: dict[str, Any], width: int, height: int) -> np.ndarray | None:
    if selection.get("mode") != "box":
        return None
    box = selection.get("box")
    if not isinstance(box, dict):
        raise RuntimeError("Box selection requires normalized bounds")
    x = clamp(float(box.get("x", 0)), 0, 1)
    y = clamp(float(box.get("y", 0)), 0, 1)
    w = clamp(float(box.get("width", 0)), 0, 1)
    h = clamp(float(box.get("height", 0)), 0, 1)
    if w <= 0 or h <= 0:
        raise RuntimeError("Selection box must have positive size")
    return np.asarray([x * width, y * height, (x + w) * width, (y + h) * height], dtype=np.float32)


def normalized_points(
    selection: dict[str, Any], width: int, height: int
) -> tuple[np.ndarray | None, np.ndarray | None]:
    if selection.get("mode") != "points":
        return None, None
    raw = selection.get("points")
    if not isinstance(raw, list) or not raw:
        raise RuntimeError("Point selection requires at least one point")
    points: list[list[float]] = []
    labels: list[int] = []
    for value in raw[:64]:
        if not isinstance(value, dict):
            continue
        points.append(
            [
                clamp(float(value.get("x", 0)), 0, 1) * width,
                clamp(float(value.get("y", 0)), 0, 1) * height,
            ]
        )
        labels.append(1 if value.get("label") == "foreground" else 0)
    if not points:
        raise RuntimeError("Point selection contains no valid points")
    return np.asarray(points, dtype=np.float32), np.asarray(labels, dtype=np.int32)


def seed_time_us(selection: dict[str, Any]) -> int:
    if isinstance(selection.get("timeUs"), (int, float)):
        return max(0, int(selection["timeUs"]))
    if selection.get("mode") == "box" and isinstance(selection.get("box"), dict):
        return max(0, int(selection["box"].get("timeUs", 0)))
    if selection.get("mode") == "points" and isinstance(selection.get("points"), list):
        times = [
            int(point.get("timeUs", 0))
            for point in selection["points"]
            if isinstance(point, dict) and isinstance(point.get("timeUs", 0), (int, float))
        ]
        return max(0, min(times)) if times else 0
    return 0


def adjusted_alpha(mask: np.ndarray, edge: dict[str, Any], invert: bool) -> Image.Image:
    alpha = Image.fromarray(np.where(mask, 255, 0).astype(np.uint8), mode="L")
    expansion = int(round(clamp(float(edge.get("expansionPx", 0)), -100, 100)))
    if expansion:
        radius = min(101, abs(expansion) * 2 + 1)
        alpha = alpha.filter(
            ImageFilter.MaxFilter(radius) if expansion > 0 else ImageFilter.MinFilter(radius)
        )
    feather = clamp(float(edge.get("featherPx", 0)), 0, 100)
    if feather:
        alpha = alpha.filter(ImageFilter.GaussianBlur(feather))
    return ImageOps.invert(alpha) if invert else alpha


def image_mask(request: dict[str, Any], output_path: Path, device: str) -> None:
    settings = request["settings"]
    selection = settings["selection"]
    image = Image.open(request["sourcePath"]).convert("RGB")
    width, height = image.size
    box = normalized_box(selection, width, height)
    points, labels = normalized_points(selection, width, height)
    if selection.get("mode") in {"subject", "person", "prompt"}:
        box = grounding_box(image, prompt_for(selection), device)

    predictor = load_image_predictor(device)
    with torch.inference_mode(), inference_context(device):
        predictor.set_image(np.asarray(image))
        masks, scores, _ = predictor.predict(
            point_coords=points,
            point_labels=labels,
            box=box,
            multimask_output=True,
        )
    if len(masks) == 0:
        raise RuntimeError("SAM 2 returned no image mask")
    best = int(np.argmax(scores))
    alpha = adjusted_alpha(
        np.asarray(masks[best]).squeeze().astype(bool),
        settings["edge"],
        bool(settings.get("invert", False)),
    )
    output_path.parent.mkdir(parents=True, exist_ok=True)
    alpha.save(output_path, format="PNG", optimize=True)


def video_metadata(source_path: Path) -> tuple[float, float]:
    result = run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=avg_frame_rate:format=duration",
            "-of",
            "json",
            str(source_path),
        ]
    )
    root = json.loads(result.stdout)
    stream = root.get("streams", [{}])[0]
    rate = str(stream.get("avg_frame_rate", "0/1"))
    fps = float(Fraction(rate)) if rate != "0/0" else 0
    duration = float(root.get("format", {}).get("duration", 0))
    if not np.isfinite(fps) or fps <= 0 or not np.isfinite(duration) or duration <= 0:
        raise RuntimeError("Video timing metadata is invalid")
    return fps, duration


def collect_video_masks(
    frames: list[Path], settings: dict[str, Any], device: str, fps: float
) -> dict[int, np.ndarray]:
    selection = settings["selection"]
    seed = min(len(frames) - 1, max(0, round(seed_time_us(selection) * fps / 1_000_000)))
    seed_image = Image.open(frames[seed]).convert("RGB")
    width, height = seed_image.size
    box = normalized_box(selection, width, height)
    points, labels = normalized_points(selection, width, height)
    if selection.get("mode") in {"subject", "person", "prompt"}:
        box = grounding_box(seed_image, prompt_for(selection), device)

    predictor = load_video_predictor(device)
    masks: dict[int, np.ndarray] = {}
    with torch.inference_mode(), inference_context(device):
        state = predictor.init_state(video_path=str(frames[0].parent))
        frame_idx, _, logits = predictor.add_new_points_or_box(
            inference_state=state,
            frame_idx=seed,
            obj_id=1,
            points=points,
            labels=labels,
            box=box,
        )
        masks[int(frame_idx)] = (logits[0].squeeze() > 0).detach().cpu().numpy()
        direction = settings.get("video", {}).get("direction", "both")
        if direction in {"forward", "both"}:
            for frame_idx, _, logits in predictor.propagate_in_video(
                state, start_frame_idx=seed, reverse=False
            ):
                masks[int(frame_idx)] = (logits[0].squeeze() > 0).detach().cpu().numpy()
        if seed > 0 and direction in {"backward", "both"}:
            for frame_idx, _, logits in predictor.propagate_in_video(
                state, start_frame_idx=seed, reverse=True
            ):
                masks[int(frame_idx)] = (logits[0].squeeze() > 0).detach().cpu().numpy()

    if not masks:
        raise RuntimeError("SAM 2 returned no tracked video masks")
    first = masks[min(masks)]
    last = first
    for index in range(len(frames)):
        if index in masks:
            last = masks[index]
        else:
            masks[index] = first if index < seed else last
    return masks


def video_mask(request: dict[str, Any], output_path: Path, device: str) -> None:
    source_path = Path(request["sourcePath"])
    settings = request["settings"]
    fps, duration = video_metadata(source_path)
    with tempfile.TemporaryDirectory(prefix="joy-sam2-") as temporary:
        root = Path(temporary)
        frames_dir = root / "frames"
        rgba_dir = root / "rgba"
        frames_dir.mkdir()
        rgba_dir.mkdir()
        run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-i",
                str(source_path),
                "-vf",
                f"fps={fps:.12g}",
                "-q:v",
                "2",
                str(frames_dir / "%08d.jpg"),
            ]
        )
        frames = sorted(frames_dir.glob("*.jpg"))
        if not frames:
            raise RuntimeError("FFmpeg extracted no video frames")
        masks = collect_video_masks(frames, settings, device, fps)
        consistency = clamp(
            float(settings.get("video", {}).get("temporalConsistency", 0.85)), 0, 1
        )
        history_weight = consistency * 0.35
        previous: np.ndarray | None = None
        for index, frame_path in enumerate(frames):
            frame = Image.open(frame_path).convert("RGBA")
            alpha = np.asarray(
                adjusted_alpha(
                    masks[index], settings["edge"], bool(settings.get("invert", False))
                ),
                dtype=np.float32,
            )
            if previous is not None and history_weight > 0:
                alpha = alpha * (1 - history_weight) + previous * history_weight
            previous = alpha
            frame.putalpha(Image.fromarray(np.clip(alpha, 0, 255).astype(np.uint8), mode="L"))
            frame.save(rgba_dir / f"{index + 1:08d}.png", format="PNG", optimize=False)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        run(
            [
                "ffmpeg",
                "-y",
                "-hide_banner",
                "-loglevel",
                "error",
                "-framerate",
                f"{fps:.12g}",
                "-i",
                str(rgba_dir / "%08d.png"),
                "-i",
                str(source_path),
                "-map",
                "0:v:0",
                "-map",
                "1:a?",
                "-t",
                f"{duration:.9f}",
                "-c:v",
                "libvpx-vp9",
                "-b:v",
                "0",
                "-crf",
                os.environ.get("JOY_MEDIA_MASK_VIDEO_CRF", "24"),
                "-pix_fmt",
                "yuva420p",
                "-auto-alt-ref",
                "0",
                "-c:a",
                "libopus",
                "-shortest",
                str(output_path),
            ]
        )


def validate_request(request: dict[str, Any]) -> None:
    if request.get("protocol") != "joy.masking.v1":
        raise RuntimeError("Unsupported masking protocol")
    if request.get("sourceKind") not in {"image", "video"}:
        raise RuntimeError("Masking source kind is invalid")
    settings = request.get("settings")
    if not isinstance(settings, dict) or settings.get("provider") not in {
        "auto",
        "sam2-grounded",
    }:
        raise RuntimeError("This runner accepts Auto or SAM 2 + Grounding DINO")
    if not Path(str(request.get("sourcePath", ""))).is_file():
        raise RuntimeError("Masking source is unavailable")


def clamp(value: float, minimum: float, maximum: float) -> float:
    return min(maximum, max(minimum, value))


def main() -> None:
    args = parse_args()
    request = json.loads(Path(args.request).read_text(encoding="utf-8"))
    validate_request(request)
    output_path = Path(args.output)
    device = device_name()
    try:
        if request["sourceKind"] == "image":
            image_mask(request, output_path, device)
        else:
            video_mask(request, output_path, device)
    finally:
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


if __name__ == "__main__":
    main()
