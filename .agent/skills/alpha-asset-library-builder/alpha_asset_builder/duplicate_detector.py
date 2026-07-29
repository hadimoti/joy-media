"""Exact RGBA and perceptual duplicate checks."""

from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256

import imagehash
import numpy as np
from PIL import Image, ImageDraw

from .models import AssetRecord


def exact_rgba_hash(image: Image.Image) -> str:
    rgba = np.ascontiguousarray(np.asarray(image.convert("RGBA")))
    digest = sha256()
    digest.update(f"{image.width}x{image.height}".encode("ascii"))
    digest.update(rgba.tobytes())
    return digest.hexdigest()


def checkerboard_preview(image: Image.Image, size: int = 256) -> Image.Image:
    cell = 16
    background = Image.new("RGB", (size, size), "#e8e8e8")
    draw = ImageDraw.Draw(background)
    for y in range(0, size, cell):
        for x in range(0, size, cell):
            if (x // cell + y // cell) % 2:
                draw.rectangle((x, y, x + cell - 1, y + cell - 1), fill="#b8b8b8")
    preview = image.convert("RGBA").copy()
    preview.thumbnail((size - 16, size - 16), Image.Resampling.LANCZOS)
    x = (size - preview.width) // 2
    y = (size - preview.height) // 2
    background.paste(preview, (x, y), preview)
    return background


def perceptual_hash(image: Image.Image) -> str:
    return str(imagehash.phash(checkerboard_preview(image)))


@dataclass(frozen=True)
class DuplicateMatch:
    kind: str
    asset_id: str
    distance: int = 0


class DuplicateDetector:
    def __init__(self, visual_threshold: int = 6) -> None:
        self.visual_threshold = visual_threshold
        self._exact: dict[str, AssetRecord] = {}
        self._visual: list[tuple[imagehash.ImageHash, AssetRecord]] = []

    def register(self, record: AssetRecord) -> None:
        if not record.exported:
            return
        self._exact[record.exactHash] = record
        try:
            self._visual.append((imagehash.hex_to_hash(record.perceptualHash), record))
        except ValueError:
            return

    def find(self, exact_hash: str, phash: str) -> tuple[DuplicateMatch | None, DuplicateMatch | None]:
        exact_record = self._exact.get(exact_hash)
        exact_match = (
            DuplicateMatch(kind="exact", asset_id=exact_record.id)
            if exact_record is not None
            else None
        )
        try:
            candidate_hash = imagehash.hex_to_hash(phash)
        except ValueError:
            return exact_match, None
        closest: DuplicateMatch | None = None
        for known_hash, record in self._visual:
            distance = int(candidate_hash - known_hash)
            if distance <= self.visual_threshold and (
                closest is None or distance < closest.distance
            ):
                closest = DuplicateMatch(kind="visual", asset_id=record.id, distance=distance)
        return exact_match, closest

