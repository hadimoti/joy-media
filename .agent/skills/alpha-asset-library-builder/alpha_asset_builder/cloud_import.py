"""Prepare a verified, private-object import package for JOY Media."""

from __future__ import annotations

import json
import os
import shutil
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any

from PIL import Image

from .manifest import OutputLayout, load_manifest
from .naming import slugify


CLOUD_IMPORT_SCHEMA_VERSION = 1
DEFAULT_PROJECT_ID = "joy-media-alpha-library"
DEFAULT_PROJECT_TITLE = "JOY Media Asset Library"
DEFAULT_OWNER_ID = "joy-media-library"
DEFAULT_MINIMUM_ALPHA_PIXEL_AREA = 128


def _file_sha256(path: Path) -> str:
    digest = sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_display_name(value: str, fallback: str) -> str:
    cleaned = value.strip().replace("/", " ").replace("\\", " ")
    return cleaned[:255] or fallback


def _safe_tag(value: str) -> str | None:
    normalized = slugify(value).replace("_", "-")[:48]
    if not normalized or not normalized[0].isalnum():
        return None
    return normalized


def _tags_for_record(category: str, tags: list[str]) -> list[str]:
    values = ["joy-media-library", f"category-{_safe_tag(category) or 'unknown'}"]
    values.extend(tag for tag in (_safe_tag(raw) for raw in tags) if tag)
    result: list[str] = []
    for value in values:
        if value not in result:
            result.append(value)
    return result[:32]


def _stage_file(source: Path, destination: Path, expected_hash: str) -> str:
    if destination.exists():
        if _file_sha256(destination) != expected_hash:
            raise ValueError(f"staging collision at {destination}")
        return "existing"
    try:
        os.link(source, destination)
        return "hardlink"
    except OSError:
        # Cross-volume output paths are uncommon, but a verified copy is safer
        # than silently failing an otherwise valid publish preparation.
        shutil.copyfile(source, destination)
        if _file_sha256(destination) != expected_hash:
            raise ValueError(f"staging copy failed integrity verification for {source}")
        return "copy"


def prepare_cloud_import(
    package_path: Path,
    staging_path: Path | None = None,
    *,
    project_id: str = DEFAULT_PROJECT_ID,
    project_title: str = DEFAULT_PROJECT_TITLE,
    owner_id: str = DEFAULT_OWNER_ID,
    minimum_alpha_pixel_area: int = DEFAULT_MINIMUM_ALPHA_PIXEL_AREA,
) -> dict[str, Any]:
    """Emit upload-ready private-object names and API registration metadata."""
    if minimum_alpha_pixel_area < 0:
        raise ValueError("minimum_alpha_pixel_area must be zero or greater")
    layout = OutputLayout(package_path)
    records = load_manifest(layout)
    if not records:
        raise ValueError(f"no manifest assets found in {layout.manifest_json}")

    staging = (staging_path or (layout.root / "cloud-staging")).resolve()
    staging.mkdir(parents=True, exist_ok=True)
    assets: list[dict[str, Any]] = []
    staged: dict[str, str] = {}
    skipped_assets: list[dict[str, Any]] = []

    for record in records:
        if not record.exported or not record.filePath:
            continue
        if record.alphaPixelArea < minimum_alpha_pixel_area:
            skipped_assets.append(
                {
                    "assetId": record.id,
                    "filePath": record.filePath,
                    "alphaPixelArea": record.alphaPixelArea,
                    "reason": "below_minimum_alpha_pixel_area",
                }
            )
            continue
        source = (layout.root / record.filePath).resolve()
        if not source.is_file() or layout.root not in source.parents:
            raise ValueError(f"manifest file path is not a package asset: {record.filePath}")
        file_hash = _file_sha256(source)
        ref = f"joylib-{file_hash}"
        stage_mode = staged.get(ref)
        if stage_mode is None:
            stage_mode = _stage_file(source, staging / ref, file_hash)
            staged[ref] = stage_mode
        with Image.open(source) as image:
            width, height = image.size
        assets.append(
            {
                "id": ref,
                "ref": ref,
                "filePath": source.relative_to(layout.root).as_posix(),
                "sha256": file_hash,
                "bytes": source.stat().st_size,
                "displayName": _safe_display_name(record.title, record.id),
                "sortName": _safe_display_name(record.title, record.id).lower(),
                "tags": _tags_for_record(record.category, record.tags),
                "descriptor": {
                    "mimeType": "image/png",
                    "width": width,
                    "height": height,
                },
                "source": {
                    "assetId": record.id,
                    "exactRgbaHash": record.exactHash,
                    "perceptualHash": record.perceptualHash,
                    "category": record.category,
                },
                "staging": {"mode": stage_mode},
            }
        )

    if not assets:
        raise ValueError("manifest contains no exported asset files")

    payload = {
        "schemaVersion": CLOUD_IMPORT_SCHEMA_VERSION,
        "generatedAt": datetime.now(UTC).isoformat(),
        "project": {
            "id": project_id,
            "title": project_title,
            "ownerId": owner_id,
        },
        "stagingPath": str(staging),
        "qualityGate": {
            "minimumAlphaPixelArea": minimum_alpha_pixel_area,
            "skippedAssets": skipped_assets,
        },
        "assets": assets,
    }
    output = layout.manifests / "cloud-import-manifest.json"
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "manifest": str(output),
        "staging": str(staging),
        "assets": len(assets),
        "hardlinks": sum(mode == "hardlink" for mode in staged.values()),
        "copies": sum(mode == "copy" for mode in staged.values()),
        "existing": sum(mode == "existing" for mode in staged.values()),
        "skipped": len(skipped_assets),
    }
