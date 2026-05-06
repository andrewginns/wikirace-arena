from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from parallel_eval.benchmark.schema import read_jsonl
from parallel_eval.benchmark.scoring import CompositeWeights
from parallel_eval.benchmark.summarize import build_summary_and_viewer


TASK_GROUP_LABELS: dict[str, str] = {
    "core_rank_v1": "Core tasks",
    "diag_bridge_pressure_v1": "Bottleneck links (v1)",
    "diag_bridge_pressure_v2": "Bottleneck links (v2)",
    "diag_canonical_target_v1": "Canonical page title",
    "diag_dead_end_prone_v1": "Dead ends (v1)",
    "diag_dead_end_prone_v2": "Dead ends (v2)",
    "diag_hub_escape_v1": "Getting off broad pages",
    "diag_hub_seek_v1": "Moving toward broad pages",
    "diag_target_rarity_v1": "Hard-to-find targets",
    "diag_wide_choice_v1": "Many choices",
    "route_fragility_v1": "Easy-to-break routes",
    "target_rarity_coupled_v1": "Hard-to-find targets under pressure",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


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


def _sort_key(entry: dict[str, Any]) -> tuple[float, float, float, float, str]:
    bucket = entry["bucket"]
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


def _fmt_percent(value: Optional[float]) -> str:
    if value is None:
        return "-"
    return f"{value * 100:.2f}"


def _fmt_number(value: Optional[float]) -> str:
    if value is None:
        return "-"
    if abs(value - round(value)) < 1e-9:
        return f"{int(round(value)):,}"
    return f"{value:.2f}"


def _analysis(summary: dict[str, Any]) -> dict[str, Any]:
    value = summary.get("analysis")
    return value if isinstance(value, dict) else {}


def _suite_manifest_detail(suite_id: str) -> Optional[dict[str, Any]]:
    manifest_path = Path("benchmarks") / "matchups" / suite_id / "suite_manifest.json"
    if not manifest_path.exists():
        return None
    try:
        value = json.loads(manifest_path.read_text("utf-8"))
    except Exception:
        return None
    return value if isinstance(value, dict) else None


def _slice_analysis(summary: dict[str, Any], slice_id: Optional[str]) -> dict[str, Any]:
    analysis = _analysis(summary)
    if slice_id:
        slices = analysis.get("slices")
        if isinstance(slices, dict):
            value = slices.get(slice_id)
            if isinstance(value, dict):
                return value
    overall = analysis.get("overall")
    return overall if isinstance(overall, dict) else {}


def _task_group_label(slice_id: Optional[str]) -> str:
    if not slice_id:
        return "Overall"
    return TASK_GROUP_LABELS.get(slice_id, slice_id)


def _loss_reason_label(reason: str) -> str:
    if reason == "max_steps":
        return "step limit"
    if reason == "llm_error":
        return "model error"
    return reason.replace("_", " ")


def _frontier_comment(entry: dict[str, Any]) -> str:
    bucket = entry["bucket"]
    analysis = _analysis(entry["summary"])
    diagnostics = analysis.get("diagnostics") if isinstance(analysis.get("diagnostics"), dict) else {}
    weakest_slice_id = diagnostics.get("weakest_slice_id")
    weakest_delta = diagnostics.get("weakest_delta_vs_core")

    if bucket.get("wins") == bucket.get("total_runs"):
        return "Perfect task-group completion"
    if bucket.get("wins") == 0:
        return "No wins in this task group"
    if isinstance(weakest_slice_id, str) and isinstance(weakest_delta, (int, float)) and weakest_delta <= -0.15:
        return f"Weakest on {_task_group_label(weakest_slice_id)}"
    return "Strong success-rate / efficiency tradeoff"


def build_text_report(
    *,
    inputs: list[Path],
    weights: CompositeWeights = CompositeWeights(),
    dataset_id: Optional[str] = None,
    slice_id: Optional[str] = "core_rank_v1",
) -> str:
    entries: list[dict[str, Any]] = []
    for path in inputs:
        lines = read_jsonl(path)
        summary, _viewer = build_summary_and_viewer(lines=lines, source_jsonl=str(path), weights=weights)
        meta = summary.get("meta") if isinstance(summary.get("meta"), dict) else {}
        if dataset_id is not None:
            dataset_ids = meta.get("dataset_ids")
            if not isinstance(dataset_ids, list) or dataset_id not in dataset_ids:
                continue
        entries.append(
            {
                "path": path,
                "summary": summary,
                "bucket": _bucket_for_slice(summary, slice_id),
                "label": _summary_label(summary),
            }
        )

    entries.sort(key=_sort_key)

    lines: list[str] = []
    lines.append("# Benchmark Report")
    lines.append("")
    lines.append(f"- Generated at: `{_now_iso()}`")
    lines.append(f"- Inputs: `{len(entries)}`")
    lines.append(f"- Task group: `{_task_group_label(slice_id)}`")
    if dataset_id:
        lines.append(f"- Dataset filter: `{dataset_id}`")
    lines.append("")

    if not entries:
        lines.append("No benchmark inputs matched the requested filters.")
        return "\n".join(lines) + "\n"

    suite_ids = sorted(
        {
            suite_id
            for entry in entries
            for suite_id in (
                entry["summary"].get("meta", {}).get("suite_ids")
                if isinstance(entry["summary"].get("meta"), dict)
                and isinstance(entry["summary"].get("meta", {}).get("suite_ids"), list)
                else []
            )
            if isinstance(suite_id, str) and suite_id
        }
    )
    if suite_ids:
        lines.append("## Suite Status")
        lines.append("")
        for suite_id in suite_ids:
            detail = _suite_manifest_detail(suite_id)
            if not detail:
                lines.append(f"- `{suite_id}` | manifest unavailable | treat as provisional")
                continue
            generator = detail.get("generator_version") if isinstance(detail.get("generator_version"), str) else "unknown"
            status = "provisional" if "seeded" in generator else "graph-native"
            lines.append(f"- `{suite_id}` | `{status}` | generator `{generator}`")
        lines.append("")

    lines.append("## Success-Rate Leaderboard")
    lines.append("")
    max_bar = 20
    for entry in entries:
        bucket = entry["bucket"]
        win_rate = bucket.get("win_rate")
        win_rate = float(win_rate) if isinstance(win_rate, (int, float)) else 0.0
        filled = max(0, min(max_bar, int(round(win_rate * max_bar))))
        bar = "█" * filled + " " * (max_bar - filled)
        lines.append(f"{entry['label']:<28} {_fmt_percent(win_rate):>6} | {bar}")
    lines.append("")

    lines.append("## Ranking")
    lines.append("")
    lines.append(
        "| Rank | Run | Success % | Median extra clicks vs shortest path | Median total tokens | Median model response time ms | Legacy score |"
    )
    lines.append("|---|---|---:|---:|---:|---:|---:|")
    for rank, entry in enumerate(entries, start=1):
        bucket = entry["bucket"]
        lines.append(
            "| "
            + " | ".join(
                [
                    str(rank),
                    entry["label"],
                    _fmt_percent(bucket.get("win_rate") if isinstance(bucket.get("win_rate"), (int, float)) else None),
                    _fmt_number(_metric(bucket, "hops_over_shortest_win")),
                    _fmt_number(_metric(bucket, "total_tokens_win")),
                    _fmt_number(_metric(bucket, "llm_latency_ms_win")),
                    _fmt_number(bucket.get("legacy_score_v1_sum") if isinstance(bucket.get("legacy_score_v1_sum"), (int, float)) else None),
                ]
            )
            + " |"
        )
    lines.append("")

    frontier_specs = [
        ("Tokens vs Success Rate", "Median total tokens"),
        ("Response Time vs Success Rate", "Median model response time ms"),
        ("Extra Clicks vs Success Rate", "Median extra clicks vs shortest path"),
    ]
    frontier_keys = ["total_tokens_win", "llm_latency_ms_win", "hops_over_shortest_win"]
    for (title, metric_label), frontier_key in zip(frontier_specs, frontier_keys):
        lines.append(f"## {title}")
        lines.append("")
        lines.append(f"| Run | Win % | {metric_label} | Comment |")
        lines.append("|---|---:|---:|---|")
        for entry in entries:
            bucket = entry["bucket"]
            lines.append(
                "| "
                + " | ".join(
                    [
                        entry["label"],
                        _fmt_percent(bucket.get("win_rate") if isinstance(bucket.get("win_rate"), (int, float)) else None),
                        _fmt_number(_metric(bucket, frontier_key)),
                        _frontier_comment(entry),
                    ]
                )
                + " |"
            )
        lines.append("")

    lines.append("## Weakness Areas")
    lines.append("")
    lines.append("| Run | Weakest task group | Delta vs core | Strongest task group | Delta vs core |")
    lines.append("|---|---|---:|---|---:|")
    for entry in entries:
        diagnostics = _analysis(entry["summary"]).get("diagnostics")
        diagnostics = diagnostics if isinstance(diagnostics, dict) else {}
        lines.append(
            "| "
            + " | ".join(
                [
                    entry["label"],
                    _task_group_label(diagnostics.get("weakest_slice_id")),
                    _fmt_percent(
                        diagnostics.get("weakest_delta_vs_core")
                        if isinstance(diagnostics.get("weakest_delta_vs_core"), (int, float))
                        else None
                    ),
                    _task_group_label(diagnostics.get("strongest_slice_id")),
                    _fmt_percent(
                        diagnostics.get("strongest_delta_vs_core")
                        if isinstance(diagnostics.get("strongest_delta_vs_core"), (int, float))
                        else None
                    ),
                ]
            )
            + " |"
        )
    lines.append("")

    lines.append("## Navigation Patterns")
    lines.append("")
    lines.append(
        "| Run | Average tries | Retry rate | Backtrack rate | Moves to broad pages | Moves into dead ends | Invalid answer rate |"
    )
    lines.append("|---|---:|---:|---:|---:|---:|---:|")
    for entry in entries:
        analysis = _slice_analysis(entry["summary"], slice_id)
        lines.append(
            "| "
            + " | ".join(
                [
                    entry["label"],
                    _fmt_number(
                        analysis.get("mean_attempt_count")
                        if isinstance(analysis.get("mean_attempt_count"), (int, float))
                        else None
                    ),
                    _fmt_percent(
                        analysis.get("retry_step_rate")
                        if isinstance(analysis.get("retry_step_rate"), (int, float))
                        else None
                    ),
                    _fmt_percent(
                        analysis.get("revisit_rate")
                        if isinstance(analysis.get("revisit_rate"), (int, float))
                        else None
                    ),
                    _fmt_percent(
                        analysis.get("hub_move_rate")
                        if isinstance(analysis.get("hub_move_rate"), (int, float))
                        else None
                    ),
                    _fmt_percent(
                        analysis.get("dead_end_move_rate")
                        if isinstance(analysis.get("dead_end_move_rate"), (int, float))
                        else None
                    ),
                    _fmt_percent(
                        analysis.get("bad_answer_step_rate")
                        if isinstance(analysis.get("bad_answer_step_rate"), (int, float))
                        else None
                    ),
                ]
            )
            + " |"
        )
    lines.append("")

    lines.append("## Loss Costs")
    lines.append("")
    lines.append("| Run | Losses | Loss reasons | Mean tokens on losses | Mean model response time on losses |")
    lines.append("|---|---:|---|---:|---:|")
    for entry in entries:
        bucket = entry["bucket"]
        loss_reasons = bucket.get("loss_reasons") if isinstance(bucket.get("loss_reasons"), dict) else {}
        loss_reason_text = ", ".join(
            f"{_loss_reason_label(str(key))}={value}" for key, value in loss_reasons.items()
        ) or "-"
        lines.append(
            "| "
            + " | ".join(
                [
                    entry["label"],
                    str(bucket.get("losses") if isinstance(bucket.get("losses"), int) else 0),
                    loss_reason_text,
                    _fmt_number(
                        bucket.get("mean_total_tokens_loss")
                        if isinstance(bucket.get("mean_total_tokens_loss"), (int, float))
                        else None
                    ),
                    _fmt_number(
                        bucket.get("mean_llm_latency_ms_loss")
                        if isinstance(bucket.get("mean_llm_latency_ms_loss"), (int, float))
                        else None
                    ),
                ]
            )
            + " |"
        )
    lines.append("")

    return "\n".join(lines)


def write_text_report(
    *,
    inputs: list[Path],
    out_path: Path,
    weights: CompositeWeights = CompositeWeights(),
    dataset_id: Optional[str] = None,
    slice_id: Optional[str] = "core_rank_v1",
) -> str:
    report = build_text_report(inputs=inputs, weights=weights, dataset_id=dataset_id, slice_id=slice_id)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(report, "utf-8")
    return report
