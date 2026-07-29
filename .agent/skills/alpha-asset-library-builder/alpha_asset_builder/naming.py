"""Semantic metadata interfaces plus deterministic offline naming."""

from __future__ import annotations

import json
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

import numpy as np
from PIL import Image

from .models import Bounds, SemanticMetadata


CATEGORY_KEYWORDS: dict[str, tuple[str, ...]] = {
    "arrow": ("arrow", "chevron", "pointer"),
    "ui": ("button", "cta", "ui", "play"),
    "character": ("character", "avatar", "person", "man", "woman", "girl", "boy"),
    "body-part": ("hand", "face", "eye", "arm", "finger"),
    "fire": ("fire", "flame", "burn"),
    "smoke": ("smoke", "cloud", "fog"),
    "light": ("light", "glow", "neon", "laser"),
    "particle": ("particle", "spark", "star", "dust"),
    "logo": ("logo", "brand"),
    "text": ("text", "title", "word", "typography", "font"),
    "shape": ("shape", "circle", "square", "ring", "line"),
    "effect": ("effect", "explosion", "burst", "motion"),
    "background": ("background", "bg", "backdrop"),
    "decoration": ("deco", "ornament", "decoration", "flower"),
    "object": ("object", "phone", "car", "book", "chair"),
    "icon": ("icon", "emoji", "symbol"),
}

ORIENTATION_WORDS = {
    "left": "left",
    "right": "right",
    "up": "up",
    "down": "down",
    "front": "front",
    "side": "side",
}


@dataclass(frozen=True)
class NamingContext:
    source_relative_path: str
    source_filename: str
    crop_index: int
    tight_bounds: Bounds
    source_count: int


class SemanticNamingProvider(Protocol):
    def describe(self, image: Image.Image, context: NamingContext) -> SemanticMetadata | None:
        """Return verified metadata, or None to use the offline fallback."""


class JsonlSemanticNamingProvider:
    """Read model/agent-created structured descriptions without requiring a local model."""

    def __init__(self, path: Path) -> None:
        self._entries: dict[str, SemanticMetadata] = {}
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            if not raw_line.strip():
                continue
            payload = json.loads(raw_line)
            key = str(payload.pop("key", ""))
            if key:
                self._entries[key] = SemanticMetadata.model_validate(payload)

    def describe(self, image: Image.Image, context: NamingContext) -> SemanticMetadata | None:
        del image
        return self._entries.get(f"{context.source_relative_path}#{context.crop_index}")


def slugify(value: str, fallback: str = "unknown-visual") -> str:
    normalized = unicodedata.normalize("NFKD", value).encode("ascii", "ignore").decode("ascii")
    normalized = normalized.lower().replace("_", "-")
    normalized = re.sub(r"[^a-z0-9]+", "-", normalized).strip("-")
    return normalized[:80].strip("-") or fallback


def title_from_slug(value: str) -> str:
    return " ".join(part.capitalize() for part in value.replace(".png", "").split("-") if part)


def _dominant_color_names(image: Image.Image) -> list[str]:
    rgba = np.asarray(image)
    pixels = rgba[rgba[:, :, 3] > 32, :3]
    if pixels.size == 0:
        return []
    # Quantization makes color naming stable without adding a heavyweight clustering dependency.
    buckets = (pixels.astype(np.uint16) // 48).astype(np.uint8)
    unique, counts = np.unique(buckets, axis=0, return_counts=True)
    order = np.argsort(counts)[::-1][:3]
    return list(
        dict.fromkeys(
            _color_name(unique[index].astype(np.int16) * 48 + 24)
            for index in order
        )
    )


def _color_name(rgb: np.ndarray) -> str:
    red, green, blue = (int(channel) for channel in rgb)
    brightness = (red + green + blue) / 3
    spread = max(red, green, blue) - min(red, green, blue)
    if brightness < 45:
        return "black"
    if brightness > 220 and spread < 40:
        return "white"
    if spread < 35:
        return "gray"
    if red > 170 and green > 135 and blue < 115:
        return "gold" if green > 165 else "orange"
    if red > 170 and green > 130 and blue > 135:
        return "pink"
    if red >= green and red >= blue:
        return "red" if green < 115 else "orange"
    if green >= red and green >= blue:
        return "green" if blue < 115 else "teal"
    return "blue" if red < 145 else "purple"


def _infer_category(source_name: str) -> str:
    words = slugify(source_name, "").split("-")
    for category, keywords in CATEGORY_KEYWORDS.items():
        if any(keyword in words for keyword in keywords):
            return category
    return "unknown"


def _infer_orientation(source_name: str) -> str:
    words = set(slugify(source_name, "").split("-"))
    return next((orientation for word, orientation in ORIENTATION_WORDS.items() if word in words), "none")


def fallback_metadata(
    image: Image.Image,
    context: NamingContext,
    fallback_index: int,
) -> SemanticMetadata:
    """Produce deterministic metadata when a vision-capable reviewer is unavailable."""
    category = _infer_category(context.source_filename)
    colors = _dominant_color_names(image)
    orientation = _infer_orientation(context.source_filename)
    if category == "unknown":
        name = f"unknown-visual-{fallback_index:04d}"
        confidence = 0.0
        description = "An isolated transparent visual awaiting semantic review."
        tags = ["unknown", "transparent", "review-needed"]
    else:
        pieces = [*colors[:1], orientation if orientation != "none" else "", category]
        name = slugify("-".join(piece for piece in pieces if piece))
        # A filename keyword is weaker than vision, but strong enough to route into a useful folder.
        confidence = 0.7
        description = f"A transparent {category} extracted from {context.source_filename}."
        tags = list(dict.fromkeys([*colors, category, orientation, "transparent"]))
        tags = [tag for tag in tags if tag and tag != "none"]
    return SemanticMetadata(
        name=name,
        category=category,
        description=description,
        tags=tags,
        colors=colors,
        orientation=orientation,  # type: ignore[arg-type]
        confidence=confidence,
    )


def normalize_metadata(metadata: SemanticMetadata, fallback_index: int) -> SemanticMetadata:
    name = slugify(metadata.name, f"unknown-visual-{fallback_index:04d}")
    category = slugify(metadata.category, "unknown")
    return metadata.model_copy(
        update={
            "name": name,
            "category": category,
            "tags": [slugify(tag, "") for tag in metadata.tags if slugify(tag, "")],
            "colors": [slugify(color, "") for color in metadata.colors if slugify(color, "")],
        }
    )


class FilenameAllocator:
    """Reserve collision-safe names before touching an export path."""

    def __init__(self, existing_filenames: list[str] | None = None) -> None:
        self._used = {Path(filename).stem.casefold() for filename in (existing_filenames or [])}

    def allocate(self, desired_name: str) -> str:
        base = slugify(desired_name)
        candidate = base
        suffix = 2
        while candidate.casefold() in self._used:
            candidate = f"{base}-{suffix:02d}"
            suffix += 1
        self._used.add(candidate.casefold())
        return f"{candidate}.png"
