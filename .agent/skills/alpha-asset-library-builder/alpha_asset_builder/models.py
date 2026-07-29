"""Stable data models shared by extraction, manifests, and import adapters."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field


PROCESSING_VERSION = "1.0.0"


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class Bounds(BaseModel):
    x: int
    y: int
    width: int
    height: int

    @property
    def right(self) -> int:
        return self.x + self.width

    @property
    def bottom(self) -> int:
        return self.y + self.height

    @property
    def area(self) -> int:
        return self.width * self.height

    @property
    def center(self) -> tuple[float, float]:
        return (self.x + self.width / 2, self.y + self.height / 2)

    def union(self, other: "Bounds") -> "Bounds":
        left = min(self.x, other.x)
        top = min(self.y, other.y)
        right = max(self.right, other.right)
        bottom = max(self.bottom, other.bottom)
        return Bounds(x=left, y=top, width=right - left, height=bottom - top)

    def expand(self, amount: int, image_width: int, image_height: int) -> "Bounds":
        left = max(0, self.x - amount)
        top = max(0, self.y - amount)
        right = min(image_width, self.right + amount)
        bottom = min(image_height, self.bottom + amount)
        return Bounds(x=left, y=top, width=right - left, height=bottom - top)


class Component(BaseModel):
    label: int
    bounds: Bounds
    core_area: int
    alpha_mass: int
    maximum_alpha: int
    mean_visible_alpha: float
    centroid_x: float
    centroid_y: float
    low_alpha_labels: list[int] = Field(default_factory=list)


class ComponentGroup(BaseModel):
    component_labels: list[int]
    bounds: Bounds


class SemanticMetadata(BaseModel):
    name: str
    category: str = "unknown"
    description: str
    tags: list[str] = Field(default_factory=list)
    colors: list[str] = Field(default_factory=list)
    orientation: Literal["left", "right", "up", "down", "front", "side", "none"] = "none"
    confidence: float = 0.0


class SourceReference(BaseModel):
    file: str
    relativePath: str


class AssetRecord(BaseModel):
    id: str
    filename: str
    title: str
    category: str
    description: str
    tags: list[str]
    colors: list[str]
    orientation: str
    confidence: float
    source: SourceReference
    tightBounds: Bounds
    exportBounds: Bounds
    alphaPixelArea: int
    componentCount: int
    exactHash: str
    perceptualHash: str
    duplicateOf: str | None = None
    filePath: str | None = None
    semanticKey: str | None = None
    exported: bool = True
    createdAt: str = Field(default_factory=utc_now)
    processingVersion: str = PROCESSING_VERSION

    def csv_row(self) -> dict[str, str | int | float]:
        return {
            "id": self.id,
            "filename": self.filename,
            "title": self.title,
            "category": self.category,
            "description": self.description,
            "tags": "|".join(self.tags),
            "colors": "|".join(self.colors),
            "orientation": self.orientation,
            "confidence": self.confidence,
            "source_file": self.source.file,
            "source_relative_path": self.source.relativePath,
            "source_x": self.tightBounds.x,
            "source_y": self.tightBounds.y,
            "source_width": self.tightBounds.width,
            "source_height": self.tightBounds.height,
            "export_width": self.exportBounds.width,
            "export_height": self.exportBounds.height,
            "exact_hash": self.exactHash,
            "perceptual_hash": self.perceptualHash,
            "duplicate_of": self.duplicateOf or "",
        }


class SourceResult(BaseModel):
    source_path: str
    source_hash: str
    status: str
    extracted_assets: int = 0
    skipped_exact_duplicates: int = 0
    error: str | None = None


class ProcessingResult(BaseModel):
    input_path: str
    output_path: str
    processed_sources: int = 0
    skipped_sources: int = 0
    exported_assets: int = 0
    exact_duplicates: int = 0
    visual_duplicates: int = 0
    failed_sources: int = 0
    source_results: list[SourceResult] = Field(default_factory=list)
    processing_version: str = PROCESSING_VERSION


class ImportedAsset(BaseModel):
    id: str
    filePath: str
    title: str
    category: str
    description: str
    tags: list[str]
    sourceFile: str
