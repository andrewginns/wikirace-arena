from __future__ import annotations

import argparse
import copy
import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from parallel_eval.benchmark.leaderboard import write_leaderboard_json
from parallel_eval.benchmark.report_text import write_text_report
from parallel_eval.benchmark.summarize import summarize_benchmark_jsonl


STANDARD_SUITE_ID = "frontier_local_simplewiki_standard_v1"
STANDARD_DATASET_PATH = Path("benchmarks/matchups/frontier_local_simplewiki_standard_v1/all.jsonl")
STANDARD_DATASET_ID = "matchups/frontier_local_simplewiki_standard_v1/all"
EXPECTED_STANDARD_RUNS = 200
COMPANION_V2_1_SELECTED_RECORDS = Path(
    "benchmarks/matchups/frontier_local_simplewiki_v1_1_companion101_v2_1/source_selected_records.jsonl"
)
DEFAULT_OUT_DIR = Path("results/benchmarks/published/frontier_local_simplewiki_standard_v1_publish")
DEFAULT_PUBLIC_DIR = Path("public/benchmarks")
DEFAULT_REGISTRY_PATH = Path("results/benchmarks/published/registry.json")

PUBLISH_CELLS: list[dict[str, Any]] = [
    {
        "slug": "gpt-5-1__low",
        "hard_records": Path(
            "results/benchmarks/frontier_local_simplewiki_v1_1_openai_matrix_20260312_gpt51/runs/gpt-5-1__low/records.jsonl"
        ),
        "companion_mode": "selected_plus_alt",
        "companion_selected_records": Path(
            "results/benchmarks/frontier_local_simplewiki_v1_1_companion101_v2_0_selected101_anchor_20260315/runs/gpt-5-1__low/records.jsonl"
        ),
        "companion_alt_records": Path(
            "results/benchmarks/frontier_local_simplewiki_v1_1_companion101_v2_0_alt80_anchor_20260315/runs/gpt-5-1__low/records.jsonl"
        ),
    },
    {
        "slug": "gpt-5-2__none",
        "hard_records": Path(
            "results/benchmarks/frontier_local_simplewiki_v1_1_openai_matrix_20260312_gpt52/runs/gpt-5-2__none/records.jsonl"
        ),
        "companion_mode": "selected_plus_alt",
        "companion_selected_records": Path(
            "results/benchmarks/frontier_local_simplewiki_v1_1_companion101_v2_0_selected101_anchor_20260315/runs/gpt-5-2__none/records.jsonl"
        ),
        "companion_alt_records": Path(
            "results/benchmarks/frontier_local_simplewiki_v1_1_companion101_v2_0_alt80_anchor_20260315/runs/gpt-5-2__none/records.jsonl"
        ),
    },
    {
        "slug": "gpt-5-4__medium",
        "hard_records": Path(
            "results/benchmarks/frontier_local_simplewiki_v1_1_openai_matrix_20260312_gpt54/runs/gpt-5-4__medium/records.jsonl"
        ),
        "companion_mode": "direct_v2_1",
        "companion_records": Path(
            "results/benchmarks/frontier_local_simplewiki_v1_2_partial_compare_20260316/gpt-5-4__medium/records.jsonl"
        ),
    },
    {
        "slug": "google-gemini-3-flash-preview",
        "hard_records": Path(
            "results/benchmarks/frontier_local_simplewiki_v1_1_openrouter_gemini3flashpreview_20260312_c8/all__openrouter-google-gemini-3-flash-preview__20260312T210346Z__2046adc7/records.jsonl"
        ),
        "companion_mode": "direct_v2_1",
        "companion_records": Path(
            "results/benchmarks/frontier_local_simplewiki_v1_2_partial_compare_20260316/google-gemini-3-flash-preview/records.jsonl"
        ),
    },
]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text("utf-8").splitlines() if line.strip()]


def _write_jsonl(path: Path, rows: list[dict[str, Any]]) -> None:
    payload = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    path.write_text(payload + ("\n" if payload else ""), "utf-8")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Materialize and publish the canonical Frontier 200 public leaderboard bundle."
    )
    parser.add_argument("--dataset", type=Path, default=STANDARD_DATASET_PATH)
    parser.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR)
    parser.add_argument("--public-dir", type=Path, default=DEFAULT_PUBLIC_DIR)
    parser.add_argument("--registry-path", type=Path, default=DEFAULT_REGISTRY_PATH)
    parser.add_argument("--no-publish", action="store_true")
    parser.add_argument("--archive-label", type=str, default=f"pre-frontier-standard-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}")
    return parser.parse_args()


def _group_source_records(path: Path) -> tuple[dict[str, list[dict[str, Any]]], dict[str, dict[str, Any]]]:
    groups: dict[str, list[dict[str, Any]]] = {}
    runs: dict[str, dict[str, Any]] = {}
    for row in _read_jsonl(path):
        run_id = row.get("run_id")
        if not isinstance(run_id, str) or not run_id:
            continue
        groups.setdefault(run_id, []).append(row)
        if row.get("type") == "run":
            runs[run_id] = row
    return groups, runs


def _load_standard_index(dataset_path: Path) -> dict[str, Any]:
    rows = _read_jsonl(dataset_path)
    hard_rows = [row for row in rows if "hard99" in list(row.get("feature_tags") or [])]
    companion_rows = [row for row in rows if "companion101" in list(row.get("feature_tags") or [])]
    companion_selected_pairs = {
        (row.get("start"), row.get("target"))
        for row in _read_jsonl(COMPANION_V2_1_SELECTED_RECORDS)
        if isinstance(row.get("start"), str) and isinstance(row.get("target"), str)
    }
    return {
        "rows": rows,
        "hard_by_source_id": {
            str(row.get("source_matchup_id")): row
            for row in hard_rows
            if isinstance(row.get("source_matchup_id"), str) and row.get("source_matchup_id")
        },
        "companion_by_source_id": {
            str(row.get("source_matchup_id")): row
            for row in companion_rows
            if isinstance(row.get("source_matchup_id"), str) and row.get("source_matchup_id")
        },
        "companion_by_pair": {
            (str(row.get("start")), str(row.get("target"))): row
            for row in companion_rows
            if isinstance(row.get("start"), str) and isinstance(row.get("target"), str)
        },
        "companion_selected_pairs": companion_selected_pairs,
    }


def _select_hard_runs(path: Path, standard_index: dict[str, Any]) -> dict[str, tuple[list[dict[str, Any]], Path]]:
    groups, runs = _group_source_records(path)
    selected: dict[str, tuple[list[dict[str, Any]], Path]] = {}
    for run_id, run in runs.items():
        source_matchup_id = run.get("matchup_id")
        if not isinstance(source_matchup_id, str):
            continue
        target_row = standard_index["hard_by_source_id"].get(source_matchup_id)
        if target_row is None:
            continue
        selected[target_row["id"]] = (groups[run_id], path)
    if len(selected) != 99:
        raise RuntimeError(f"Expected 99 hard99 runs from {path}, found {len(selected)}")
    return selected


def _select_direct_companion_runs(
    path: Path, standard_index: dict[str, Any]
) -> dict[str, tuple[list[dict[str, Any]], Path]]:
    groups, runs = _group_source_records(path)
    selected: dict[str, tuple[list[dict[str, Any]], Path]] = {}
    for run_id, run in runs.items():
        source_matchup_id = run.get("matchup_id")
        if not isinstance(source_matchup_id, str):
            continue
        target_row = standard_index["companion_by_source_id"].get(source_matchup_id)
        if target_row is None:
            continue
        selected[target_row["id"]] = (groups[run_id], path)
    if len(selected) != 101:
        raise RuntimeError(f"Expected 101 direct companion runs from {path}, found {len(selected)}")
    return selected


def _select_companion_selected_plus_alt(
    *,
    selected_records: Path,
    alt_records: Path,
    standard_index: dict[str, Any],
) -> dict[str, tuple[list[dict[str, Any]], Path]]:
    selected_pairs = standard_index["companion_selected_pairs"]
    final_pairs = set(standard_index["companion_by_pair"].keys())
    selected_pair_targets = final_pairs & selected_pairs
    alt_pair_targets = final_pairs - selected_pairs

    grouped_selected, selected_runs = _group_source_records(selected_records)
    grouped_alt, alt_runs = _group_source_records(alt_records)

    out: dict[str, tuple[list[dict[str, Any]], Path]] = {}
    for run_id, run in selected_runs.items():
        pair = (run.get("start"), run.get("target"))
        if pair not in selected_pair_targets:
            continue
        target_row = standard_index["companion_by_pair"].get(pair)
        if target_row is None:
            continue
        out[target_row["id"]] = (grouped_selected[run_id], selected_records)

    for run_id, run in alt_runs.items():
        pair = (run.get("start"), run.get("target"))
        if pair not in alt_pair_targets:
            continue
        target_row = standard_index["companion_by_pair"].get(pair)
        if target_row is None:
            continue
        out[target_row["id"]] = (grouped_alt[run_id], alt_records)

    if len(out) != 101:
        raise RuntimeError(
            "Expected 101 reconstructed companion runs "
            f"from {selected_records} + {alt_records}, found {len(out)}"
        )
    return out


def _rewrite_group(
    *,
    rows: list[dict[str, Any]],
    target_row: dict[str, Any],
    new_run_id: str,
    source_records_path: Path,
) -> list[dict[str, Any]]:
    rewritten: list[dict[str, Any]] = []
    for row in rows:
        updated = copy.deepcopy(row)
        updated["run_id"] = new_run_id
        if updated.get("type") == "run":
            source_dataset_id = updated.get("dataset_id")
            source_suite_id = updated.get("suite_id")
            source_matchup_id = updated.get("matchup_id")
            updated["dataset_id"] = STANDARD_DATASET_ID
            updated["matchup_id"] = target_row["id"]
            updated["tier"] = target_row.get("tier") or target_row.get("slice_id")
            updated["suite_id"] = target_row.get("suite_id") or STANDARD_SUITE_ID
            updated["slice_id"] = target_row.get("slice_id")
            updated["setup_id"] = target_row.get("setup_id") or updated.get("setup_id")
            updated["prompt_version"] = target_row.get("prompt_version") or updated.get("prompt_version")
            updated["semantics_version"] = target_row.get("semantics_version") or updated.get("semantics_version")
            updated["start"] = target_row.get("start") or updated.get("start")
            updated["target"] = target_row.get("target") or updated.get("target")
            provenance = dict(updated.get("provenance") or {})
            provenance["materialized_from_records"] = str(source_records_path)
            provenance["materialized_for_suite"] = STANDARD_SUITE_ID
            provenance["source_dataset_id"] = source_dataset_id
            provenance["source_suite_id"] = source_suite_id
            provenance["source_matchup_id"] = source_matchup_id
            updated["provenance"] = provenance
            updated["source_dataset_id"] = source_dataset_id
            updated["source_suite_id"] = source_suite_id
            updated["source_matchup_id"] = source_matchup_id
        rewritten.append(updated)
    return rewritten


def _materialize_cell(
    *,
    cell: dict[str, Any],
    standard_index: dict[str, Any],
    out_dir: Path,
) -> dict[str, Any]:
    hard_records = REPO_ROOT / cell["hard_records"]
    selected_groups = _select_hard_runs(hard_records, standard_index)

    companion_mode = cell["companion_mode"]
    if companion_mode == "direct_v2_1":
        companion_records = REPO_ROOT / cell["companion_records"]
        companion_groups = _select_direct_companion_runs(companion_records, standard_index)
    elif companion_mode == "selected_plus_alt":
        companion_groups = _select_companion_selected_plus_alt(
            selected_records=REPO_ROOT / cell["companion_selected_records"],
            alt_records=REPO_ROOT / cell["companion_alt_records"],
            standard_index=standard_index,
        )
    else:
        raise ValueError(f"Unknown companion_mode: {companion_mode}")

    combined = {}
    combined.update(selected_groups)
    combined.update(companion_groups)
    if len(combined) != 200:
        raise RuntimeError(f"Expected 200 materialized runs for {cell['slug']}, found {len(combined)}")

    run_dir = out_dir / "runs" / cell["slug"]
    run_dir.mkdir(parents=True, exist_ok=True)
    records_path = run_dir / "records.jsonl"
    output_rows: list[dict[str, Any]] = []
    for target_row in standard_index["rows"]:
        item = combined.get(target_row["id"])
        if item is None:
            raise RuntimeError(f"Missing run group for standard row {target_row['id']} in cell {cell['slug']}")
        source_rows, source_records_path = item
        new_run_id = f"{cell['slug']}::{target_row['id']}"
        output_rows.extend(
            _rewrite_group(
                rows=source_rows,
                target_row=target_row,
                new_run_id=new_run_id,
                source_records_path=source_records_path,
            )
        )
    _write_jsonl(records_path, output_rows)
    summarize_benchmark_jsonl(
        jsonl_path=records_path,
        out_summary_path=run_dir / "summary.json",
        out_viewer_path=run_dir / "viewer.json",
    )
    summary = json.loads((run_dir / "summary.json").read_text("utf-8"))
    overall = summary.get("overall") if isinstance(summary.get("overall"), dict) else {}
    return {
        "slug": cell["slug"],
        "records_path": str(records_path),
        "summary_path": str(run_dir / "summary.json"),
        "viewer_path": str(run_dir / "viewer.json"),
        "hard_records_path": str(hard_records),
        "companion_mode": companion_mode,
        "wins": overall.get("wins"),
        "total_runs": overall.get("total_runs"),
        "win_rate": overall.get("win_rate"),
    }


def _archive_public_assets(public_dir: Path, archive_label: str) -> str | None:
    if not public_dir.exists():
        return None
    leaderboard_path = public_dir / "leaderboard.json"
    viewers_dir = public_dir / "viewers"
    if not leaderboard_path.exists() and not viewers_dir.exists():
        return None
    archive_root = public_dir / "archive" / archive_label
    archive_root.mkdir(parents=True, exist_ok=True)
    if leaderboard_path.exists():
        shutil.copyfile(leaderboard_path, archive_root / "leaderboard.json")
    if viewers_dir.exists():
        shutil.copytree(viewers_dir, archive_root / "viewers", dirs_exist_ok=True)
    return str(archive_root)


def _validate_leaderboard_completeness(leaderboard_path: Path) -> None:
    payload = json.loads(leaderboard_path.read_text("utf-8"))
    entries = payload.get("entries") if isinstance(payload, dict) else None
    if not isinstance(entries, list):
        raise RuntimeError(f"Expected leaderboard entries in {leaderboard_path}")

    incomplete_entries: list[str] = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        label = entry.get("label")
        summary = entry.get("summary")
        overall = summary.get("overall") if isinstance(summary, dict) else None
        total_runs = overall.get("total_runs") if isinstance(overall, dict) else None
        if total_runs != EXPECTED_STANDARD_RUNS:
            incomplete_entries.append(f"{label or 'unknown'}:{total_runs}")

    if incomplete_entries:
        raise RuntimeError(
            "Refusing to publish incomplete Frontier 200 leaderboard entries: "
            + ", ".join(incomplete_entries)
        )


def main() -> int:
    args = _parse_args()
    dataset_path = (REPO_ROOT / args.dataset).resolve() if not args.dataset.is_absolute() else args.dataset
    out_dir = (REPO_ROOT / args.out_dir).resolve() if not args.out_dir.is_absolute() else args.out_dir
    public_dir = (REPO_ROOT / args.public_dir).resolve() if not args.public_dir.is_absolute() else args.public_dir
    registry_path = (REPO_ROOT / args.registry_path).resolve() if not args.registry_path.is_absolute() else args.registry_path

    standard_index = _load_standard_index(dataset_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    cell_statuses = [
        _materialize_cell(cell=cell, standard_index=standard_index, out_dir=out_dir)
        for cell in PUBLISH_CELLS
    ]
    record_paths = [Path(item["records_path"]) for item in cell_statuses]

    write_text_report(
        inputs=record_paths,
        out_path=out_dir / "report_core.md",
        dataset_id=STANDARD_DATASET_ID,
        slice_id="core_rank_v1",
    )
    write_text_report(
        inputs=record_paths,
        out_path=out_dir / "report_overall.md",
        dataset_id=STANDARD_DATASET_ID,
        slice_id=None,
    )

    archive_path = None
    viewer_out_dir = None
    viewer_url_prefix = None
    if not args.no_publish:
        archive_path = _archive_public_assets(public_dir, args.archive_label)
        viewer_out_dir = public_dir / "viewers"
        shutil.rmtree(viewer_out_dir, ignore_errors=True)
        viewer_out_dir.mkdir(parents=True, exist_ok=True)
        viewer_url_prefix = "/benchmarks/viewers"

    leaderboard_path = out_dir / "leaderboard.json"
    write_leaderboard_json(
        inputs=record_paths,
        out_path=leaderboard_path,
        dataset_id=STANDARD_DATASET_ID,
        default_slice_id="core_rank_v1",
        viewer_out_dir=viewer_out_dir,
        viewer_url_prefix=viewer_url_prefix,
    )
    _validate_leaderboard_completeness(leaderboard_path)
    if not args.no_publish:
        public_dir.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(leaderboard_path, public_dir / "leaderboard.json")

    status_payload = {
        "generated_at": _now_iso(),
        "suite_id": STANDARD_SUITE_ID,
        "dataset_id": STANDARD_DATASET_ID,
        "dataset_path": str(dataset_path),
        "cells": cell_statuses,
        "public_leaderboard_path": None if args.no_publish else str(public_dir / "leaderboard.json"),
        "archived_public_snapshot": archive_path,
    }
    (out_dir / "status.json").write_text(json.dumps(status_payload, indent=2) + "\n", "utf-8")

    registry = {
        "generated_at": _now_iso(),
        "published_ui_bundle": {
            "suite_id": STANDARD_SUITE_ID,
            "dataset_id": STANDARD_DATASET_ID,
            "bundle_dir": str(out_dir),
            "leaderboard_path": str(leaderboard_path),
            "public_leaderboard_path": None if args.no_publish else str(public_dir / "leaderboard.json"),
            "cells": [{"slug": item["slug"], "records_path": item["records_path"]} for item in cell_statuses],
        },
        "runnable_benchmarks": [
            {
                "suite_id": "frontier_local_simplewiki_standard_v1",
                "published_in_ui": True,
                "notes": "Primary SOTA-separating benchmark.",
            },
            {
                "suite_id": "frontier_local_simplewiki_regression_v1",
                "published_in_ui": False,
                "notes": "Runnable regression benchmark kept off the public UI.",
            },
        ],
        "archived_public_snapshot": archive_path,
    }
    registry_path.parent.mkdir(parents=True, exist_ok=True)
    registry_path.write_text(json.dumps(registry, indent=2) + "\n", "utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
