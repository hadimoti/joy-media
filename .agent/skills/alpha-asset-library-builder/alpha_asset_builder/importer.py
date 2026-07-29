"""Importer-neutral package reader for JOY Media or other downstream systems."""

from __future__ import annotations

from pathlib import Path

from .manifest import OutputLayout, load_manifest
from .models import ImportedAsset


def load_imported_assets(package_path: str | Path) -> list[ImportedAsset]:
    layout = OutputLayout(Path(package_path))
    return [
        ImportedAsset(
            id=record.id,
            filePath=record.filePath or "",
            title=record.title,
            category=record.category,
            description=record.description,
            tags=record.tags,
            sourceFile=record.source.file,
        )
        for record in load_manifest(layout)
        if record.exported
    ]

