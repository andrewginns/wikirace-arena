from __future__ import annotations

import argparse
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path

from parallel_eval.benchmark.ground_truth import compute_ground_truth_shortest_paths
from parallel_eval.benchmark.fixed_suite import (
    DEFAULT_SUITE_ID,
    generate_fixed_suite,
    probe_fixed_suite,
)
from parallel_eval.benchmark.import_session import import_session_json
from parallel_eval.benchmark.import_viewer import import_viewer_json
from parallel_eval.benchmark.leaderboard import write_leaderboard_json
from parallel_eval.benchmark.matchups import generate_matchups_dataset
from parallel_eval.benchmark.report_text import write_text_report
from parallel_eval.benchmark.runner import run_benchmark_dataset
from parallel_eval.benchmark.settings import CLASSIC_LOCAL_V1, DEFAULT_BENCHMARK_DB_PATH
from parallel_eval.benchmark.summarize import summarize_benchmark_jsonl


def _path(value: str) -> Path:
    return Path(value).expanduser()


def _now_compact() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _slug(value: str) -> str:
    value = (value or "").strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value)
    value = re.sub(r"-+", "-", value).strip("-")
    return value or "run"


def _default_run_out_path(*, out_dir: Path, dataset: Path, model: str, tag: str | None) -> Path:
    dataset_slug = _slug(dataset.stem)
    model_slug = _slug(model)
    ts = _now_compact()
    rid = uuid.uuid4().hex[:8]
    parts = [dataset_slug, model_slug]
    if tag:
        parts.append(_slug(tag))
    parts.extend([ts, rid])
    return out_dir / "__".join(parts) / "records.jsonl"


def _default_import_out_path(*, out_dir: Path, source_json: Path, dataset: Path | None, tag: str | None, prefix: str) -> Path:
    base = _slug(source_json.stem)
    ts = _now_compact()
    rid = uuid.uuid4().hex[:8]
    parts = [prefix, base]
    if dataset is not None:
        parts.append(_slug(dataset.stem))
    if tag:
        parts.append(_slug(tag))
    parts.extend([ts, rid])
    return out_dir / "__".join(parts) / "records.jsonl"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m parallel_eval.benchmark")
    sub = parser.add_subparsers(dest="cmd", required=True)

    run = sub.add_parser("run", help="Run a benchmark dataset and write canonical JSONL.")
    run.add_argument("--dataset", type=_path, required=True, help="Path to a matchup JSONL file.")
    run.add_argument("--db-path", type=_path, default=DEFAULT_BENCHMARK_DB_PATH)
    run.add_argument("--model", type=str, required=True, help="PydanticAI model id (e.g. openai-responses:gpt-5.2).")
    run.add_argument("--api-base", type=str, default=None, help="Optional OpenAI-compatible base URL.")
    run.add_argument("--openai-api-mode", type=str, default=None, help="When --api-base is set: chat (default) or responses.")
    run.add_argument("--openai-reasoning-effort", type=str, default=None)
    run.add_argument("--openai-reasoning-summary", type=str, default=None)
    run.add_argument("--anthropic-thinking-budget-tokens", type=int, default=None)
    run.add_argument("--google-thinking-config", type=_path, default=None, help="Path to a JSON file with google_thinking_config.")
    run.add_argument("--setup-id", type=str, default=CLASSIC_LOCAL_V1.id)
    run.add_argument("--slice-id", type=str, default=None, help="Optional slice filter for multi-slice datasets.")
    run.add_argument("--max-hops", type=int, default=0, help="Override setup max_hops; 0 uses the setup default.")
    run.add_argument("--max-links", type=int, default=None, help="Override setup max_links; omit to use the setup default.")
    run.add_argument("--max-tokens", type=int, default=None)
    run.add_argument("--max-tries", type=int, default=0, help="Override setup max_tries; 0 uses the setup default.")
    run.add_argument("--concurrency", type=int, default=1)
    run.add_argument("--seed", type=int, default=0)
    run.add_argument("--store-raw-output", choices=("none", "truncated", "full"), default="truncated")
    run.add_argument("--include-llm-output", action="store_true", help="Deprecated alias for --store-raw-output truncated.")
    run.add_argument("--llm-output-max-chars", type=int, default=4000)
    run.add_argument("--out", type=_path, default=None, help="Output JSONL path (default: auto-generate under --out-dir).")
    run.add_argument("--out-dir", type=_path, default=Path("results/benchmarks"), help="Directory for auto-named outputs.")
    run.add_argument("--tag", type=str, default=None, help="Optional label added to the auto-generated filename.")
    run.add_argument("--overwrite", action="store_true", help="Allow overwriting --out if it already exists.")
    run.add_argument("--no-viewer-json", action="store_true", help="Skip writing <out>.viewer.json.")
    run.add_argument("--no-summary-json", action="store_true", help="Skip writing <out>.summary.json.")

    summarize = sub.add_parser("summarize", help="Summarize canonical JSONL into .summary.json and .viewer.json.")
    summarize.add_argument("jsonl", type=_path, help="Path to canonical benchmark JSONL.")
    summarize.add_argument("--out-summary", type=_path, default=None, help="Output summary JSON (default: <jsonl>.summary.json).")
    summarize.add_argument("--out-viewer", type=_path, default=None, help="Output viewer JSON (default: <jsonl>.viewer.json).")

    report = sub.add_parser("report-text", help="Render one or more benchmark JSONLs into a markdown report.")
    report.add_argument("--inputs", type=_path, nargs="+", required=True)
    report.add_argument("--out", type=_path, required=True, help="Output markdown path.")
    report.add_argument("--dataset-id", type=str, default=None)
    report.add_argument("--slice-id", type=str, default="core_rank_v1")

    imp = sub.add_parser("import-viewer", help="Convert Viewer JSON exports into canonical benchmark JSONL.")
    imp.add_argument("viewer_json", type=_path)
    imp.add_argument("--dataset", type=_path, default=None, help="Optional matchup JSONL to link runs to matchup ids/tiers.")
    imp.add_argument("--dataset-id", type=str, default=None, help="Dataset id label (default derived from --dataset name).")
    imp.add_argument("--out", type=_path, default=None, help="Output JSONL path (default: auto-generate under --out-dir).")
    imp.add_argument("--out-dir", type=_path, default=Path("results/benchmarks"), help="Directory for auto-named outputs.")
    imp.add_argument("--tag", type=str, default=None, help="Optional label added to the auto-generated filename.")
    imp.add_argument("--overwrite", action="store_true", help="Allow overwriting --out if it already exists.")

    session = sub.add_parser("import-session", help="Convert exported race/session JSON into canonical benchmark JSONL.")
    session.add_argument("session_json", type=_path)
    session.add_argument("--dataset", type=_path, default=None, help="Optional matchup JSONL to link runs to matchup ids/slices.")
    session.add_argument(
        "--dataset-id",
        type=str,
        default=None,
        help="Dataset id label (default: observed_app_races/<session file stem>).",
    )
    session.add_argument("--db-path", type=_path, default=Path("parallel_eval/wikihop.db"))
    session.add_argument("--out", type=_path, default=None, help="Output JSONL path (default: auto-generate under --out-dir).")
    session.add_argument("--out-dir", type=_path, default=Path("results/benchmarks"), help="Directory for auto-named outputs.")
    session.add_argument("--tag", type=str, default=None, help="Optional label added to the auto-generated filename.")
    session.add_argument("--overwrite", action="store_true", help="Allow overwriting --out if it already exists.")

    gen = sub.add_parser("generate-matchups", help="Generate a tiered matchup dataset from wikihop.db.")
    gen.add_argument("--db-path", type=_path, default=DEFAULT_BENCHMARK_DB_PATH)
    gen.add_argument("--out", type=_path, required=True, help="Output JSONL path.")
    gen.add_argument("--out-meta", type=_path, default=None, help="Output meta JSON path (default: <out>.meta.json).")
    gen.add_argument("--count", type=int, default=200)
    gen.add_argument("--smoke-count", type=int, default=20)
    gen.add_argument("--seed", type=int, default=0)
    gen.add_argument("--max-distance", type=int, default=30, help="Maximum BFS depth when estimating distance.")
    gen.add_argument("--min-distance", type=int, default=6, help="Minimum distance to consider for hard/frontier tiers.")
    gen.add_argument("--hub-top-k-out", type=int, default=200)
    gen.add_argument("--hub-top-k-in", type=int, default=200)
    gen.add_argument("--min-out-degree", type=int, default=1)
    gen.add_argument("--max-out-degree", type=int, default=400)
    gen.add_argument("--candidate-sample", type=int, default=20000)
    gen.add_argument("--pair-sample", type=int, default=20000)

    gt = sub.add_parser(
        "compute-shortest-paths",
        help="Compute ground-truth shortest paths for a matchup dataset (adds `shortest_path`).",
    )
    gt.add_argument("--dataset", type=_path, required=True, help="Path to a matchup JSONL file.")
    gt.add_argument("--db-path", type=_path, default=DEFAULT_BENCHMARK_DB_PATH)
    gt.add_argument("--out", type=_path, required=True, help="Output JSONL path.")
    gt.add_argument("--out-meta", type=_path, default=None, help="Output meta JSON path (default: <out>.meta.json).")
    gt.add_argument("--max-depth", type=int, default=30, help="Hard cap on shortest-path depth search.")
    gt.add_argument("--max-nodes", type=int, default=200_000, help="Hard cap on BFS node expansions per start.")
    gt.add_argument(
        "--search-mode",
        type=str,
        choices=("forward", "bidirectional"),
        default="forward",
        help="Shortest-path search strategy. forward is best when many targets share a start.",
    )
    gt.add_argument(
        "--overwrite-hops",
        action="store_true",
        help="Overwrite shortest_path_hops (and dist=... tags) when computed hops differ.",
    )

    fixed = sub.add_parser("generate-fixed-suite", help="Generate the fixed versioned matchup suite.")
    fixed.add_argument("--db-path", type=_path, default=DEFAULT_BENCHMARK_DB_PATH)
    fixed.add_argument("--suite-id", type=str, default=DEFAULT_SUITE_ID)
    fixed.add_argument("--out-dir", type=_path, default=None)
    fixed.add_argument("--seed", type=int, default=0)

    probe = sub.add_parser("probe-fixed-suite", help="Explain fixed-suite feasibility against the current DB.")
    probe.add_argument("--db-path", type=_path, default=DEFAULT_BENCHMARK_DB_PATH)
    probe.add_argument("--suite-id", type=str, default=DEFAULT_SUITE_ID)
    probe.add_argument("--seed", type=int, default=0)
    probe.add_argument("--out", type=_path, default=None, help="Optional output JSON path for the probe report.")

    lb = sub.add_parser("leaderboard", help="Merge many benchmark JSONLs into one leaderboard JSON.")
    lb.add_argument("--inputs", type=_path, nargs="+", required=True, help="Input canonical benchmark JSONL files.")
    lb.add_argument("--out", type=_path, default=Path("results/benchmarks/leaderboard.json"))
    lb.add_argument("--dataset-id", type=str, default=None, help="Optional dataset_id filter (e.g. matchups/v1).")
    lb.add_argument(
        "--default-slice-id",
        type=str,
        default="core_rank_v1",
        help="Default slice id used for lexicographic ranking (falls back to overall when absent).",
    )
    lb.add_argument(
        "--viewer-out-dir",
        type=_path,
        default=None,
        help="Optional directory to copy viewer.json artifacts into for frontend drilldown.",
    )
    lb.add_argument(
        "--viewer-url-prefix",
        type=str,
        default=None,
        help="Optional public URL prefix for copied viewer artifacts (for example /benchmarks/viewers).",
    )

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.cmd == "run":
        google_thinking_config = None
        if args.google_thinking_config is not None:
            import json

            google_thinking_config = json.loads(args.google_thinking_config.read_text("utf-8"))

        raw_output_mode = args.store_raw_output
        if args.include_llm_output and raw_output_mode == "none":
            raw_output_mode = "truncated"

        out_path = args.out
        if out_path is None:
            out_path = _default_run_out_path(out_dir=args.out_dir, dataset=args.dataset, model=args.model, tag=args.tag)

        run_benchmark_dataset(
            dataset_path=args.dataset,
            db_path=args.db_path,
            out_path=out_path,
            model=args.model,
            api_base=args.api_base,
            openai_api_mode=args.openai_api_mode,
            openai_reasoning_effort=args.openai_reasoning_effort,
            openai_reasoning_summary=args.openai_reasoning_summary,
            anthropic_thinking_budget_tokens=args.anthropic_thinking_budget_tokens,
            google_thinking_config=google_thinking_config,
            max_hops=args.max_hops,
            max_links=args.max_links,
            max_tokens=args.max_tokens,
            max_tries=args.max_tries,
            concurrency=args.concurrency,
            seed=args.seed,
            raw_output_mode=raw_output_mode,
            llm_output_max_chars=args.llm_output_max_chars,
            write_viewer_json=not args.no_viewer_json,
            write_summary_json=not args.no_summary_json,
            overwrite=args.overwrite,
            setup_id=args.setup_id,
            slice_id=args.slice_id,
        )
        print(out_path)
        return 0

    if args.cmd == "summarize":
        out_summary = args.out_summary
        out_viewer = args.out_viewer
        if out_summary is None:
            out_summary = args.jsonl.parent / "summary.json" if args.jsonl.name == "records.jsonl" else Path(str(args.jsonl) + ".summary.json")
        if out_viewer is None:
            out_viewer = args.jsonl.parent / "viewer.json" if args.jsonl.name == "records.jsonl" else Path(str(args.jsonl) + ".viewer.json")
        summarize_benchmark_jsonl(
            jsonl_path=args.jsonl,
            out_summary_path=out_summary,
            out_viewer_path=out_viewer,
        )
        return 0

    if args.cmd == "report-text":
        write_text_report(
            inputs=args.inputs,
            out_path=args.out,
            dataset_id=args.dataset_id,
            slice_id=args.slice_id,
        )
        print(args.out)
        return 0

    if args.cmd == "import-viewer":
        out_path = args.out
        if out_path is None:
            out_path = _default_import_out_path(
                out_dir=args.out_dir,
                source_json=args.viewer_json,
                dataset=args.dataset,
                tag=args.tag,
                prefix="import-viewer",
            )
        import_viewer_json(
            viewer_json_path=args.viewer_json,
            dataset_path=args.dataset,
            dataset_id=args.dataset_id,
            out_path=out_path,
            overwrite=args.overwrite,
        )
        print(out_path)
        return 0

    if args.cmd == "import-session":
        out_path = args.out
        if out_path is None:
            out_path = _default_import_out_path(
                out_dir=args.out_dir,
                source_json=args.session_json,
                dataset=args.dataset,
                tag=args.tag,
                prefix="import-session",
            )
        import_session_json(
            session_json_path=args.session_json,
            dataset_path=args.dataset,
            dataset_id=args.dataset_id,
            db_path=args.db_path,
            out_path=out_path,
            overwrite=args.overwrite,
        )
        print(out_path)
        return 0

    if args.cmd == "generate-matchups":
        generate_matchups_dataset(
            db_path=args.db_path,
            out_path=args.out,
            out_meta_path=args.out_meta,
            count=args.count,
            smoke_count=args.smoke_count,
            seed=args.seed,
            max_distance=args.max_distance,
            min_distance=args.min_distance,
            hub_top_k_out=args.hub_top_k_out,
            hub_top_k_in=args.hub_top_k_in,
            min_out_degree=args.min_out_degree,
            max_out_degree=args.max_out_degree,
            candidate_sample=args.candidate_sample,
            pair_sample=args.pair_sample,
        )
        return 0

    if args.cmd == "compute-shortest-paths":
        compute_ground_truth_shortest_paths(
            db_path=args.db_path,
            dataset_path=args.dataset,
            out_path=args.out,
            out_meta_path=args.out_meta,
            max_depth=args.max_depth,
            max_nodes=args.max_nodes,
            overwrite_hops=args.overwrite_hops,
            search_mode=args.search_mode,
            cli_args={
                "dataset": str(args.dataset),
                "db_path": str(args.db_path),
                "out": str(args.out),
                "out_meta": str(args.out_meta) if args.out_meta else None,
                "max_depth": args.max_depth,
                "max_nodes": args.max_nodes,
                "search_mode": args.search_mode,
                "overwrite_hops": args.overwrite_hops,
            },
        )
        return 0

    if args.cmd == "generate-fixed-suite":
        out_dir = args.out_dir or Path("benchmarks/matchups") / args.suite_id
        generate_fixed_suite(
            db_path=args.db_path,
            out_dir=out_dir,
            suite_id=args.suite_id,
            seed=args.seed,
        )
        print(out_dir)
        return 0

    if args.cmd == "probe-fixed-suite":
        import json

        report = probe_fixed_suite(db_path=args.db_path, suite_id=args.suite_id, seed=args.seed)
        payload = json.dumps(report, indent=2)
        if args.out is not None:
            args.out.parent.mkdir(parents=True, exist_ok=True)
            args.out.write_text(payload + "\n", "utf-8")
            print(args.out)
        else:
            print(payload)
        return 0

    if args.cmd == "leaderboard":
        write_leaderboard_json(
            inputs=args.inputs,
            out_path=args.out,
            dataset_id=args.dataset_id,
            default_slice_id=args.default_slice_id,
            viewer_out_dir=args.viewer_out_dir,
            viewer_url_prefix=args.viewer_url_prefix,
        )
        print(args.out)
        return 0

    parser.error(f"Unknown command: {args.cmd}")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
