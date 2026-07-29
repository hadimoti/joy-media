"""Resumable, copy-only alpha asset extraction pipeline."""

from __future__ import annotations

from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from hashlib import sha1
from pathlib import Path
from typing import Callable, Iterable

from PIL import Image

from .checkpoint import CheckpointStore
from .config import ExtractionConfig
from .contact_sheet import build_contact_sheets
from .cropper import alpha_area, crop_rgba, export_bounds, tight_group_bounds
from .detector import NoUsableAlphaChannelError, detect_components, write_debug_artifacts
from .duplicate_detector import DuplicateDetector, exact_rgba_hash, perceptual_hash
from .grouping import group_components
from .manifest import OutputLayout, load_manifest, write_outputs, write_sidecar
from .models import (
    AssetRecord,
    Bounds,
    ComponentGroup,
    PROCESSING_VERSION,
    ProcessingResult,
    SourceReference,
    SourceResult,
)
from .naming import (
    FilenameAllocator,
    NamingContext,
    SemanticNamingProvider,
    fallback_metadata,
    normalize_metadata,
    title_from_slug,
)
from .scanner import scan_sources, source_hash, source_relative_path


CATEGORY_FOLDERS = {
    "arrow": "arrows",
    "character": "characters",
    "person": "characters",
    "body-part": "characters",
    "object": "objects",
    "icon": "icons",
    "ui": "ui",
    "text": "text",
    "logo": "logos",
    "shape": "shapes",
    "effect": "effects",
    "fire": "fire",
    "smoke": "smoke",
    "light": "light",
    "particle": "effects",
    "background": "backgrounds",
    "decoration": "decorations",
    "unknown": "unknown",
}


@dataclass
class PreparedCrop:
    group: ComponentGroup
    tight_bounds: Bounds
    export_bounds: Bounds
    image: Image.Image


@dataclass
class PreparedSource:
    crops: list[PreparedCrop]
    rejected_components: list[dict]


@dataclass
class PendingSource:
    path: Path
    source_hash: str
    relative_path: str


def _default_output_path(input_path: Path) -> Path:
    anchor = input_path if input_path.is_dir() else input_path.parent
    return anchor.parent / "joy-media-assets"


def _stable_id(source_digest: str, crop_index: int, crop_digest: str) -> str:
    value = f"{source_digest}:{crop_index}:{crop_digest}".encode("ascii")
    return f"asset-{sha1(value).hexdigest()[:10]}"


def _relative_export_path(layout: OutputLayout, path: Path) -> str:
    return path.relative_to(layout.root).as_posix()


def _safe_export_path(
    layout: OutputLayout,
    filename_allocator: FilenameAllocator,
    category: str,
    desired_name: str,
) -> tuple[Path, str]:
    folder = CATEGORY_FOLDERS.get(category, "unknown")
    output_directory = layout.assets / folder
    output_directory.mkdir(parents=True, exist_ok=True)
    filename = filename_allocator.allocate(desired_name)
    asset_path = output_directory / filename
    while asset_path.exists():
        filename = filename_allocator.allocate(Path(filename).stem)
        asset_path = output_directory / filename
    return asset_path, filename


def _prepare_source(
    source: PendingSource,
    config: ExtractionConfig,
    debug_directory: Path | None,
) -> PreparedSource:
    detection = detect_components(source.path, config)
    groups = group_components(detection.components, config)
    if config.largest_only and groups:
        groups = [max(groups, key=lambda group: group.bounds.area)]
    if config.debug and debug_directory is not None:
        write_debug_artifacts(detection, debug_directory, groups)
        (debug_directory / "rejected-components.json").write_text(
            __import__("json").dumps(detection.rejected_components, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        (debug_directory / "extraction-report.json").write_text(
            __import__("json").dumps(
                {
                    "componentCount": len(detection.components),
                    "groupCount": len(groups),
                    "rejectedComponentCount": len(detection.rejected_components),
                    "groups": [group.model_dump() for group in groups],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )

    crops: list[PreparedCrop] = []
    for group in groups:
        tight_bounds = tight_group_bounds(
            detection.alpha,
            group,
            config.alpha_threshold,
        )
        if config.minimum_area is not None and tight_bounds.area < config.minimum_area:
            continue
        bounds = export_bounds(
            tight_bounds,
            detection.image.width,
            detection.image.height,
            config,
        )
        crops.append(
            PreparedCrop(
                group=group,
                tight_bounds=tight_bounds,
                export_bounds=bounds,
                image=crop_rgba(detection.image, bounds).copy(),
            )
        )
    detection.image.close()
    return PreparedSource(crops=crops, rejected_components=detection.rejected_components)


def _ordered_prepared_sources(
    jobs: list[PendingSource],
    config: ExtractionConfig,
    layout: OutputLayout,
    workers: int,
) -> Iterable[tuple[PendingSource, PreparedSource | Exception]]:
    """Bound retained source images to the configured worker window."""
    if workers <= 1:
        for source in jobs:
            debug_directory = layout.debug / source.source_hash[:16] if config.debug else None
            try:
                yield source, _prepare_source(source, config, debug_directory)
            except Exception as error:
                yield source, error
        return

    with ThreadPoolExecutor(max_workers=workers, thread_name_prefix="alpha-assets") as pool:
        pending: list[tuple[PendingSource, Future[PreparedSource]]] = []
        source_iterator = iter(jobs)

        def submit_next() -> bool:
            try:
                source = next(source_iterator)
            except StopIteration:
                return False
            debug_directory = layout.debug / source.source_hash[:16] if config.debug else None
            pending.append((source, pool.submit(_prepare_source, source, config, debug_directory)))
            return True

        for _ in range(workers):
            if not submit_next():
                break
        while pending:
            source, future = pending.pop(0)
            try:
                prepared: PreparedSource | Exception = future.result()
            except Exception as error:
                prepared = error
            submit_next()
            yield source, prepared


def _record_duplicate(
    source: PendingSource,
    crop: PreparedCrop,
    crop_index: int,
    exact_hash: str,
    phash: str,
    duplicate_id: str,
    kind: str,
) -> AssetRecord:
    return AssetRecord(
        id=f"duplicate-{sha1(f'{source.source_hash}:{crop_index}:{kind}'.encode('ascii')).hexdigest()[:10]}",
        filename="",
        title="Duplicate asset",
        category="unknown",
        description=f"A {kind} duplicate of {duplicate_id}; no second PNG was exported.",
        tags=["duplicate", kind],
        colors=[],
        orientation="none",
        confidence=1.0,
        source=SourceReference(file=source.path.name, relativePath=source.relative_path),
        tightBounds=crop.tight_bounds,
        exportBounds=crop.export_bounds,
        alphaPixelArea=alpha_area(crop.image, 0),
        componentCount=len(crop.group.component_labels),
        exactHash=exact_hash,
        perceptualHash=phash,
        duplicateOf=duplicate_id,
        filePath=None,
        semanticKey=None,
        exported=False,
    )


def _export_prepared_source(
    source: PendingSource,
    prepared: PreparedSource,
    layout: OutputLayout,
    config: ExtractionConfig,
    records: list[AssetRecord],
    duplicates: DuplicateDetector,
    filename_allocator: FilenameAllocator,
    semantic_provider: SemanticNamingProvider | None,
    fallback_index_start: int,
    detect_duplicates: bool,
) -> tuple[SourceResult, int, int, int]:
    """Name, deduplicate, export, and sidecar all prepared crops from one source."""
    exported = exact_duplicates = visual_duplicates = 0
    output_paths: list[str] = []
    source_count = len(prepared.crops)
    for crop_index, crop in enumerate(prepared.crops, start=1):
        exact_hash = exact_rgba_hash(crop.image)
        phash = perceptual_hash(crop.image)
        exact_match, visual_match = (
            duplicates.find(exact_hash, phash) if detect_duplicates else (None, None)
        )
        if exact_match and not config.keep_exact_duplicates:
            records.append(
                _record_duplicate(
                    source,
                    crop,
                    crop_index,
                    exact_hash,
                    phash,
                    exact_match.asset_id,
                    "exact",
                )
            )
            exact_duplicates += 1
            crop.image.close()
            continue
        if visual_match and config.skip_visual_duplicates:
            records.append(
                _record_duplicate(
                    source,
                    crop,
                    crop_index,
                    exact_hash,
                    phash,
                    visual_match.asset_id,
                    "visual",
                )
            )
            visual_duplicates += 1
            crop.image.close()
            continue

        context = NamingContext(
            source_relative_path=source.relative_path,
            source_filename=source.path.name,
            crop_index=crop_index,
            tight_bounds=crop.tight_bounds,
            source_count=source_count,
        )
        fallback_index = fallback_index_start + crop_index - 1
        metadata = None
        if config.generate_names and semantic_provider is not None:
            try:
                metadata = semantic_provider.describe(crop.image, context)
            except Exception:
                metadata = None
        metadata = normalize_metadata(
            metadata or fallback_metadata(crop.image, context, fallback_index),
            fallback_index,
        )
        category = (
            metadata.category
            if metadata.confidence >= config.semantic_confidence_threshold
            and metadata.category in CATEGORY_FOLDERS
            else "unknown"
        )
        asset_path, filename = _safe_export_path(
            layout,
            filename_allocator,
            category,
            metadata.name,
        )
        asset_id = _stable_id(source.source_hash, crop_index, exact_hash)
        duplicate_of = visual_match.asset_id if visual_match else None
        record = AssetRecord(
            id=asset_id,
            filename=filename,
            title=title_from_slug(metadata.name),
            category=category,
            description=metadata.description,
            tags=metadata.tags,
            colors=metadata.colors,
            orientation=metadata.orientation,
            confidence=metadata.confidence,
            source=SourceReference(file=source.path.name, relativePath=source.relative_path),
            tightBounds=crop.tight_bounds,
            exportBounds=crop.export_bounds,
            alphaPixelArea=alpha_area(crop.image, config.alpha_threshold),
            componentCount=len(crop.group.component_labels),
            exactHash=exact_hash,
            perceptualHash=phash,
            duplicateOf=duplicate_of,
            filePath=_relative_export_path(layout, asset_path),
            semanticKey=f"{source.relative_path}#{crop_index}",
        )
        if not config.dry_run:
            temporary_path = asset_path.with_suffix(".partial.png")
            crop.image.save(temporary_path, format="PNG")
            temporary_path.replace(asset_path)
            write_sidecar(asset_path, record)
        records.append(record)
        if detect_duplicates:
            duplicates.register(record)
        output_paths.append(record.filePath or "")
        exported += 1
        if visual_match:
            visual_duplicates += 1
        crop.image.close()

    return (
        SourceResult(
            source_path=source.relative_path,
            source_hash=source.source_hash,
            status="complete",
            extracted_assets=exported,
            skipped_exact_duplicates=exact_duplicates,
        ),
        exported,
        exact_duplicates,
        visual_duplicates,
    )


def process_asset_archive(
    input_path: str | Path,
    output_path: str | Path | None = None,
    recursive: bool = True,
    resume: bool = True,
    workers: int = 1,
    generate_names: bool = True,
    detect_duplicates: bool = True,
    config: ExtractionConfig | None = None,
    semantic_provider: SemanticNamingProvider | None = None,
    force: bool = False,
    on_progress: Callable[[int, int, SourceResult], None] | None = None,
) -> ProcessingResult:
    """Process transparent PNG sheets safely, preserving completed output on failure."""
    input_candidate = Path(input_path).expanduser().resolve()
    destination = Path(output_path).expanduser().resolve() if output_path else _default_output_path(input_candidate)
    extraction_config = (config or ExtractionConfig()).model_copy(
        update={"generate_names": generate_names}
    )
    layout = OutputLayout(destination)
    layout.ensure()
    root = input_candidate if input_candidate.is_dir() else input_candidate.parent
    result = ProcessingResult(input_path=str(input_candidate), output_path=str(destination))
    records = load_manifest(layout)
    duplicates = DuplicateDetector(extraction_config.visual_duplicate_threshold)
    if detect_duplicates:
        for record in records:
            duplicates.register(record)
    filename_allocator = FilenameAllocator([record.filename for record in records if record.filename])
    checkpoint = CheckpointStore(layout.checkpoints / "checkpoint.sqlite3")

    try:
        sources = scan_sources(input_candidate, recursive=recursive)
        progress_total = len(sources)
        progress_current = 0

        def report_progress(source_result: SourceResult) -> None:
            nonlocal progress_current
            progress_current += 1
            if on_progress is not None:
                on_progress(progress_current, progress_total, source_result)

        jobs: list[PendingSource] = []
        for source in sources:
            try:
                digest = source_hash(source)
            except OSError as error:
                source_result = SourceResult(
                    source_path=source_relative_path(source, root),
                    source_hash="",
                    status="failed",
                    error=str(error),
                )
                result.failed_sources += 1
                result.source_results.append(source_result)
                report_progress(source_result)
                continue
            relative_path = source_relative_path(source, root)
            if resume and not force and checkpoint.is_complete(relative_path, digest):
                result.skipped_sources += 1
                result.source_results.append(
                    SourceResult(
                        source_path=relative_path,
                        source_hash=digest,
                        status="skipped",
                    )
                )
                report_progress(result.source_results[-1])
                continue
            jobs.append(PendingSource(source, digest, relative_path))

        for source, prepared in _ordered_prepared_sources(
            jobs,
            extraction_config,
            layout,
            max(1, workers),
        ):
            if isinstance(prepared, Exception):
                no_usable_alpha = isinstance(prepared, NoUsableAlphaChannelError)
                source_result = SourceResult(
                    source_path=source.relative_path,
                    source_hash=source.source_hash,
                    status="no_usable_alpha_channel" if no_usable_alpha else "failed",
                    error=str(prepared),
                )
                checkpoint.mark(source_result)
                result.failed_sources += 1
                result.source_results.append(source_result)
                write_outputs(layout, records, result)
                report_progress(source_result)
                continue
            try:
                source_result, exported, exact_duplicates, visual_duplicates = _export_prepared_source(
                    source,
                    prepared,
                    layout,
                    extraction_config,
                    records,
                    duplicates,
                    filename_allocator,
                    semantic_provider,
                    fallback_index_start=len(records) + 1,
                    detect_duplicates=detect_duplicates,
                )
                checkpoint.mark(
                    source_result,
                    [record.filePath or "" for record in records[-exported:]] if exported else [],
                )
                result.processed_sources += 1
                result.exported_assets += exported
                result.exact_duplicates += exact_duplicates
                result.visual_duplicates += visual_duplicates
                result.source_results.append(source_result)
            except Exception as error:
                source_result = SourceResult(
                    source_path=source.relative_path,
                    source_hash=source.source_hash,
                    status="failed",
                    error=str(error),
                )
                checkpoint.mark(source_result)
                result.failed_sources += 1
                result.source_results.append(source_result)
            write_outputs(layout, records, result)
            report_progress(source_result)

        if extraction_config.generate_contact_sheets and not extraction_config.dry_run:
            build_contact_sheets(
                records,
                layout.contact_sheets,
                package_root=layout.root,
                columns=extraction_config.contact_sheet_columns,
                rows=extraction_config.contact_sheet_rows,
            )
        write_outputs(layout, records, result)
        return result
    except Exception:
        write_outputs(layout, records, result)
        raise
    finally:
        checkpoint.close()


def extract_assets(
    input_path: str | Path,
    output_path: str | Path | None = None,
    **kwargs: object,
) -> ProcessingResult:
    """Extract one PNG or a non-recursive directory of PNGs."""
    return process_asset_archive(
        input_path=input_path,
        output_path=output_path,
        recursive=False,
        **kwargs,
    )
