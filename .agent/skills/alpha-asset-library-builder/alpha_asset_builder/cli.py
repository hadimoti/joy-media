"""Typer command line interface for the alpha asset library builder."""

from __future__ import annotations

import csv
import json
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.progress import BarColumn, Progress, TextColumn, TimeElapsedColumn
from rich.table import Table

from .checkpoint import CheckpointStore
from .cloud_import import prepare_cloud_import
from .config import ExtractionConfig, PaddingConfig, load_config
from .contact_sheet import build_contact_sheets
from .detector import NoUsableAlphaChannelError, detect_components
from .grouping import group_components
from .manifest import OutputLayout, load_manifest, rebuild_records_from_sidecars, write_outputs, write_sidecar
from .models import ProcessingResult
from .naming import FilenameAllocator, JsonlSemanticNamingProvider, slugify
from .pipeline import CATEGORY_FOLDERS, process_asset_archive


app = typer.Typer(
    name="alpha-assets",
    help="Extract transparent PNG sheets into resumable asset-library packages.",
    no_args_is_help=True,
)
console = Console()


def _effective_config(
    config_path: Optional[Path],
    alpha_threshold: Optional[int],
    core_alpha_threshold: Optional[int],
    padding: Optional[float],
    no_grouping: bool,
    no_visual_naming: bool,
    no_contact_sheet: bool,
    debug: bool,
    largest_only: bool,
    minimum_area: Optional[int],
    keep_exact_duplicates: bool,
    skip_visual_duplicates: bool,
    allow_opaque: bool,
    split_text_characters: bool,
    dry_run: bool,
    duplicate_threshold: Optional[int],
) -> ExtractionConfig:
    config = load_config(config_path)
    updates: dict[str, object] = {
        "generate_names": not no_visual_naming,
        "generate_contact_sheets": not no_contact_sheet,
        "debug": debug,
        "largest_only": largest_only,
        "minimum_area": minimum_area,
        "keep_exact_duplicates": keep_exact_duplicates,
        "skip_visual_duplicates": skip_visual_duplicates,
        "allow_opaque": allow_opaque,
        "split_text_characters": split_text_characters,
        "dry_run": dry_run,
    }
    if alpha_threshold is not None:
        updates["alpha_threshold"] = alpha_threshold
    if core_alpha_threshold is not None:
        updates["core_alpha_threshold"] = core_alpha_threshold
    if duplicate_threshold is not None:
        updates["visual_duplicate_threshold"] = duplicate_threshold
    if padding is not None:
        updates["padding"] = PaddingConfig(mode="pixels", value=padding)
    if no_grouping:
        updates["grouping"] = config.grouping.model_copy(update={"enabled": False})
    return config.model_copy(update=updates)


def _render_result(result: ProcessingResult, as_json: bool) -> None:
    if as_json:
        console.print_json(result.model_dump_json(indent=2))
        return
    table = Table(title="Alpha Asset Extraction")
    table.add_column("Metric")
    table.add_column("Value", justify="right")
    table.add_row("Processed sheets", str(result.processed_sources))
    table.add_row("Skipped sheets", str(result.skipped_sources))
    table.add_row("Exported assets", str(result.exported_assets))
    table.add_row("Exact duplicates skipped", str(result.exact_duplicates))
    table.add_row("Visual duplicate relations", str(result.visual_duplicates))
    table.add_row("Failed / no alpha", str(result.failed_sources))
    table.add_row("Output", result.output_path)
    console.print(table)


def _run_with_progress(
    *,
    input_path: Path,
    output: Optional[Path],
    recursive: bool,
    resume: bool,
    workers: int,
    config: ExtractionConfig | None = None,
    provider: JsonlSemanticNamingProvider | None = None,
    force: bool = False,
    json_output: bool = False,
) -> ProcessingResult:
    if json_output:
        return process_asset_archive(
            input_path,
            output_path=output,
            recursive=recursive,
            resume=resume,
            workers=workers,
            config=config,
            semantic_provider=provider,
            force=force,
        )
    with Progress(
        TextColumn("[progress.description]{task.description}"),
        BarColumn(),
        TextColumn("{task.completed}/{task.total} sheets"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Scanning alpha sheets", total=1)

        def update(current: int, total: int, source_result: object) -> None:
            source_path = getattr(source_result, "source_path", "")
            status = getattr(source_result, "status", "processing")
            # Legacy Windows terminals can reject non-ASCII source filenames.
            source_name = Path(str(source_path)).name.encode("ascii", "replace").decode("ascii")
            progress.update(
                task,
                total=max(total, 1),
                completed=current,
                description=f"{status}: {source_name}",
            )

        return process_asset_archive(
            input_path,
            output_path=output,
            recursive=recursive,
            resume=resume,
            workers=workers,
            config=config,
            semantic_provider=provider,
            force=force,
            on_progress=update,
        )


@app.command()
def extract(
    input_path: Path = typer.Argument(..., exists=True, readable=True),
    output: Optional[Path] = typer.Option(None, "--output", "-o"),
    recursive: bool = typer.Option(False, "--recursive"),
    resume: bool = typer.Option(False, "--resume"),
    workers: int = typer.Option(1, "--workers", min=1),
    force: bool = typer.Option(False, "--force"),
    alpha_threshold: Optional[int] = typer.Option(None, "--alpha-threshold"),
    core_alpha_threshold: Optional[int] = typer.Option(None, "--core-alpha-threshold"),
    padding: Optional[float] = typer.Option(None, "--padding"),
    config: Optional[Path] = typer.Option(None, "--config"),
    no_grouping: bool = typer.Option(False, "--no-grouping"),
    no_visual_naming: bool = typer.Option(False, "--no-visual-naming"),
    no_contact_sheet: bool = typer.Option(False, "--no-contact-sheet"),
    debug: bool = typer.Option(False, "--debug"),
    largest_only: bool = typer.Option(False, "--largest-only"),
    minimum_area: Optional[int] = typer.Option(None, "--minimum-area"),
    keep_exact_duplicates: bool = typer.Option(False, "--keep-exact-duplicates"),
    skip_visual_duplicates: bool = typer.Option(False, "--skip-visual-duplicates"),
    duplicate_threshold: Optional[int] = typer.Option(None, "--duplicate-threshold"),
    allow_opaque: bool = typer.Option(False, "--allow-opaque"),
    split_text_characters: bool = typer.Option(False, "--split-text-characters"),
    dry_run: bool = typer.Option(False, "--dry-run"),
    semantic_jsonl: Optional[Path] = typer.Option(None, "--semantic-jsonl"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Extract one PNG or a directory of PNG sheets."""
    extraction_config = _effective_config(
        config,
        alpha_threshold,
        core_alpha_threshold,
        padding,
        no_grouping,
        no_visual_naming,
        no_contact_sheet,
        debug,
        largest_only,
        minimum_area,
        keep_exact_duplicates,
        skip_visual_duplicates,
        allow_opaque,
        split_text_characters,
        dry_run,
        duplicate_threshold,
    )
    provider = JsonlSemanticNamingProvider(semantic_jsonl) if semantic_jsonl else None
    result = _run_with_progress(
        input_path=input_path,
        output=output,
        recursive=recursive,
        resume=resume,
        workers=workers,
        config=extraction_config,
        provider=provider,
        force=force,
        json_output=json_output,
    )
    _render_result(result, json_output)


@app.command()
def resume(
    input_path: Path = typer.Argument(..., exists=True, readable=True),
    output: Optional[Path] = typer.Option(None, "--output", "-o"),
    recursive: bool = typer.Option(True, "--recursive/--no-recursive"),
    workers: int = typer.Option(1, "--workers", min=1),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Continue unchanged source sheets from the persistent checkpoint."""
    result = _run_with_progress(
        input_path=input_path,
        output=output,
        recursive=recursive,
        resume=True,
        workers=workers,
        json_output=json_output,
    )
    _render_result(result, json_output)


@app.command()
def analyze(
    input_path: Path = typer.Argument(..., exists=True, readable=True),
    config: Optional[Path] = typer.Option(None, "--config"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Inspect alpha components without exporting any asset."""
    extraction_config = load_config(config)
    try:
        detection = detect_components(input_path, extraction_config)
    except NoUsableAlphaChannelError as error:
        payload = {
            "status": "no_usable_alpha_channel",
            "message": str(error),
        }
        if json_output:
            console.print_json(json.dumps(payload))
        else:
            console.print(payload["message"], style="yellow")
        raise typer.Exit(code=0)
    groups = group_components(detection.components, extraction_config)
    payload = {
        "status": "ok",
        "components": len(detection.components),
        "groups": len(groups),
        "rejected_components": detection.rejected_components,
        "bounds": [group.bounds.model_dump() for group in groups],
    }
    if json_output:
        console.print_json(json.dumps(payload))
    else:
        console.print(f"Detected {payload['components']} components in {payload['groups']} groups.")
    detection.image.close()


@app.command()
def review(
    package_path: Path = typer.Argument(..., exists=True, file_okay=False),
) -> None:
    """Regenerate paginated contact sheets from a package manifest."""
    layout = OutputLayout(package_path)
    records = load_manifest(layout)
    sheets = build_contact_sheets(records, layout.contact_sheets, package_root=layout.root)
    console.print(f"Generated {len(sheets)} contact sheet(s) in {layout.contact_sheets}.")


@app.command("prepare-cloud")
def prepare_cloud(
    package_path: Path = typer.Argument(..., exists=True, file_okay=False),
    staging: Optional[Path] = typer.Option(None, "--staging"),
    project_id: str = typer.Option("joy-media-alpha-library", "--project-id"),
    project_title: str = typer.Option("JOY Media Asset Library", "--project-title"),
    owner_id: str = typer.Option("joy-media-library", "--owner-id"),
    minimum_alpha_pixels: int = typer.Option(128, "--minimum-alpha-pixels", min=0),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Create verified opaque refs and a cloud-import manifest from a package."""
    try:
        payload = prepare_cloud_import(
            package_path,
            staging,
            project_id=project_id,
            project_title=project_title,
            owner_id=owner_id,
            minimum_alpha_pixel_area=minimum_alpha_pixels,
        )
    except ValueError as error:
        raise typer.BadParameter(str(error)) from error
    if json_output:
        console.print_json(json.dumps(payload))
    else:
        console.print(
            f"Prepared {payload['assets']} cloud asset(s) in {payload['staging']} "
            f"and wrote {payload['manifest']}."
        )


@app.command("status")
def status_command(
    package_path: Path = typer.Argument(..., exists=True, file_okay=False),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """Show checkpoint and manifest counts for an extraction package."""
    layout = OutputLayout(package_path)
    records = load_manifest(layout)
    checkpoint = CheckpointStore(layout.checkpoints / "checkpoint.sqlite3")
    try:
        payload = {
            "package": str(layout.root),
            "assets": len([record for record in records if record.exported]),
            "duplicate_records": len([record for record in records if record.duplicateOf]),
            "checkpoints": checkpoint.summary(),
        }
    finally:
        checkpoint.close()
    if json_output:
        console.print_json(json.dumps(payload))
    else:
        console.print(payload)


@app.command("rebuild-manifest")
def rebuild_manifest(
    package_path: Path = typer.Argument(..., exists=True, file_okay=False),
) -> None:
    """Rebuild manifests from PNG sidecars without modifying source images."""
    layout = OutputLayout(package_path)
    layout.ensure()
    records = rebuild_records_from_sidecars(layout)
    result = ProcessingResult(input_path="", output_path=str(layout.root), exported_assets=len(records))
    write_outputs(layout, records, result)
    console.print(f"Rebuilt manifest with {len(records)} exported assets.")


@app.command("reset-checkpoint")
def reset_checkpoint(
    package_path: Path = typer.Argument(..., exists=True, file_okay=False),
    yes: bool = typer.Option(False, "--yes", help="Confirm deletion of checkpoint rows only."),
) -> None:
    """Explicitly delete resumability records; exported assets remain untouched."""
    if not yes:
        raise typer.BadParameter("Pass --yes to delete checkpoint rows.")
    layout = OutputLayout(package_path)
    checkpoint = CheckpointStore(layout.checkpoints / "checkpoint.sqlite3")
    try:
        removed = checkpoint.reset()
    finally:
        checkpoint.close()
    console.print(f"Deleted {removed} checkpoint row(s). Exported assets were not changed.")


@app.command("apply-review")
def apply_review(
    corrections_csv: Path = typer.Argument(..., exists=True, readable=True),
    output: Optional[Path] = typer.Option(None, "--output", "-o"),
) -> None:
    """Apply reviewed metadata and collision-safe file renames from a CSV."""
    layout = OutputLayout(output or corrections_csv.parent)
    records = load_manifest(layout)
    by_id = {record.id: record for record in records}
    with corrections_csv.open("r", encoding="utf-8-sig", newline="") as handle:
        corrections = {row.get("id", ""): row for row in csv.DictReader(handle) if row.get("id")}
    allocator = FilenameAllocator([record.filename for record in records if record.filename])
    changed = 0
    for record_id, correction in corrections.items():
        record = by_id.get(record_id)
        if record is None or not record.exported or not record.filePath:
            continue
        update: dict[str, object] = {}
        for field in ("title", "category", "description", "orientation"):
            if correction.get(field):
                update[field] = correction[field]
        for field in ("tags", "colors"):
            if correction.get(field):
                update[field] = [value for value in correction[field].split("|") if value]
        if correction.get("confidence"):
            try:
                update["confidence"] = float(correction["confidence"])
            except ValueError:
                pass
        updated = record.model_copy(update=update)
        requested_name = correction.get("filename", "").strip()
        if requested_name:
            category = updated.category if updated.category in CATEGORY_FOLDERS else "unknown"
            old_path = layout.root / record.filePath
            destination_directory = layout.assets / CATEGORY_FOLDERS[category]
            destination_directory.mkdir(parents=True, exist_ok=True)
            candidate_name = slugify(Path(requested_name).stem) + ".png"
            destination = destination_directory / candidate_name
            if destination != old_path:
                if destination.exists():
                    candidate_name = allocator.allocate(Path(candidate_name).stem)
                    destination = destination_directory / candidate_name
                old_sidecar = old_path.with_suffix(".json")
                old_path.rename(destination)
                if old_sidecar.exists():
                    old_sidecar.rename(destination.with_suffix(".json"))
                updated = updated.model_copy(
                    update={
                        "filename": destination.name,
                        "filePath": destination.relative_to(layout.root).as_posix(),
                    }
                )
        updated_path = layout.root / (updated.filePath or record.filePath)
        write_sidecar(updated_path, updated)
        by_id[record_id] = updated
        changed += 1
    updated_records = [by_id.get(record.id, record) for record in records]
    result = ProcessingResult(input_path="", output_path=str(layout.root), exported_assets=len(updated_records))
    write_outputs(layout, updated_records, result)
    console.print(f"Applied {changed} review correction(s).")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
