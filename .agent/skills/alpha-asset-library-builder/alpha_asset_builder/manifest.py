"""Output layout, sidecars, manifests, reports, and review queues."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Iterable

from .models import AssetRecord, PROCESSING_VERSION, ProcessingResult, utc_now


CSV_COLUMNS = [
    "id",
    "filename",
    "title",
    "category",
    "description",
    "tags",
    "colors",
    "orientation",
    "confidence",
    "source_file",
    "source_relative_path",
    "source_x",
    "source_y",
    "source_width",
    "source_height",
    "export_width",
    "export_height",
    "exact_hash",
    "perceptual_hash",
    "duplicate_of",
]


class OutputLayout:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve()
        self.assets = self.root / "assets"
        self.contact_sheets = self.root / "contact-sheets"
        self.manifests = self.root / "manifests"
        self.reports = self.root / "reports"
        self.checkpoints = self.root / "checkpoints"
        self.debug = self.root / "debug"

    def ensure(self) -> None:
        for directory in (
            self.assets,
            self.contact_sheets,
            self.manifests,
            self.reports,
            self.checkpoints,
            self.debug,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    @property
    def manifest_json(self) -> Path:
        return self.manifests / "manifest.json"

    @property
    def manifest_csv(self) -> Path:
        return self.manifests / "manifest.csv"


def load_manifest(layout: OutputLayout) -> list[AssetRecord]:
    if not layout.manifest_json.exists():
        return []
    payload = json.loads(layout.manifest_json.read_text(encoding="utf-8"))
    records = payload.get("assets", payload) if isinstance(payload, dict) else payload
    return [AssetRecord.model_validate(record) for record in records]


def write_sidecar(asset_path: Path, record: AssetRecord) -> Path:
    sidecar_path = asset_path.with_suffix(".json")
    sidecar_path.write_text(
        json.dumps(record.model_dump(mode="json"), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return sidecar_path


def _write_csv(path: Path, rows: Iterable[dict[str, object]], fields: list[str]) -> None:
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)


def _review_reason(record: AssetRecord) -> str | None:
    reasons: list[str] = []
    if record.confidence < 0.65:
        reasons.append("low_confidence")
    if record.category == "unknown":
        reasons.append("unknown_category")
    if record.exportBounds.width < 8 or record.exportBounds.height < 8:
        reasons.append("extremely_small")
    if record.exportBounds.width > 4096 or record.exportBounds.height > 4096:
        reasons.append("unusually_large")
    if record.duplicateOf:
        reasons.append("duplicate_relation")
    return "|".join(reasons) if reasons else None


def write_outputs(
    layout: OutputLayout,
    records: list[AssetRecord],
    result: ProcessingResult,
) -> None:
    """Publish deterministic reports after each run so interruption loses no metadata."""
    layout.ensure()
    payload = {
        "processingVersion": PROCESSING_VERSION,
        "generatedAt": utc_now(),
        "assets": [record.model_dump(mode="json") for record in records],
    }
    layout.manifest_json.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    _write_csv(layout.manifest_csv, (record.csv_row() for record in records), CSV_COLUMNS)

    report = result.model_dump(mode="json")
    report["generatedAt"] = utc_now()
    (layout.reports / "processing-report.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    failed = [
        source.model_dump(mode="json")
        for source in result.source_results
        if source.status not in {"complete", "skipped"}
    ]
    (layout.reports / "failed-files.json").write_text(
        json.dumps(failed, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    duplicates = [
        record.model_dump(mode="json") for record in records if record.duplicateOf
    ]
    (layout.reports / "duplicate-assets.json").write_text(
        json.dumps(duplicates, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    semantic_requests = [
        {
            "key": record.semanticKey or record.id,
            "assetId": record.id,
            "filePath": record.filePath,
            "sourceFile": record.source.file,
            "sourceRelativePath": record.source.relativePath,
            "titleHint": record.title,
            "categoryHint": record.category,
            "instruction": "Return visible, factual English metadata for this isolated transparent asset.",
        }
        for record in records
        if record.exported and record.confidence < 0.65
    ]
    with (layout.reports / "semantic-review-requests.jsonl").open(
        "w", encoding="utf-8"
    ) as handle:
        for request in semantic_requests:
            handle.write(json.dumps(request, ensure_ascii=False) + "\n")
    review_rows = []
    for record in records:
        reason = _review_reason(record)
        if reason:
            row = record.csv_row()
            row["review_reason"] = reason
            row["file_path"] = record.filePath or ""
            review_rows.append(row)
    _write_csv(
        layout.root / "review-needed.csv",
        review_rows,
        [*CSV_COLUMNS, "review_reason", "file_path"],
    )


def rebuild_records_from_sidecars(layout: OutputLayout) -> list[AssetRecord]:
    records: list[AssetRecord] = []
    for sidecar in sorted(layout.assets.rglob("*.json"), key=lambda path: str(path).casefold()):
        try:
            records.append(AssetRecord.model_validate_json(sidecar.read_text(encoding="utf-8")))
        except (OSError, ValueError):
            continue
    return records
