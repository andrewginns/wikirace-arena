from __future__ import annotations

import argparse
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


DEFAULT_PUBLIC_DIR = Path("public/benchmarks")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Merge benchmark matrix lane bundles and publish the final leaderboard.")
    parser.add_argument("--bundle-dirs", type=Path, nargs="+", required=True)
    parser.add_argument("--out-dir", type=Path, required=True)
    parser.add_argument("--public-dir", type=Path, default=DEFAULT_PUBLIC_DIR)
    parser.add_argument("--dataset-id", type=str, default=None)
    parser.add_argument("--no-publish", action="store_true")
    return parser.parse_args()


def _load_status(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text("utf-8"))


def _infer_dataset_ids(records: list[Path]) -> list[str]:
    dataset_ids: set[str] = set()
    for path in records:
        with path.open("r", encoding="utf-8") as handle:
            for line in handle:
                text = line.strip()
                if not text:
                    continue
                try:
                    payload = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if not isinstance(payload, dict) or payload.get("type") != "run":
                    continue
                dataset_id = payload.get("dataset_id")
                if isinstance(dataset_id, str) and dataset_id:
                    dataset_ids.add(dataset_id)
                    break
    return sorted(dataset_ids)


def _support_report(cells: list[dict[str, Any]]) -> str:
    lines = [
        "# Matrix Support Report",
        "",
        f"- Generated at: `{_now_iso()}`",
        "",
        "| Model | Effort | Supported | Status | Note |",
        "|---|---|---|---|---|",
    ]
    ordered = sorted(cells, key=lambda cell: (str(cell.get("model")), str(cell.get("effort"))))
    for cell in ordered:
        note = cell.get("run_error") or cell.get("probe_error") or "-"
        lines.append(
            f"| {cell.get('model')} | {cell.get('effort')} | {'yes' if cell.get('supported') else 'no'} | {cell.get('status')} | {str(note).replace('|', '/')} |"
        )
    return "\n".join(lines) + "\n"


def _cell_key(cell: dict[str, Any]) -> tuple[str, str]:
    return (str(cell.get("model") or ""), str(cell.get("effort") or ""))


def main() -> int:
    args = _parse_args()
    out_dir = args.out_dir.expanduser()
    public_dir = args.public_dir.expanduser()
    bundle_dirs = [path.expanduser() for path in args.bundle_dirs]

    statuses: list[dict[str, Any]] = []
    cells: list[dict[str, Any]] = []
    records: list[Path] = []
    seen_cells: dict[tuple[str, str], Path] = {}
    for bundle_dir in bundle_dirs:
        status_path = bundle_dir / "status.json"
        if not status_path.exists():
            raise FileNotFoundError(f"Missing status.json in {bundle_dir}")
        status = _load_status(status_path)
        statuses.append(status)
        for cell in status.get("cells", []):
            if isinstance(cell, dict):
                key = _cell_key(cell)
                if key in seen_cells:
                    raise SystemExit(
                        "Duplicate benchmark cell found across bundle dirs: "
                        f"{key[0]} {key[1]} appears in both {seen_cells[key]} and {bundle_dir}"
                    )
                seen_cells[key] = bundle_dir
                cells.append(cell)
                records_path = cell.get("records_path")
                if cell.get("status") == "completed" and isinstance(records_path, str) and records_path:
                    records.append(Path(records_path))

    if not records:
        raise SystemExit("No completed records were found in the provided bundle dirs.")

    dataset_id = args.dataset_id.strip() if isinstance(args.dataset_id, str) and args.dataset_id.strip() else None
    if dataset_id is None:
        inferred_dataset_ids = _infer_dataset_ids(records)
        if len(inferred_dataset_ids) != 1:
            raise SystemExit(
                "Unable to infer a single dataset_id from the provided records; pass --dataset-id explicitly."
            )
        dataset_id = inferred_dataset_ids[0]

    out_dir.mkdir(parents=True, exist_ok=True)
    write_text_report(
        inputs=records,
        out_path=out_dir / "report_core.md",
        dataset_id=dataset_id,
        slice_id="core_rank_v1",
    )
    write_text_report(
        inputs=records,
        out_path=out_dir / "report_overall.md",
        dataset_id=dataset_id,
        slice_id=None,
    )

    public_leaderboard_path = None
    publish_error = None
    leaderboard_path = out_dir / "leaderboard.json"
    incomplete_cells = [
        f"{cell.get('model')} {cell.get('effort')}"
        for cell in cells
        if cell.get("status") not in {"completed", "unsupported"}
    ]
    if not args.no_publish and incomplete_cells:
        publish_error = (
            "Refusing to publish incomplete matrix bundle. "
            f"Unfinished cells: {', '.join(incomplete_cells)}"
        )
    if args.no_publish or publish_error is None:
        public_viewers_dir = None
        if not args.no_publish:
            public_dir.mkdir(parents=True, exist_ok=True)
            public_viewers_dir = public_dir / "viewers"
            shutil.rmtree(public_viewers_dir, ignore_errors=True)
            public_viewers_dir.mkdir(parents=True, exist_ok=True)
        write_leaderboard_json(
            inputs=records,
            out_path=leaderboard_path,
            dataset_id=dataset_id,
            default_slice_id="core_rank_v1",
            viewer_out_dir=public_viewers_dir,
            viewer_url_prefix="/benchmarks/viewers" if not args.no_publish else None,
        )
    if not args.no_publish and publish_error is None:
        public_dir.mkdir(parents=True, exist_ok=True)
        public_leaderboard_path = public_dir / "leaderboard.json"
        shutil.copyfile(leaderboard_path, public_leaderboard_path)

    merged_status = {
        "generated_at": _now_iso(),
        "bundle_dirs": [str(path) for path in bundle_dirs],
        "dataset_ids": sorted(
            {
                str(status.get("dataset_id"))
                for status in statuses
                if isinstance(status.get("dataset_id"), str) and status.get("dataset_id")
            }
        ),
        "canonical_dataset_id": dataset_id,
        "cells": cells,
        "completed": sum(1 for cell in cells if cell.get("status") == "completed"),
        "unsupported": sum(1 for cell in cells if cell.get("status") == "unsupported"),
        "failed": sum(1 for cell in cells if cell.get("status") == "failed"),
        "public_leaderboard_path": str(public_leaderboard_path) if public_leaderboard_path else None,
        "publish_error": publish_error,
    }
    (out_dir / "status.json").write_text(json.dumps(merged_status, indent=2) + "\n", "utf-8")
    (out_dir / "support_report.md").write_text(_support_report(cells), "utf-8")
    if publish_error is not None:
        raise SystemExit(publish_error)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
