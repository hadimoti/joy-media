from __future__ import annotations

from alpha_asset_builder.config import ExtractionConfig
from alpha_asset_builder.detector import detect_components
from alpha_asset_builder.grouping import group_components


def test_groups_detached_shadow(fixtures):
    result = detect_components(fixtures / "detached-shadow.png", ExtractionConfig())
    assert len(result.components) == 2
    assert len(group_components(result.components, ExtractionConfig())) == 1


def test_groups_text_and_dotted_letter(fixtures):
    result = detect_components(fixtures / "text-dotted-letter.png", ExtractionConfig())
    groups = group_components(result.components, ExtractionConfig())
    assert len(groups) == 1
    assert len(groups[0].component_labels) == len(result.components)


def test_does_not_merge_close_square_assets(fixtures, tmp_path):
    from PIL import Image, ImageDraw

    source = tmp_path / "close-squares.png"
    image = Image.new("RGBA", (150, 80), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rectangle((10, 20, 40, 50), fill=(255, 255, 255, 255))
    draw.rectangle((50, 20, 80, 50), fill=(255, 255, 255, 255))
    image.save(source)
    result = detect_components(source, ExtractionConfig())
    assert len(group_components(result.components, ExtractionConfig())) == 2

