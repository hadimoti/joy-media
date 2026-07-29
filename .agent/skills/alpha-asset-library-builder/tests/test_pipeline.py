from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw
from typer.testing import CliRunner

from alpha_asset_builder.cli import app
from alpha_asset_builder.cloud_import import prepare_cloud_import
from alpha_asset_builder.config import ExtractionConfig
from alpha_asset_builder.pipeline import process_asset_archive


def test_exports_rgba_assets_sidecars_manifests_and_contact_sheet(fixtures, tmp_path):
    output = tmp_path / "package"
    result = process_asset_archive(
        fixtures / "multiple-independent.png",
        output,
        recursive=False,
        config=ExtractionConfig(),
    )
    assert result.exported_assets == 2
    manifest = json.loads((output / "manifests" / "manifest.json").read_text(encoding="utf-8"))
    assert len(manifest["assets"]) == 2
    asset = next((output / "assets").rglob("*.png"))
    with Image.open(asset) as image:
        assert image.mode == "RGBA"
    assert asset.with_suffix(".json").exists()
    assert list((output / "contact-sheets").glob("contact-sheet-*.png"))
    assert (output / "review-needed.csv").exists()
    assert (output / "reports" / "semantic-review-requests.jsonl").exists()


def test_resume_skips_unchanged_sheet(fixtures, tmp_path):
    output = tmp_path / "package"
    first = process_asset_archive(fixtures / "single-object.png", output, recursive=False, resume=True)
    second = process_asset_archive(fixtures / "single-object.png", output, recursive=False, resume=True)
    assert first.exported_assets == 1
    assert second.skipped_sources == 1


def test_exact_duplicates_are_not_exported_twice(fixtures, tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    payload = (fixtures / "single-object.png").read_bytes()
    (source / "first.png").write_bytes(payload)
    (source / "second.png").write_bytes(payload)
    output = tmp_path / "package"
    result = process_asset_archive(source, output, recursive=True, workers=2)
    assert result.exported_assets == 1
    assert result.exact_duplicates == 1
    duplicates = json.loads((output / "reports" / "duplicate-assets.json").read_text(encoding="utf-8"))
    assert len(duplicates) == 1


def test_bad_and_opaque_sources_do_not_abort_batch(fixtures, tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "valid.png").write_bytes((fixtures / "single-object.png").read_bytes())
    (source / "opaque.png").write_bytes((fixtures / "fully-opaque.png").read_bytes())
    (source / "broken.png").write_bytes(b"not a png")
    output = tmp_path / "package"
    result = process_asset_archive(source, output, recursive=True)
    assert result.exported_assets == 1
    assert result.failed_sources == 2


def test_edge_crop_and_unicode_source_filename(fixtures, tmp_path):
    source = tmp_path / "ایموجی.png"
    source.write_bytes((fixtures / "edge-object.png").read_bytes())
    output = tmp_path / "package"
    result = process_asset_archive(source, output, recursive=False)
    assert result.exported_assets == 1
    record = json.loads((output / "manifests" / "manifest.json").read_text(encoding="utf-8"))["assets"][0]
    assert record["exportBounds"]["x"] == 0
    assert record["source"]["file"] == "ایموجی.png"


def test_allow_opaque_exports_one_asset(fixtures, tmp_path):
    output = tmp_path / "package"
    result = process_asset_archive(
        fixtures / "fully-opaque.png",
        output,
        recursive=False,
        config=ExtractionConfig(allow_opaque=True),
    )
    assert result.exported_assets == 1


def test_apply_review_renames_and_reorganizes_asset(fixtures, tmp_path):
    output = tmp_path / "package"
    process_asset_archive(fixtures / "single-object.png", output, recursive=False)
    manifest_path = output / "manifests" / "manifest.json"
    record = json.loads(manifest_path.read_text(encoding="utf-8"))["assets"][0]
    corrections = tmp_path / "corrections.csv"
    corrections.write_text(
        "id,filename,title,category,description,tags,colors,orientation,confidence\n"
        f"{record['id']},approved-red-icon,Approved Red Icon,icon,A red reviewed icon,red|reviewed,red,none,0.99\n",
        encoding="utf-8",
    )
    response = CliRunner().invoke(
        app,
        ["apply-review", str(corrections), "--output", str(output)],
    )
    assert response.exit_code == 0, response.output
    revised = json.loads(manifest_path.read_text(encoding="utf-8"))["assets"][0]
    assert revised["filename"] == "approved-red-icon.png"
    assert revised["category"] == "icon"
    assert (output / revised["filePath"]).exists()


def test_prepare_cloud_uses_file_hashes_and_opaque_staging_refs(fixtures, tmp_path):
    output = tmp_path / "package"
    process_asset_archive(fixtures / "single-object.png", output, recursive=False)
    payload = prepare_cloud_import(output)
    manifest = json.loads(Path(payload["manifest"]).read_text(encoding="utf-8"))
    asset = manifest["assets"][0]
    staged = Path(payload["staging"]) / asset["ref"]
    assert asset["id"] == asset["ref"]
    assert asset["sha256"] != asset["source"]["exactRgbaHash"]
    assert staged.exists()
    assert staged.stat().st_size == asset["bytes"]
    assert "joy-media-library" in asset["tags"]


def test_prepare_cloud_skips_tiny_artifacts_from_the_publish_manifest(tmp_path):
    source = tmp_path / "source.png"
    image = Image.new("RGBA", (240, 200), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((20, 20, 120, 120), radius=12, fill=(240, 90, 60, 255))
    draw.ellipse((188, 168, 198, 179), fill=(0, 0, 0, 255))
    image.save(source)

    output = tmp_path / "package"
    result = process_asset_archive(source, output, recursive=False)
    assert result.exported_assets == 2

    payload = prepare_cloud_import(output)
    manifest = json.loads(Path(payload["manifest"]).read_text(encoding="utf-8"))
    assert payload["assets"] == 1
    assert payload["skipped"] == 1
    assert manifest["qualityGate"]["minimumAlphaPixelArea"] == 128
    assert manifest["qualityGate"]["skippedAssets"][0]["reason"] == (
        "below_minimum_alpha_pixel_area"
    )
