"""Tight, alpha-preserving RGBA crop generation."""

from __future__ import annotations

import numpy as np
from PIL import Image

from .config import ExtractionConfig
from .models import Bounds, ComponentGroup


def tight_group_bounds(
    alpha: np.ndarray,
    group: ComponentGroup,
    alpha_threshold: int,
) -> Bounds:
    """Refine a grouped bounds rectangle using original low-alpha pixels."""
    source_bounds = group.bounds
    region = alpha[
        source_bounds.y : source_bounds.bottom,
        source_bounds.x : source_bounds.right,
    ]
    occupied = region > alpha_threshold
    if not np.any(occupied):
        return source_bounds
    ys, xs = np.where(occupied)
    return Bounds(
        x=source_bounds.x + int(xs.min()),
        y=source_bounds.y + int(ys.min()),
        width=int(xs.max() - xs.min() + 1),
        height=int(ys.max() - ys.min() + 1),
    )


def export_bounds(
    tight_bounds: Bounds,
    source_width: int,
    source_height: int,
    config: ExtractionConfig,
) -> Bounds:
    return tight_bounds.expand(
        config.resolved_padding(tight_bounds.width, tight_bounds.height),
        source_width,
        source_height,
    )


def crop_rgba(image: Image.Image, bounds: Bounds) -> Image.Image:
    return image.crop((bounds.x, bounds.y, bounds.right, bounds.bottom))


def alpha_area(crop: Image.Image, alpha_threshold: int) -> int:
    alpha = np.asarray(crop.getchannel("A"))
    return int(np.count_nonzero(alpha > alpha_threshold))

