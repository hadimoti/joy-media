"""Alpha-aware connected component detection and deterministic debug artifacts."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from PIL import Image, ImageDraw

from .config import ExtractionConfig
from .models import Bounds, Component


class NoUsableAlphaChannelError(ValueError):
    """Raised when a source cannot be separated safely by alpha."""


@dataclass
class DetectionResult:
    image: Image.Image
    rgba: np.ndarray
    alpha: np.ndarray
    low_mask: np.ndarray
    core_mask: np.ndarray
    labels: np.ndarray
    components: list[Component]
    rejected_components: list[dict[str, Any]]


def _load_rgba(path: Path) -> tuple[Image.Image, bool]:
    with Image.open(path) as source:
        source.load()
        has_alpha = "A" in source.getbands() or "transparency" in source.info
        rgba = source.convert("RGBA").copy()
    return rgba, has_alpha


def _bounds_from_stats(stats: np.ndarray) -> Bounds:
    return Bounds(
        x=int(stats[cv2.CC_STAT_LEFT]),
        y=int(stats[cv2.CC_STAT_TOP]),
        width=int(stats[cv2.CC_STAT_WIDTH]),
        height=int(stats[cv2.CC_STAT_HEIGHT]),
    )


def _union_bounds(components: list[Component]) -> Bounds:
    bounds = components[0].bounds
    for component in components[1:]:
        bounds = bounds.union(component.bounds)
    return bounds


def _particle_component(label: int, components: list[Component]) -> Component:
    """Build one virtual component for a cohesive field of alpha islands."""
    bounds = _union_bounds(components)
    core_area = sum(component.core_area for component in components)
    alpha_mass = sum(component.alpha_mass for component in components)
    total_weight = max(alpha_mass, 1)
    return Component(
        # Negative labels cannot collide with OpenCV's positive component labels.
        label=label,
        bounds=bounds,
        core_area=core_area,
        alpha_mass=alpha_mass,
        maximum_alpha=max(component.maximum_alpha for component in components),
        mean_visible_alpha=round(alpha_mass / max(core_area, 1), 3),
        centroid_x=round(
            sum(component.centroid_x * component.alpha_mass for component in components)
            / total_weight,
            3,
        ),
        centroid_y=round(
            sum(component.centroid_y * component.alpha_mass for component in components)
            / total_weight,
            3,
        ),
        # A virtual field must not bridge to a nearby unrelated object merely
        # because one of its many islands shares a faint-alpha halo.
        low_alpha_labels=[],
    )


def _overlaps(left: Bounds, right: Bounds) -> bool:
    return left.x < right.right and left.right > right.x and left.y < right.bottom and left.bottom > right.y


def _contains(outer: Bounds, inner: Bounds) -> bool:
    return (
        outer.x <= inner.x
        and outer.y <= inner.y
        and outer.right >= inner.right
        and outer.bottom >= inner.bottom
    )


def _particle_field_component(
    components: list[Component],
    config: ExtractionConfig,
) -> Component | None:
    """Collapse a dense field of dots into the single visual it represents."""
    grouping = config.grouping
    if (
        not grouping.enabled
        or not grouping.particle_field_grouping
        or len(components) < grouping.particle_minimum_components
    ):
        return None

    areas = np.asarray([component.core_area for component in components], dtype=np.int64)
    small_ratio = float(
        np.count_nonzero(areas <= grouping.particle_max_component_area_px)
    ) / len(components)
    if (
        float(np.median(areas)) > grouping.particle_max_median_area_px
        or small_ratio < grouping.particle_minimum_small_component_ratio
    ):
        return None

    bounds = _union_bounds(components)
    coverage = float(areas.sum()) / max(bounds.area, 1)
    if coverage > grouping.particle_max_coverage:
        return None

    return _particle_component(-1, components)


def _repeating_pattern_component(
    components: list[Component],
    config: ExtractionConfig,
) -> Component | None:
    """Recognize a tiled glyph or icon pattern as one background asset."""
    grouping = config.grouping
    if (
        not grouping.enabled
        or not grouping.repeating_pattern_grouping
        or len(components) < grouping.repeating_pattern_minimum_components
    ):
        return None
    areas = np.asarray([component.core_area for component in components], dtype=np.float64)
    dimensions = np.asarray(
        [max(component.bounds.width, component.bounds.height) for component in components],
        dtype=np.float64,
    )
    area_q25, area_q50, area_q75 = np.percentile(areas, [25, 50, 75])
    dimension_q25, dimension_q75 = np.percentile(dimensions, [25, 75])
    if (
        area_q50 < grouping.repeating_pattern_minimum_median_area_px
        or area_q75 / max(area_q25, 1) > grouping.repeating_pattern_max_interquartile_area_ratio
        or dimension_q75 / max(dimension_q25, 1)
        > grouping.repeating_pattern_max_interquartile_dimension_ratio
    ):
        return None
    bounds = _union_bounds(components)
    coverage = float(areas.sum()) / max(bounds.area, 1)
    if coverage > grouping.repeating_pattern_max_coverage:
        return None
    return _particle_component(-1, components)


def _uniform_dot_field_component(
    components: list[Component],
    config: ExtractionConfig,
) -> Component | None:
    """Keep a high-count, uniform dotted illustration together as one asset."""
    grouping = config.grouping
    if not grouping.enabled or not grouping.uniform_dot_field_grouping:
        return None
    candidates = [
        component
        for component in components
        if (
            component.core_area <= grouping.uniform_dot_field_max_component_area_px
            and max(component.bounds.width, component.bounds.height)
            <= grouping.uniform_dot_field_max_component_dimension_px
        )
    ]
    if len(candidates) < grouping.uniform_dot_field_minimum_components:
        return None

    areas = np.asarray([component.core_area for component in candidates], dtype=np.float64)
    dimensions = np.asarray(
        [max(component.bounds.width, component.bounds.height) for component in candidates],
        dtype=np.float64,
    )
    area_q25, area_q50, area_q75 = np.percentile(areas, [25, 50, 75])
    dimension_q25, dimension_q75 = np.percentile(dimensions, [25, 75])
    if (
        area_q50 > grouping.uniform_dot_field_max_median_area_px
        or area_q75 / max(area_q25, 1) > grouping.uniform_dot_field_max_interquartile_area_ratio
        or dimension_q75 / max(dimension_q25, 1)
        > grouping.uniform_dot_field_max_interquartile_dimension_ratio
    ):
        return None
    bounds = _union_bounds(candidates)
    coverage = float(areas.sum()) / max(bounds.area, 1)
    if coverage > grouping.uniform_dot_field_max_coverage:
        return None

    candidate_labels = {component.label for component in candidates}
    # Refuse to crop a dot field if another visual intersects its frame; this
    # keeps nearby logos or charts independent instead of pulling them along.
    if any(
        _overlaps(component.bounds, bounds)
        for component in components
        if component.label not in candidate_labels
    ):
        return None
    return _particle_component(-1, candidates)


def _particle_field_clusters(
    components: list[Component],
    config: ExtractionConfig,
) -> tuple[list[Component], set[int]]:
    """Find local dense particle/text fields inside a mixed sprite sheet."""
    grouping = config.grouping
    if not grouping.enabled or not grouping.particle_field_grouping:
        return [], set()
    candidates = [
        component
        for component in components
        if component.core_area <= grouping.particle_cluster_max_component_area_px
    ]
    if len(candidates) < grouping.particle_minimum_components:
        return [], set()

    parent = list(range(len(candidates)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    gap = grouping.particle_cluster_gap_px
    cell_size = gap * 2
    cells: dict[tuple[int, int], list[int]] = {}
    for index, component in enumerate(candidates):
        bounds = component.bounds
        left = (bounds.x - gap) // cell_size
        right = (bounds.right + gap) // cell_size
        top = (bounds.y - gap) // cell_size
        bottom = (bounds.bottom + gap) // cell_size
        for y in range(top, bottom + 1):
            for x in range(left, right + 1):
                cell = cells.setdefault((x, y), [])
                for neighbor in cell:
                    union(index, neighbor)
                cell.append(index)

    grouped: dict[int, list[Component]] = {}
    for index, component in enumerate(candidates):
        grouped.setdefault(find(index), []).append(component)

    fields: list[Component] = []
    consumed: set[int] = set()
    next_label = -1
    for members in grouped.values():
        if any(component.label in consumed for component in members):
            continue
        if len(members) < grouping.particle_minimum_components:
            continue
        areas = np.asarray([component.core_area for component in members], dtype=np.int64)
        if float(np.median(areas)) > grouping.particle_cluster_max_median_area_px:
            continue
        bounds = _union_bounds(members)
        coverage = float(areas.sum()) / max(bounds.area, 1)
        if coverage > grouping.particle_max_coverage:
            continue
        member_labels = {component.label for component in members}
        overlapping = [
            component
            for component in components
            if component.label not in member_labels and _overlaps(component.bounds, bounds)
        ]
        # A contained chart, dashed outline, or text block is part of the
        # field's visual composition. A component that crosses its boundary is
        # evidence of a neighboring asset, so leave the cluster for review.
        if any(not _contains(bounds, component.bounds) for component in overlapping):
            continue
        field_members = [*members, *overlapping]
        fields.append(_particle_component(next_label, field_members))
        consumed.update(component.label for component in field_members)
        next_label -= 1
    return fields, consumed


def _composition_clusters(
    components: list[Component],
    config: ExtractionConfig,
    next_label: int,
) -> tuple[list[Component], set[int]]:
    """Merge compact multi-part illustrations such as charts and word marks."""
    grouping = config.grouping
    if not grouping.enabled or not grouping.composition_cluster_grouping:
        return [], set()
    parent = list(range(len(components)))

    def find(index: int) -> int:
        while parent[index] != index:
            parent[index] = parent[parent[index]]
            index = parent[index]
        return index

    def union(left: int, right: int) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    gap = grouping.composition_cluster_gap_px
    cell_size = gap * 2
    cells: dict[tuple[int, int], list[int]] = {}
    for index, component in enumerate(components):
        bounds = component.bounds
        left = (bounds.x - gap) // cell_size
        right = (bounds.right + gap) // cell_size
        top = (bounds.y - gap) // cell_size
        bottom = (bounds.bottom + gap) // cell_size
        for y in range(top, bottom + 1):
            for x in range(left, right + 1):
                cell = cells.setdefault((x, y), [])
                for neighbor in cell:
                    union(index, neighbor)
                cell.append(index)

    grouped: dict[int, list[Component]] = {}
    for index, component in enumerate(components):
        grouped.setdefault(find(index), []).append(component)

    fields: list[Component] = []
    consumed: set[int] = set()
    for members in grouped.values():
        if any(component.label in consumed for component in members):
            continue
        if len(members) < grouping.composition_cluster_minimum_components:
            continue
        bounds = _union_bounds(members)
        coverage = sum(component.core_area for component in members) / max(bounds.area, 1)
        if coverage > grouping.composition_cluster_max_coverage:
            continue
        member_labels = {component.label for component in members}
        overlapping = [
            component
            for component in components
            if component.label not in member_labels and _overlaps(component.bounds, bounds)
        ]
        if any(not _contains(bounds, component.bounds) for component in overlapping):
            continue
        field_members = [*members, *overlapping]
        fields.append(_particle_component(next_label, field_members))
        consumed.update(component.label for component in field_members)
        next_label -= 1
    return fields, consumed


def detect_components(path: Path, config: ExtractionConfig) -> DetectionResult:
    """Detect meaningful core regions while associating their soft-alpha halo."""
    image, source_has_alpha = _load_rgba(path)
    rgba = np.asarray(image)
    alpha = rgba[:, :, 3]
    alpha_min = int(alpha.min())
    alpha_max = int(alpha.max())
    if (not source_has_alpha or alpha_min == 255) and not config.allow_opaque:
        raise NoUsableAlphaChannelError(
            "This image cannot be separated using alpha-channel extraction."
        )

    low_mask = alpha > config.alpha_threshold
    if not np.any(low_mask):
        empty = np.zeros_like(low_mask, dtype=np.uint8)
        return DetectionResult(image, rgba, alpha, low_mask, low_mask, empty, [], [])

    core_mask = alpha > config.core_alpha_threshold
    # Semi-transparent source art can be entirely below the core threshold.
    if not np.any(core_mask):
        core_mask = low_mask.copy()
    if config.allow_opaque and alpha_min == 255:
        low_mask = np.ones_like(alpha, dtype=bool)
        core_mask = low_mask.copy()

    low_count, low_labels, low_stats, _ = cv2.connectedComponentsWithStats(
        low_mask.astype(np.uint8), connectivity=8
    )
    count, labels, stats, centroids = cv2.connectedComponentsWithStats(
        core_mask.astype(np.uint8), connectivity=8
    )
    del low_count
    core_labels = labels[core_mask]
    core_alpha = alpha[core_mask].astype(np.int64)
    alpha_mass_by_label = np.bincount(
        core_labels,
        weights=core_alpha,
        minlength=count,
    ).astype(np.int64)
    maximum_alpha_by_label = np.zeros(count, dtype=np.uint8)
    np.maximum.at(maximum_alpha_by_label, core_labels, alpha[core_mask])
    low_label_by_core = np.zeros(count, dtype=np.int32)
    # A core component is connected inside the lower alpha mask, so it maps
    # to one low-alpha component. Vectorizing this avoids one full-image scan
    # per component on particle-heavy artwork.
    low_label_by_core[core_labels] = low_labels[core_mask]

    raw_components: list[Component] = []
    rejected: list[dict[str, Any]] = []

    for label in range(1, count):
        bounds = _bounds_from_stats(stats[label])
        core_area = int(stats[label, cv2.CC_STAT_AREA])
        alpha_mass = int(alpha_mass_by_label[label])
        low_ids = [int(low_label_by_core[label])] if low_label_by_core[label] else []
        extended_bounds = bounds
        for low_id in low_ids:
            extended_bounds = extended_bounds.union(_bounds_from_stats(low_stats[low_id]))
        raw_components.append(
            Component(
                label=label,
                bounds=extended_bounds,
                core_area=core_area,
                alpha_mass=alpha_mass,
                maximum_alpha=int(maximum_alpha_by_label[label]),
                mean_visible_alpha=round(alpha_mass / max(core_area, 1), 3),
                centroid_x=round(float(centroids[label][0]), 3),
                centroid_y=round(float(centroids[label][1]), 3),
                low_alpha_labels=low_ids,
            )
        )

    repeating_pattern = _repeating_pattern_component(raw_components, config)
    particle_field = _particle_field_component(raw_components, config)
    uniform_dot_field = _uniform_dot_field_component(raw_components, config)
    if repeating_pattern is not None:
        components = [repeating_pattern]
    elif particle_field is not None:
        components = [particle_field]
    elif uniform_dot_field is not None:
        components = [uniform_dot_field]
    else:
        particle_fields, particle_labels = _particle_field_clusters(raw_components, config)
        remaining_components = [
            component for component in raw_components if component.label not in particle_labels
        ]
        composition_fields, composition_labels = _composition_clusters(
            remaining_components,
            config,
            next_label=-len(particle_fields) - 1,
        )
        components = []
        for component in remaining_components:
            if component.label in composition_labels:
                continue
            bounds = component.bounds
            core_area = component.core_area
            alpha_mass = component.alpha_mass
            narrow = (
                bounds.width < config.noise_filter.minimum_width_px
                or bounds.height < config.noise_filter.minimum_height_px
            )
            compact = max(bounds.width, bounds.height) <= (
                max(
                    config.noise_filter.minimum_width_px,
                    config.noise_filter.minimum_height_px,
                )
                * 2
            )
            tiny = core_area < config.noise_filter.minimum_area_px
            faint = alpha_mass < config.noise_filter.minimum_alpha_mass
            # Reject accidental compact pixels, but retain thin high-alpha
            # strokes that can be meaningful arrows, dividers, or typography.
            if tiny and (faint or (narrow and compact)):
                rejected.append(
                    {
                        "label": component.label,
                        "bounds": bounds.model_dump(),
                        "core_area": core_area,
                        "alpha_mass": alpha_mass,
                        "reason": "tiny_faint_or_compact_component",
                    }
                )
                continue
            components.append(component)
        components.extend(particle_fields)
        components.extend(composition_fields)

    return DetectionResult(
        image=image,
        rgba=rgba,
        alpha=alpha,
        low_mask=low_mask,
        core_mask=core_mask,
        labels=labels,
        components=components,
        rejected_components=rejected,
    )


def write_debug_artifacts(
    result: DetectionResult,
    output_directory: Path,
    groups: list[Any] | None = None,
) -> None:
    """Write source-local diagnostics without changing the original pixels."""
    output_directory.mkdir(parents=True, exist_ok=True)
    Image.fromarray(result.alpha).save(output_directory / "alpha-channel.png")
    Image.fromarray((result.low_mask * 255).astype(np.uint8)).save(
        output_directory / "binary-mask.png"
    )
    Image.fromarray((result.core_mask * 255).astype(np.uint8)).save(
        output_directory / "cleaned-mask.png"
    )

    colored = np.zeros((*result.labels.shape, 3), dtype=np.uint8)
    for label in np.unique(result.labels):
        if not label:
            continue
        colored[result.labels == label] = (
            (int(label) * 97) % 256,
            (int(label) * 57) % 256,
            (int(label) * 151) % 256,
        )
    Image.fromarray(colored).save(output_directory / "connected-components.png")

    bounds_image = result.image.copy()
    draw = ImageDraw.Draw(bounds_image)
    for component in result.components:
        box = component.bounds
        draw.rectangle((box.x, box.y, box.right - 1, box.bottom - 1), outline=(0, 255, 170, 255), width=2)
        draw.text((box.x + 2, box.y + 2), str(component.label), fill=(0, 255, 170, 255))
    bounds_image.save(output_directory / "detected-bounds.png")

    if groups is not None:
        grouped = result.image.copy()
        draw = ImageDraw.Draw(grouped)
        for index, group in enumerate(groups, start=1):
            box = group.bounds
            draw.rectangle((box.x, box.y, box.right - 1, box.bottom - 1), outline=(255, 191, 0, 255), width=3)
            draw.text((box.x + 2, box.y + 2), f"G{index}", fill=(255, 191, 0, 255))
        grouped.save(output_directory / "grouped-components.png")
