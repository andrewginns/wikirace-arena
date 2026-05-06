from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from llm_client import achat
from parallel_eval.benchmark.leaderboard import write_leaderboard_json
from parallel_eval.benchmark.report_text import write_text_report
from parallel_eval.benchmark.schema import MatchupV1, read_jsonl
from parallel_eval.benchmark.settings import DEFAULT_BENCHMARK_DB_PATH
from parallel_eval.benchmark.utils import benchmark_dataset_id


DEFAULT_DATASET = Path("benchmarks/matchups/frontier_local_simplewiki_standard_v1/all.jsonl")
DEFAULT_DB_PATH = DEFAULT_BENCHMARK_DB_PATH
DEFAULT_PUBLIC_DIR = Path("public/benchmarks")
DEFAULT_MODELS = ("gpt-5.1", "gpt-5.2", "gpt-5.4")
DEFAULT_EFFORTS = ("none", "low", "medium", "high", "xhigh")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _slug(value: str) -> str:
    chars = [c.lower() if c.isalnum() else "-" for c in value.strip()]
    slug = "".join(chars)
    while "--" in slug:
        slug = slug.replace("--", "-")
    return slug.strip("-")


def _ordered_unique(values: list[str]) -> list[str]:
    ordered: list[str] = []
    seen: set[str] = set()
    for value in values:
        trimmed = value.strip()
        if not trimmed or trimmed in seen:
            continue
        ordered.append(trimmed)
        seen.add(trimmed)
    return ordered


def _selected_models(values: list[str] | None) -> list[str]:
    if values:
        return _ordered_unique(values)
    return list(DEFAULT_MODELS)


def _selected_efforts(values: list[str] | None) -> list[str]:
    if values:
        return _ordered_unique(values)
    return list(DEFAULT_EFFORTS)


@dataclass
class CellStatus:
    model: str
    effort: str
    supported: bool
    status: str
    probe_error: str | None = None
    run_error: str | None = None
    records_path: str | None = None
    summary_path: str | None = None
    viewer_path: str | None = None
    log_path: str | None = None


def _status_path(bundle_dir: Path) -> Path:
    return bundle_dir / "status.json"


def _support_report_path(bundle_dir: Path) -> Path:
    return bundle_dir / "support_report.md"


def _write_status(
    *,
    bundle_dir: Path,
    dataset: Path,
    dataset_id: str,
    db_path: Path,
    cells: list[CellStatus],
    public_leaderboard_path: Path | None = None,
    publish_error: str | None = None,
) -> dict[str, Any]:
    payload = {
        "generated_at": _now_iso(),
        "dataset": str(dataset),
        "dataset_id": dataset_id,
        "db_path": str(db_path),
        "cells": [asdict(cell) for cell in cells],
        "completed": sum(1 for cell in cells if cell.status == "completed"),
        "running": sum(1 for cell in cells if cell.status == "running"),
        "unsupported": sum(1 for cell in cells if cell.status == "unsupported"),
        "failed": sum(1 for cell in cells if cell.status == "failed"),
        "public_leaderboard_path": str(public_leaderboard_path) if public_leaderboard_path else None,
        "publish_error": publish_error,
    }
    path = _status_path(bundle_dir)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2) + "\n", "utf-8")
    return payload


def _write_support_report(*, bundle_dir: Path, cells: list[CellStatus]) -> Path:
    lines = [
        "# Matrix Support Report",
        "",
        f"- Generated at: `{_now_iso()}`",
        "",
        "| Model | Effort | Supported | Status | Note |",
        "|---|---|---|---|---|",
    ]
    for cell in cells:
        note = cell.run_error or cell.probe_error or "-"
        lines.append(
            f"| {cell.model} | {cell.effort} | {'yes' if cell.supported else 'no'} | {cell.status} | {note.replace('|', '/')} |"
        )
    path = _support_report_path(bundle_dir)
    path.write_text("\n".join(lines) + "\n", "utf-8")
    return path


async def _probe_support(model: str, effort: str) -> tuple[bool, str | None]:
    try:
        await achat(
            model=f"openai-responses:{model}",
            prompt="Reply with exactly <answer>1</answer>.",
            max_tokens=64,
            openai_reasoning_effort=effort,
        )
    except Exception as exc:
        return False, str(exc)
    return True, None


def _run_paths(bundle_dir: Path, model: str, effort: str) -> tuple[Path, Path, Path, Path]:
    run_dir = bundle_dir / "runs" / f"{_slug(model)}__{_slug(effort)}"
    records = run_dir / "records.jsonl"
    summary = run_dir / "summary.json"
    viewer = run_dir / "viewer.json"
    log = run_dir / "run.log"
    return records, summary, viewer, log


def _dataset_id_for_matchups(dataset_path: Path) -> str:
    rows = [MatchupV1.model_validate(item.data) for item in read_jsonl(dataset_path)]
    return benchmark_dataset_id(dataset_path, rows)


def _existing_run_matches(
    *,
    records_path: Path,
    dataset_id: str,
    db_path: Path,
    model: str,
    effort: str,
    setup_id: str,
) -> bool:
    try:
        with records_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                text = line.strip()
                if not text:
                    continue
                payload = json.loads(text)
                if not isinstance(payload, dict) or payload.get("type") != "run":
                    continue
                model_settings = payload.get("model_settings")
                provenance = payload.get("provenance")
                return (
                    payload.get("dataset_id") == dataset_id
                    and payload.get("setup_id") == setup_id
                    and isinstance(model_settings, dict)
                    and model_settings.get("model") == model
                    and model_settings.get("openai_reasoning_effort") == effort
                    and isinstance(provenance, dict)
                    and provenance.get("db_path") == str(db_path)
                )
    except Exception:
        return False
    return False


def _run_command(
    *,
    dataset: Path,
    db_path: Path,
    records_path: Path,
    model: str,
    effort: str,
    concurrency: int,
) -> list[str]:
    return [
        sys.executable,
        "-m",
        "parallel_eval.benchmark",
        "run",
        "--dataset",
        str(dataset),
        "--db-path",
        str(db_path),
        "--model",
        f"openai-responses:{model}",
        "--openai-reasoning-effort",
        effort,
        "--concurrency",
        str(concurrency),
        "--store-raw-output",
        "truncated",
        "--llm-output-max-chars",
        "4000",
        "--overwrite",
        "--setup-id",
        "classic_local_v1",
        "--out",
        str(records_path),
    ]


def _run_cell_subprocess(command: list[str], log_path: Path) -> int:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("w", encoding="utf-8") as handle:
        result = subprocess.run(
            command,
            cwd=REPO_ROOT,
            stdout=handle,
            stderr=subprocess.STDOUT,
            text=True,
            check=False,
        )
    return int(result.returncode)


def _tail_log(log_path: Path, *, max_chars: int = 1000) -> str | None:
    try:
        text = log_path.read_text("utf-8")
    except Exception:
        return None
    tail = text[-max_chars:].strip()
    return tail or None


def _run_identity_key(records_path: Path) -> tuple[str, str]:
    try:
        with records_path.open("r", encoding="utf-8") as handle:
            for line in handle:
                text = line.strip()
                if not text:
                    continue
                payload = json.loads(text)
                if not isinstance(payload, dict) or payload.get("type") != "run":
                    continue
                model_settings = payload.get("model_settings")
                if not isinstance(model_settings, dict):
                    break
                model = model_settings.get("model")
                effort = model_settings.get("openai_reasoning_effort")
                return (
                    model if isinstance(model, str) else "",
                    effort if isinstance(effort, str) else "",
                )
    except Exception:
        pass
    return ("__path__", str(records_path))


def _published_source_records(public_dir: Path) -> list[Path]:
    leaderboard_path = public_dir / "leaderboard.json"
    if not leaderboard_path.exists():
        return []
    try:
        payload = json.loads(leaderboard_path.read_text("utf-8"))
    except Exception:
        return []
    entries = payload.get("entries")
    if not isinstance(entries, list):
        return []

    records: list[Path] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        source_jsonl = entry.get("source_jsonl")
        if not isinstance(source_jsonl, str) or not source_jsonl:
            continue
        path = Path(source_jsonl).expanduser()
        key = str(path)
        if key in seen or not path.exists():
            continue
        seen.add(key)
        records.append(path)
    return records


def _records_for_publish(*, public_dir: Path, completed_records: list[Path]) -> list[Path]:
    deduped: dict[tuple[str, str], Path] = {}
    for path in _published_source_records(public_dir):
        deduped[_run_identity_key(path)] = path
    for path in completed_records:
        deduped[_run_identity_key(path)] = path
    return list(deduped.values())


async def _run_cells(
    *,
    cells: list[CellStatus],
    dataset: Path,
    db_path: Path,
    concurrency: int,
    max_active_cells: int,
    persist_status: Callable[[], None],
) -> None:
    state_lock = asyncio.Lock()
    semaphore = asyncio.Semaphore(max(1, max_active_cells))

    async def run_one(cell: CellStatus) -> None:
        if not cell.records_path or not cell.summary_path or not cell.viewer_path or not cell.log_path:
            raise RuntimeError(f"Missing artifact paths for {cell.model} {cell.effort}")
        records_path = Path(cell.records_path)
        summary_path = Path(cell.summary_path)
        viewer_path = Path(cell.viewer_path)
        log_path = Path(cell.log_path)
        command = _run_command(
            dataset=dataset,
            db_path=db_path,
            records_path=records_path,
            model=cell.model,
            effort=cell.effort,
            concurrency=concurrency,
        )

        async with semaphore:
            async with state_lock:
                cell.status = "running"
                cell.run_error = None
                persist_status()

            exit_code: int | None = None
            raised_error: str | None = None
            try:
                exit_code = await asyncio.to_thread(_run_cell_subprocess, command, log_path)
            except Exception as exc:
                raised_error = str(exc)

            async with state_lock:
                if exit_code == 0 and records_path.exists() and summary_path.exists() and viewer_path.exists():
                    cell.status = "completed"
                    cell.run_error = None
                else:
                    cell.status = "failed"
                    if raised_error is not None:
                        cell.run_error = raised_error
                    elif exit_code is None:
                        cell.run_error = f"benchmark subprocess did not produce an exit status; see {log_path}"
                    else:
                        log_tail = _tail_log(log_path)
                        cell.run_error = (
                            f"benchmark exited with status {exit_code}; see {log_path}"
                            if not log_tail
                            else f"benchmark exited with status {exit_code}; see {log_path}; tail: {log_tail}"
                        )
                persist_status()

    await asyncio.gather(*(run_one(cell) for cell in cells))


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the canonical WikiRacing benchmark matrix.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--db-path", type=Path, default=DEFAULT_DB_PATH)
    parser.add_argument("--public-dir", type=Path, default=DEFAULT_PUBLIC_DIR)
    parser.add_argument("--bundle-dir", type=Path, default=None)
    parser.add_argument("--dataset-id", type=str, default=None, help="Optional explicit dataset id override.")
    parser.add_argument("--concurrency", type=int, default=1, help="Matchup-level concurrency for benchmark execution.")
    parser.add_argument("--max-active-cells", type=int, default=1, help="Maximum number of benchmark cells to run in parallel.")
    parser.add_argument("--models", nargs="*", default=None, help="Optional model subset, for example: gpt-5.1 gpt-5.2")
    parser.add_argument("--efforts", nargs="*", default=None, help="Optional effort subset, for example: none low medium")
    parser.add_argument("--skip-existing", action="store_true", help="Skip cells whose records/summary/viewer already exist.")
    parser.add_argument("--no-publish", action="store_true", help="Do not overwrite public benchmark assets.")
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    dataset = args.dataset.expanduser()
    db_path = args.db_path.expanduser()
    public_dir = args.public_dir.expanduser()
    dataset_id = (
        args.dataset_id.strip()
        if isinstance(args.dataset_id, str) and args.dataset_id.strip()
        else _dataset_id_for_matchups(dataset)
    )
    bundle_dir = (
        args.bundle_dir.expanduser()
        if args.bundle_dir is not None
        else Path(f"results/benchmarks/frontier_local_simplewiki_standard_v1_matrix_{_now_compact()}")
    )
    bundle_dir.mkdir(parents=True, exist_ok=True)

    selected_models = _selected_models(args.models)
    selected_efforts = _selected_efforts(args.efforts)

    cells: list[CellStatus] = []
    for model in selected_models:
        for effort in selected_efforts:
            records_path, summary_path, viewer_path, log_path = _run_paths(bundle_dir, model, effort)
            supported, probe_error = asyncio.run(_probe_support(model, effort))
            status = "pending" if supported else "unsupported"
            cells.append(
                CellStatus(
                    model=model,
                    effort=effort,
                    supported=supported,
                    status=status,
                    probe_error=probe_error,
                    records_path=str(records_path),
                    summary_path=str(summary_path),
                    viewer_path=str(viewer_path),
                    log_path=str(log_path),
                )
            )
            _write_status(bundle_dir=bundle_dir, dataset=dataset, dataset_id=dataset_id, db_path=db_path, cells=cells)

    if not cells:
        raise SystemExit("No model/effort cells matched the requested filters.")

    for cell in cells:
        if not cell.supported or not cell.records_path or not cell.summary_path or not cell.viewer_path:
            continue
        records_path = Path(cell.records_path)
        summary_path = Path(cell.summary_path)
        viewer_path = Path(cell.viewer_path)
        if (
            args.skip_existing
            and records_path.exists()
            and summary_path.exists()
            and viewer_path.exists()
            and _existing_run_matches(
                records_path=records_path,
                dataset_id=dataset_id,
                db_path=db_path,
                model=f"openai-responses:{cell.model}",
                effort=cell.effort,
                setup_id="classic_local_v1",
            )
        ):
            cell.status = "completed"
            _write_status(bundle_dir=bundle_dir, dataset=dataset, dataset_id=dataset_id, db_path=db_path, cells=cells)

    pending_cells = [cell for cell in cells if cell.supported and cell.status == "pending"]
    if pending_cells:
        asyncio.run(
            _run_cells(
                cells=pending_cells,
                dataset=dataset,
                db_path=db_path,
                concurrency=args.concurrency,
                max_active_cells=args.max_active_cells,
                persist_status=lambda: _write_status(
                    bundle_dir=bundle_dir,
                    dataset=dataset,
                    dataset_id=dataset_id,
                    db_path=db_path,
                    cells=cells,
                ),
            )
        )

    completed_records = [
        Path(cell.records_path)
        for cell in cells
        if cell.status == "completed" and isinstance(cell.records_path, str) and cell.records_path
    ]
    if completed_records:
        write_text_report(
            inputs=completed_records,
            out_path=bundle_dir / "report_core.md",
            dataset_id=dataset_id,
            slice_id="core_rank_v1",
        )
        write_text_report(
            inputs=completed_records,
            out_path=bundle_dir / "report_overall.md",
            dataset_id=dataset_id,
            slice_id=None,
        )

        public_leaderboard_path = None
        publish_error = None
        if not args.no_publish:
            incomplete_cells = [
                f"{cell.model} {cell.effort}"
                for cell in cells
                if cell.status not in {"completed", "unsupported"}
            ]
            if incomplete_cells:
                publish_error = (
                    "Refusing to publish incomplete matrix bundle. "
                    f"Unfinished cells: {', '.join(incomplete_cells)}"
                )
            else:
                public_dir.mkdir(parents=True, exist_ok=True)
                public_viewers_dir = public_dir / "viewers"
                shutil.rmtree(public_viewers_dir, ignore_errors=True)
                public_viewers_dir.mkdir(parents=True, exist_ok=True)

                publish_records = _records_for_publish(public_dir=public_dir, completed_records=completed_records)
                results_leaderboard_path = Path("results/benchmarks/leaderboard.json")
                results_leaderboard_path.parent.mkdir(parents=True, exist_ok=True)
                write_leaderboard_json(
                    inputs=publish_records,
                    out_path=results_leaderboard_path,
                    dataset_id=dataset_id,
                    default_slice_id="core_rank_v1",
                    viewer_out_dir=public_viewers_dir,
                    viewer_url_prefix="/benchmarks/viewers",
                )
                leaderboard_path = bundle_dir / "leaderboard.json"
                shutil.copyfile(results_leaderboard_path, leaderboard_path)
                public_leaderboard_path = public_dir / "leaderboard.json"
                shutil.copyfile(results_leaderboard_path, public_leaderboard_path)

        _write_status(
            bundle_dir=bundle_dir,
            dataset=dataset,
            dataset_id=dataset_id,
            db_path=db_path,
            cells=cells,
            public_leaderboard_path=public_leaderboard_path,
            publish_error=publish_error,
        )
        if publish_error is not None:
            raise SystemExit(publish_error)

    _write_support_report(bundle_dir=bundle_dir, cells=cells)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
