"""Conservative composition grouping for detached alpha regions."""

from __future__ import annotations

from collections import defaultdict
from math import hypot

from .config import ExtractionConfig
from .models import Bounds, Component, ComponentGroup


class UnionFind:
    def __init__(self, values: list[int]) -> None:
        self.parent = {value: value for value in values}

    def find(self, value: int) -> int:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, left: int, right: int) -> None:
        left_root, right_root = self.find(left), self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def _axis_gap(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    return max(a_start - b_end, b_start - a_end, 0)


def _box_gap(left: Bounds, right: Bounds) -> tuple[int, int, float]:
    horizontal = _axis_gap(left.x, left.right, right.x, right.right)
    vertical = _axis_gap(left.y, left.bottom, right.y, right.bottom)
    return horizontal, vertical, hypot(horizontal, vertical)


def _horizontal_overlap(left: Bounds, right: Bounds) -> float:
    overlap = max(0, min(left.right, right.right) - max(left.x, right.x))
    return overlap / max(1, min(left.width, right.width))


def _shares_low_alpha_bridge(left: Component, right: Component) -> bool:
    return bool(set(left.low_alpha_labels).intersection(right.low_alpha_labels))


def _looks_like_text_pair(left: Component, right: Component, horizontal_gap: int) -> bool:
    if horizontal_gap <= 0:
        return False
    left_box, right_box = left.bounds, right.bounds
    height_ratio = min(left_box.height, right_box.height) / max(left_box.height, right_box.height)
    baseline_delta = abs(left_box.bottom - right_box.bottom)
    # Restrict automatic word joining to narrow glyphs, not nearby square icons.
    glyph_like = (
        max(left_box.width / max(left_box.height, 1), right_box.width / max(right_box.height, 1)) <= 0.75
    )
    return height_ratio >= 0.65 and baseline_delta <= max(left_box.height, right_box.height) * 0.28 and glyph_like


def _should_group(
    left: Component,
    right: Component,
    config: ExtractionConfig,
) -> bool:
    grouping = config.grouping
    if _shares_low_alpha_bridge(left, right):
        return True

    horizontal_gap, vertical_gap, distance = _box_gap(left.bounds, right.bounds)
    max_gap = max(grouping.max_gap_px, round(max(
        left.bounds.width,
        left.bounds.height,
        right.bounds.width,
        right.bounds.height,
    ) * grouping.max_gap_ratio))
    if distance > max(grouping.shadow_gap_px, max_gap):
        return False

    smaller, larger = sorted((left, right), key=lambda component: component.core_area)
    if (
        grouping.attach_small_components
        and smaller.core_area / max(larger.core_area, 1) <= grouping.small_component_area_ratio
        and distance <= max_gap + grouping.expanded_box_px
    ):
        return True

    # A detached shadow generally shares horizontal coverage but sits below its subject.
    if (
        vertical_gap > 0
        and vertical_gap <= grouping.shadow_gap_px
        and _horizontal_overlap(left.bounds, right.bounds) >= 0.45
    ):
        return True

    # Keep ordinary adjacent icons apart; only text-shaped, aligned glyphs form a word.
    return (
        not config.split_text_characters
        and horizontal_gap <= max_gap
        and vertical_gap <= grouping.expanded_box_px
        and _looks_like_text_pair(left, right, horizontal_gap)
    )


def group_components(
    components: list[Component],
    config: ExtractionConfig,
) -> list[ComponentGroup]:
    if not components:
        return []
    if not config.grouping.enabled:
        return [
            ComponentGroup(component_labels=[component.label], bounds=component.bounds)
            for component in components
        ]

    union_find = UnionFind([component.label for component in components])
    for index, left in enumerate(components):
        for right in components[index + 1 :]:
            if _should_group(left, right, config):
                union_find.union(left.label, right.label)

    component_by_label = {component.label: component for component in components}
    grouped_labels: dict[int, list[int]] = defaultdict(list)
    for component in components:
        grouped_labels[union_find.find(component.label)].append(component.label)

    groups: list[ComponentGroup] = []
    for labels in grouped_labels.values():
        labels.sort()
        bounds = component_by_label[labels[0]].bounds
        for label in labels[1:]:
            bounds = bounds.union(component_by_label[label].bounds)
        groups.append(ComponentGroup(component_labels=labels, bounds=bounds))
    return sorted(groups, key=lambda group: (group.bounds.y, group.bounds.x, group.component_labels))
