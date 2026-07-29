"""Paginated, non-destructive asset contact sheets for visual review."""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from .duplicate_detector import checkerboard_preview
from .models import AssetRecord


def _safe_label(value: str) -> str:
    return value.encode("ascii", "replace").decode("ascii")


def build_contact_sheets(
    records: list[AssetRecord],
    output_directory: Path,
    package_root: Path | None = None,
    columns: int = 5,
    rows: int = 7,
) -> list[Path]:
    """Render previews on a checkerboard while retaining untouched PNG assets."""
    output_directory.mkdir(parents=True, exist_ok=True)

    package_root = package_root or output_directory.parent
    exported = []
    for record in records:
        if not record.exported or not record.filePath:
            continue
        candidate = Path(record.filePath)
        asset_path = candidate if candidate.is_absolute() else package_root / candidate
        if asset_path.exists():
            exported.append(record)
    per_page = columns * rows
    cell_width, cell_height = 250, 308
    font = ImageFont.load_default()
    outputs: list[Path] = []
    for page_index, start in enumerate(range(0, len(exported), per_page), start=1):
        batch = exported[start : start + per_page]
        sheet = Image.new(
            "RGB",
            (columns * cell_width, rows * cell_height),
            "#171a1d",
        )
        draw = ImageDraw.Draw(sheet)
        for offset, record in enumerate(batch):
            column, row = offset % columns, offset // columns
            x, y = column * cell_width, row * cell_height
            draw.rectangle((x + 4, y + 4, x + cell_width - 5, y + cell_height - 5), outline="#3d454c")
            candidate = Path(record.filePath or "")
            asset_path = candidate if candidate.is_absolute() else package_root / candidate
            with Image.open(asset_path) as source:
                preview = checkerboard_preview(source, 220)
            sheet.paste(preview, (x + 15, y + 12))
            labels = [
                _safe_label(record.filename),
                f"{record.category} | {record.exportBounds.width}x{record.exportBounds.height} | {record.confidence:.2f}",
                _safe_label(record.source.file)[:34],
                record.id,
            ]
            draw.multiline_text((x + 12, y + 238), "\n".join(labels), fill="#f5f5f5", font=font, spacing=3)
        destination = output_directory / f"contact-sheet-{page_index:04d}.png"
        sheet.save(destination)
        outputs.append(destination)
    return outputs
