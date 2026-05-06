from __future__ import annotations

import json
import shutil
from dataclasses import asdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from parallel_eval.benchmark.scoring import CompositeWeights
from parallel_eval.benchmark.schema import read_jsonl
from parallel_eval.benchmark.summarize import build_summary_and_viewer


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _summary_label(summary: dict[str, Any]) -> str:
    meta = summary.get("meta") if isinstance(summary.get("meta"), dict) else {}
    model_settings = meta.get("model_settings")
    if isinstance(model_settings, dict):
        model = model_settings.get("model")
        if isinstance(model, str) and model:
            model = model.split(":", 1)[-1]
            effort = model_settings.get("openai_reasoning_effort")
            if isinstance(effort, str) and effort:
                return f"{model} {effort}"
            return model
    return "mixed"


def _metric(bucket: dict[str, Any], key: str, field: str = "median") -> Optional[float]:
    value = bucket.get(key)
    if not isinstance(value, dict):
        return None
    metric = value.get(field)
    if isinstance(metric, (int, float)):
        return float(metric)
    return None


def _bucket_for_slice(summary: dict[str, Any], slice_id: Optional[str]) -> dict[str, Any]:
    if slice_id:
        slices = summary.get("slices")
        if isinstance(slices, dict):
            bucket = slices.get(slice_id)
            if isinstance(bucket, dict):
                return bucket
    overall = summary.get("overall")
    return overall if isinstance(overall, dict) else {}


def _sort_key(entry: dict[str, Any], *, slice_id: Optional[str]) -> tuple[float, float, float, float, str]:
    bucket = _bucket_for_slice(entry["summary"], slice_id)
    win_rate = bucket.get("win_rate")
    if not isinstance(win_rate, (int, float)):
        win_rate = 0.0
    hops_over_shortest = _metric(bucket, "hops_over_shortest_win")
    tokens = _metric(bucket, "total_tokens_win")
    latency = _metric(bucket, "llm_latency_ms_win")
    return (
        -float(win_rate),
        float(hops_over_shortest) if hops_over_shortest is not None else float("inf"),
        float(tokens) if tokens is not None else float("inf"),
        float(latency) if latency is not None else float("inf"),
        entry["label"],
    )


def _summary_json_path(path: Path) -> Optional[Path]:
    if path.name == "records.jsonl":
        candidate = path.parent / "summary.json"
        return candidate if candidate.exists() else None

    candidate = Path(str(path) + ".summary.json")
    return candidate if candidate.exists() else None


def _viewer_json_path(path: Path) -> Optional[Path]:
    if path.name == "records.jsonl":
        candidate = path.parent / "viewer.json"
        if candidate.exists():
            return candidate

    candidate = Path(str(path) + ".viewer.json")
    return candidate if candidate.exists() else None


def _slug(value: str) -> str:
    lowered = value.strip().lower()
    chars = [c if c.isalnum() else "-" for c in lowered]
    slug = "".join(chars)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-") or "artifact"


def _infer_public_url_prefix(path: Path) -> Optional[str]:
    parts = path.parts
    if "public" not in parts:
        return None
    idx = parts.index("public")
    rel_parts = parts[idx + 1 :]
    if not rel_parts:
        return "/"
    return "/" + "/".join(rel_parts)


def _suite_manifest_detail(suite_id: str) -> Optional[dict[str, Any]]:
    suite_dir = Path("benchmarks") / "matchups" / suite_id
    manifest_path = suite_dir / "suite_manifest.json"
    if not manifest_path.exists():
        return None
    try:
        raw = json.loads(manifest_path.read_text("utf-8"))
    except Exception:
        return None
    if not isinstance(raw, dict):
        return None
    notes = raw.get("notes")
    detail = {
        "suite_id": suite_id,
        "manifest_path": str(manifest_path),
        "generator_version": raw.get("generator_version"),
        "generated_at": raw.get("generated_at"),
        "db_sha256": raw.get("db_sha256"),
        "slice_counts": raw.get("slice_counts"),
        "notes": notes if isinstance(notes, list) else [],
        "is_seeded_fallback": isinstance(raw.get("generator_version"), str)
        and "seeded" in str(raw.get("generator_version")),
    }
    metadata_path = suite_dir / "benchmark_metadata.json"
    if metadata_path.exists():
        try:
            metadata_raw = json.loads(metadata_path.read_text("utf-8"))
        except Exception:
            metadata_raw = None
        if isinstance(metadata_raw, dict):
            detail.update(
                {
                    "benchmark_label": metadata_raw.get("benchmark_label"),
                    "benchmark_role": metadata_raw.get("benchmark_role"),
                    "benchmark_visibility": metadata_raw.get("benchmark_visibility"),
                    "benchmark_description": metadata_raw.get("benchmark_description"),
                    "item_count": metadata_raw.get("item_count"),
                    "composition": metadata_raw.get("composition"),
                    "family_counts": metadata_raw.get("family_counts"),
                    "focus_areas": metadata_raw.get("focus_areas"),
                    "methodology_notes": metadata_raw.get("methodology_notes"),
                    "coverage_notes": metadata_raw.get("coverage_notes"),
                    "model_summaries": metadata_raw.get("model_summaries"),
                    "pairwise_summaries": metadata_raw.get("pairwise_summaries"),
                }
            )
    return detail


def _copy_viewer_json(
    *,
    source_path: Path,
    entry_label: str,
    out_dir: Path,
    viewer_url_prefix: Optional[str],
) -> tuple[str, str]:
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = _slug(entry_label)
    destination = out_dir / f"{stem}.json"
    suffix = 2
    while destination.exists() and destination.read_bytes() != source_path.read_bytes():
        destination = out_dir / f"{stem}-{suffix}.json"
        suffix += 1

    if not destination.exists():
        shutil.copyfile(source_path, destination)

    prefix = viewer_url_prefix or _infer_public_url_prefix(out_dir)
    viewer_url = f"{prefix.rstrip('/')}/{destination.name}" if prefix else str(destination)
    return str(destination), viewer_url


def build_leaderboard(
    *,
    inputs: list[Path],
    weights: CompositeWeights = CompositeWeights(),
    dataset_id: Optional[str] = None,
    default_slice_id: Optional[str] = "core_rank_v1",
    viewer_out_dir: Optional[Path] = None,
    viewer_url_prefix: Optional[str] = None,
) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    available_dataset_ids: set[str] = set()
    available_suite_ids: set[str] = set()
    available_slice_ids: set[str] = set()
    available_setup_ids: set[str] = set()
    available_prompt_versions: set[str] = set()
    available_semantics_versions: set[str] = set()
    suite_details: dict[str, dict[str, Any]] = {}
    skipped_inputs: list[dict[str, Any]] = []
    for path in inputs:
        lines = read_jsonl(path)
        has_run_records = any(line.data.get("type") == "run" for line in lines)
        if not has_run_records:
            skipped_inputs.append({"path": str(path), "reason": "no_run_records"})
            continue

        summary, _viewer = build_summary_and_viewer(lines=lines, source_jsonl=str(path), weights=weights)
        meta = summary.get("meta") if isinstance(summary.get("meta"), dict) else {}

        dataset_ids = meta.get("dataset_ids")
        if dataset_id is not None:
            if not isinstance(dataset_ids, list) or dataset_id not in dataset_ids:
                continue
        if isinstance(dataset_ids, list):
            available_dataset_ids.update(v for v in dataset_ids if isinstance(v, str) and v)

        suite_ids = meta.get("suite_ids")
        if isinstance(suite_ids, list):
            available_suite_ids.update(v for v in suite_ids if isinstance(v, str) and v)
            for suite_id in suite_ids:
                if isinstance(suite_id, str) and suite_id and suite_id not in suite_details:
                    detail = _suite_manifest_detail(suite_id)
                    if detail is not None:
                        suite_details[suite_id] = detail

        slice_ids = meta.get("slice_ids")
        if isinstance(slice_ids, list):
            available_slice_ids.update(v for v in slice_ids if isinstance(v, str) and v)

        setup_ids = meta.get("setup_ids")
        if isinstance(setup_ids, list):
            available_setup_ids.update(v for v in setup_ids if isinstance(v, str) and v)

        prompt_versions = meta.get("prompt_versions")
        if isinstance(prompt_versions, list):
            available_prompt_versions.update(v for v in prompt_versions if isinstance(v, str) and v)

        semantics_versions = meta.get("semantics_versions")
        if isinstance(semantics_versions, list):
            available_semantics_versions.update(v for v in semantics_versions if isinstance(v, str) and v)

        label = _summary_label(summary)
        source_summary_json = _summary_json_path(path)
        source_viewer_json = _viewer_json_path(path)
        viewer_public_path = None
        viewer_url = None
        if source_viewer_json is not None and viewer_out_dir is not None:
            viewer_public_path, viewer_url = _copy_viewer_json(
                source_path=source_viewer_json,
                entry_label=label,
                out_dir=viewer_out_dir,
                viewer_url_prefix=viewer_url_prefix,
            )

        entries.append(
            {
                "label": label,
                "source_jsonl": str(path),
                "source_summary_json": str(source_summary_json) if source_summary_json is not None else None,
                "source_viewer_json": str(source_viewer_json) if source_viewer_json is not None else None,
                "viewer_public_path": viewer_public_path,
                "viewer_url": viewer_url,
                "summary": summary,
            }
        )

    resolved_slice_id = default_slice_id if default_slice_id in available_slice_ids else None
    if resolved_slice_id is None:
        resolved_slice_id = "core_rank_v1" if "core_rank_v1" in available_slice_ids else None

    entries.sort(key=lambda entry: _sort_key(entry, slice_id=resolved_slice_id))
    for i, entry in enumerate(entries, start=1):
        entry["rank"] = i

    return {
        "version": 2,
        "generated_at": _now_iso(),
        "dataset_filter": dataset_id,
        "default_slice_id": resolved_slice_id,
        "sort_mode": "lexicographic_v1",
        "weights": asdict(weights),
        "available_dataset_ids": sorted(available_dataset_ids),
        "available_suite_ids": sorted(available_suite_ids),
        "suite_details": suite_details,
        "available_slice_ids": sorted(available_slice_ids),
        "available_setup_ids": sorted(available_setup_ids),
        "available_prompt_versions": sorted(available_prompt_versions),
        "available_semantics_versions": sorted(available_semantics_versions),
        "entries": entries,
        "skipped_inputs": skipped_inputs,
    }


def write_leaderboard_json(
    *,
    inputs: list[Path],
    out_path: Path,
    weights: CompositeWeights = CompositeWeights(),
    dataset_id: Optional[str] = None,
    default_slice_id: Optional[str] = "core_rank_v1",
    viewer_out_dir: Optional[Path] = None,
    viewer_url_prefix: Optional[str] = None,
) -> dict[str, Any]:
    leaderboard = build_leaderboard(
        inputs=inputs,
        weights=weights,
        dataset_id=dataset_id,
        default_slice_id=default_slice_id,
        viewer_out_dir=viewer_out_dir,
        viewer_url_prefix=viewer_url_prefix,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(leaderboard, indent=2), "utf-8")
    return leaderboard
