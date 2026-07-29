"""Pydantic configuration models and safe configuration loading."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field


class NoiseFilterConfig(BaseModel):
    minimum_area_px: int = Field(default=10, ge=0)
    minimum_width_px: int = Field(default=2, ge=1)
    minimum_height_px: int = Field(default=2, ge=1)
    minimum_alpha_mass: int = Field(default=200, ge=0)


class GroupingConfig(BaseModel):
    enabled: bool = True
    max_gap_px: int = Field(default=14, ge=0)
    max_gap_ratio: float = Field(default=0.04, ge=0)
    expanded_box_px: int = Field(default=8, ge=0)
    shadow_gap_px: int = Field(default=24, ge=0)
    attach_small_components: bool = True
    small_component_area_ratio: float = Field(default=0.08, ge=0, le=1)
    particle_field_grouping: bool = True
    particle_minimum_components: int = Field(default=128, ge=2)
    particle_max_median_area_px: int = Field(default=64, ge=1)
    particle_max_component_area_px: int = Field(default=128, ge=1)
    particle_minimum_small_component_ratio: float = Field(default=0.75, ge=0, le=1)
    particle_max_coverage: float = Field(default=0.12, ge=0, le=1)
    particle_cluster_gap_px: int = Field(default=24, ge=1)
    particle_cluster_max_component_area_px: int = Field(default=4096, ge=1)
    particle_cluster_max_median_area_px: int = Field(default=160, ge=1)
    composition_cluster_grouping: bool = True
    composition_cluster_gap_px: int = Field(default=8, ge=1)
    composition_cluster_minimum_components: int = Field(default=3, ge=2)
    composition_cluster_max_coverage: float = Field(default=0.30, ge=0, le=1)
    repeating_pattern_grouping: bool = True
    repeating_pattern_minimum_components: int = Field(default=64, ge=2)
    repeating_pattern_minimum_median_area_px: int = Field(default=512, ge=1)
    repeating_pattern_max_interquartile_area_ratio: float = Field(default=1.5, ge=1)
    repeating_pattern_max_interquartile_dimension_ratio: float = Field(default=1.35, ge=1)
    repeating_pattern_max_coverage: float = Field(default=0.45, ge=0, le=1)
    uniform_dot_field_grouping: bool = True
    uniform_dot_field_minimum_components: int = Field(default=512, ge=2)
    uniform_dot_field_max_component_area_px: int = Field(default=128, ge=1)
    uniform_dot_field_max_component_dimension_px: int = Field(default=16, ge=1)
    uniform_dot_field_max_median_area_px: int = Field(default=128, ge=1)
    uniform_dot_field_max_interquartile_area_ratio: float = Field(default=1.5, ge=1)
    uniform_dot_field_max_interquartile_dimension_ratio: float = Field(default=1.35, ge=1)
    uniform_dot_field_max_coverage: float = Field(default=0.28, ge=0, le=1)


class PaddingConfig(BaseModel):
    mode: Literal["pixels", "percent"] = "pixels"
    value: float = Field(default=8, ge=0)


class ExtractionConfig(BaseModel):
    alpha_threshold: int = Field(default=4, ge=0, le=254)
    core_alpha_threshold: int = Field(default=24, ge=1, le=255)
    padding: PaddingConfig = Field(default_factory=PaddingConfig)
    noise_filter: NoiseFilterConfig = Field(default_factory=NoiseFilterConfig)
    grouping: GroupingConfig = Field(default_factory=GroupingConfig)
    semantic_confidence_threshold: float = Field(default=0.65, ge=0, le=1)
    visual_duplicate_threshold: int = Field(default=6, ge=0, le=64)
    contact_sheet_columns: int = Field(default=5, ge=1)
    contact_sheet_rows: int = Field(default=7, ge=1)
    allow_opaque: bool = False
    split_text_characters: bool = False
    keep_exact_duplicates: bool = False
    skip_visual_duplicates: bool = False
    generate_names: bool = True
    generate_contact_sheets: bool = True
    debug: bool = False
    largest_only: bool = False
    minimum_area: int | None = Field(default=None, ge=0)
    dry_run: bool = False

    def resolved_padding(self, bounds_width: int, bounds_height: int) -> int:
        if self.padding.mode == "pixels":
            return round(self.padding.value)
        return round(max(bounds_width, bounds_height) * self.padding.value / 100)


def load_config(path: Path | None) -> ExtractionConfig:
    if path is None:
        return ExtractionConfig()
    payload = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    return ExtractionConfig.model_validate(payload)
