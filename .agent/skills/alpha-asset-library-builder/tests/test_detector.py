from __future__ import annotations

from alpha_asset_builder.config import ExtractionConfig
from alpha_asset_builder.detector import NoUsableAlphaChannelError, detect_components
from alpha_asset_builder.grouping import group_components


def test_detects_one_object_and_tight_bounds(fixtures):
    result = detect_components(fixtures / "single-object.png", ExtractionConfig())
    assert len(result.components) == 1
    assert result.components[0].bounds.model_dump() == {
        "x": 30,
        "y": 40,
        "width": 101,
        "height": 91,
    }


def test_detects_independent_objects(fixtures):
    result = detect_components(fixtures / "multiple-independent.png", ExtractionConfig())
    assert len(result.components) == 2
    assert len(group_components(result.components, ExtractionConfig())) == 2


def test_keeps_low_alpha_glow(fixtures):
    result = detect_components(fixtures / "low-alpha-glow.png", ExtractionConfig())
    assert len(result.components) == 1
    assert result.components[0].bounds.model_dump() == {
        "x": 70,
        "y": 32,
        "width": 153,
        "height": 133,
    }


def test_filters_tiny_noise_without_rejecting_main_asset(fixtures):
    result = detect_components(fixtures / "noise-filter.png", ExtractionConfig())
    assert len(result.components) == 1
    assert len(result.rejected_components) == 1


def test_handles_many_objects(fixtures):
    result = detect_components(fixtures / "many-objects.png", ExtractionConfig())
    assert len(result.components) == 121


def test_collapses_a_dense_particle_field_into_one_composition(fixtures):
    result = detect_components(fixtures / "particle-field.png", ExtractionConfig())
    assert len(result.components) == 1
    assert result.components[0].label == -1
    assert len(group_components(result.components, ExtractionConfig())) == 1


def test_groups_particle_clusters_without_merging_nearby_large_art(fixtures):
    result = detect_components(fixtures / "mixed-particle-sheet.png", ExtractionConfig())
    assert len(result.components) == 2
    assert len(group_components(result.components, ExtractionConfig())) == 2
    assert any(component.label < 0 for component in result.components)


def test_groups_compact_multi_part_compositions(fixtures):
    result = detect_components(fixtures / "composition-cluster.png", ExtractionConfig())
    assert len(result.components) == 2
    assert len(group_components(result.components, ExtractionConfig())) == 2
    assert any(component.label < 0 for component in result.components)


def test_collapses_regular_glyph_patterns_into_one_asset(fixtures):
    result = detect_components(fixtures / "repeating-pattern.png", ExtractionConfig())
    assert len(result.components) == 1
    assert result.components[0].label == -1


def test_collapses_a_uniform_dot_field_without_absorbing_a_separate_logo(fixtures):
    result = detect_components(fixtures / "uniform-dot-field.png", ExtractionConfig())
    assert len(result.components) == 2
    assert any(component.label < 0 for component in result.components)
    assert any(component.label > 0 for component in result.components)
    assert len(group_components(result.components, ExtractionConfig())) == 2


def test_rejects_fully_opaque_sources_without_opt_in(fixtures):
    try:
        detect_components(fixtures / "fully-opaque.png", ExtractionConfig())
    except NoUsableAlphaChannelError as error:
        assert "cannot be separated" in str(error)
    else:
        raise AssertionError("Expected a no-alpha error")


def test_supports_semi_transparent_asset_without_core_pixels(fixtures):
    result = detect_components(fixtures / "semi-transparent-only.png", ExtractionConfig())
    assert len(result.components) == 1
