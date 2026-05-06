from __future__ import annotations

import json
import statistics
from collections import Counter, defaultdict
from dataclasses import asdict
from pathlib import Path
from typing import Any, Optional

from parallel_eval.benchmark.analysis import build_summary_analysis
from parallel_eval.benchmark.schema import JsonlLine, read_jsonl
from parallel_eval.benchmark.scoring import CompositeWeights, matchup_score


def _median(values: list[float]) -> Optional[float]:
    if not values:
        return None
    return float(statistics.median(values))


def _mean(values: list[float]) -> Optional[float]:
    if not values:
        return None
    return float(statistics.mean(values))


def _metric_summary(values: list[float]) -> dict[str, Optional[float]]:
    if not values:
        return {"min": None, "median": None, "mean": None, "max": None}
    return {
        "min": min(values),
        "median": _median(values),
        "mean": _mean(values),
        "max": max(values),
    }


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def _token_total_from_run(run: dict[str, Any]) -> Optional[int]:
    totals = run.get("totals")
    if not isinstance(totals, dict):
        return None
    total_tokens = totals.get("total_tokens")
    if isinstance(total_tokens, int):
        return total_tokens
    prompt_tokens = totals.get("prompt_tokens")
    completion_tokens = totals.get("completion_tokens")
    if isinstance(prompt_tokens, int) or isinstance(completion_tokens, int):
        return (prompt_tokens or 0) + (completion_tokens or 0)
    return None


def _run_reason(run: dict[str, Any], steps: list[dict[str, Any]]) -> Optional[str]:
    score_inputs = run.get("score_inputs")
    if isinstance(score_inputs, dict):
        reason = score_inputs.get("final_reason")
        if isinstance(reason, str) and reason:
            return reason

    if steps:
        last_step = steps[-1]
        meta = last_step.get("meta")
        if isinstance(meta, dict):
            reason = meta.get("reason")
            if isinstance(reason, str) and reason:
                return reason

    result = run.get("result")
    if result == "win":
        return "win"
    return None


def _numeric_value(value: Any) -> Optional[float]:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return None


def build_summary_and_viewer(
    *,
    lines: list[JsonlLine],
    source_jsonl: str,
    weights: CompositeWeights = CompositeWeights(),
) -> tuple[dict[str, Any], dict[str, Any]]:
    runs: dict[str, dict[str, Any]] = {}
    steps_by_run: dict[str, list[dict[str, Any]]] = defaultdict(list)
    attempts_by_run: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for line in lines:
        t = line.data.get("type")
        if t == "run":
            run_id = line.data.get("run_id")
            if isinstance(run_id, str):
                runs[run_id] = line.data
        elif t == "step":
            run_id = line.data.get("run_id")
            if isinstance(run_id, str):
                steps_by_run[run_id].append(line.data)
        elif t == "attempt":
            run_id = line.data.get("run_id")
            if isinstance(run_id, str):
                attempts_by_run[run_id].append(line.data)

    for step_records in steps_by_run.values():
        step_records.sort(key=lambda s: int(s.get("hop") or 0))
    for attempt_records in attempts_by_run.values():
        attempt_records.sort(key=lambda a: (int(a.get("hop") or 0), int(a.get("try_index") or 0)))

    tiers = sorted({r.get("tier") for r in runs.values() if isinstance(r.get("tier"), str)})
    slices = sorted({r.get("slice_id") for r in runs.values() if isinstance(r.get("slice_id"), str) and r.get("slice_id")})

    def compute_bucket(bucket_run_ids: list[str]) -> dict[str, Any]:
        win_runs: list[dict[str, Any]] = []
        lose_runs: list[dict[str, Any]] = []
        scores: list[float] = []

        hops_wins: list[float] = []
        duration_wins: list[float] = []
        tokens_wins: list[float] = []
        tokens_per_hop_wins: list[float] = []
        latency_per_hop_wins: list[float] = []
        hops_over_shortest_wins: list[float] = []

        duration_all: list[float] = []
        tokens_all: list[float] = []
        latency_all: list[float] = []
        duration_losses: list[float] = []
        tokens_losses: list[float] = []
        latency_losses: list[float] = []
        loss_reasons: Counter[str] = Counter()

        runs_with_shortest_path_hops = 0
        win_runs_with_shortest_path_hops = 0
        solved_at_optimal_wins = 0

        for rid in bucket_run_ids:
            run = runs.get(rid)
            if not run:
                continue

            result = str(run.get("result"))
            hops = int(run.get("hops") or 0)
            duration_ms = run.get("duration_ms")
            duration_ms = int(duration_ms) if isinstance(duration_ms, int) else None
            total_tokens = _token_total_from_run(run)
            llm_latency_ms = run.get("llm_latency_ms")
            llm_latency_ms = int(llm_latency_ms) if isinstance(llm_latency_ms, int) else None
            score_inputs = run.get("score_inputs") if isinstance(run.get("score_inputs"), dict) else {}
            hops_over_shortest = _numeric_value(score_inputs.get("hops_over_shortest"))
            shortest_path_hops = run.get("shortest_path_hops")
            shortest_path_hops = (
                int(shortest_path_hops)
                if isinstance(shortest_path_hops, int) and shortest_path_hops >= 0
                else None
            )
            if hops_over_shortest is None and shortest_path_hops is not None:
                hops_over_shortest = float(hops - shortest_path_hops)
            if shortest_path_hops is not None:
                runs_with_shortest_path_hops += 1

            score = matchup_score(
                result=result,
                hops=hops,
                total_tokens=total_tokens,
                duration_ms=duration_ms,
                weights=weights,
            )
            scores.append(score)

            if duration_ms is not None:
                duration_all.append(float(duration_ms))
            if total_tokens is not None:
                tokens_all.append(float(total_tokens))
            if llm_latency_ms is not None:
                latency_all.append(float(llm_latency_ms))

            if result == "win":
                win_runs.append(run)
                hops_wins.append(float(hops))
                if duration_ms is not None:
                    duration_wins.append(float(duration_ms))
                if total_tokens is not None:
                    tokens_wins.append(float(total_tokens))
                    if hops > 0:
                        tokens_per_hop_wins.append(float(total_tokens) / float(hops))
                if llm_latency_ms is not None and hops > 0:
                    latency_per_hop_wins.append(float(llm_latency_ms) / float(hops))
                if hops_over_shortest is not None:
                    hops_over_shortest_wins.append(hops_over_shortest)
                if shortest_path_hops is not None:
                    win_runs_with_shortest_path_hops += 1
                    if hops - shortest_path_hops == 0:
                        solved_at_optimal_wins += 1
            else:
                lose_runs.append(run)
                reason = _run_reason(run, steps_by_run.get(rid) or [])
                loss_reasons[reason or "unknown"] += 1
                if duration_ms is not None:
                    duration_losses.append(float(duration_ms))
                if total_tokens is not None:
                    tokens_losses.append(float(total_tokens))
                if llm_latency_ms is not None:
                    latency_losses.append(float(llm_latency_ms))

        total = len(win_runs) + len(lose_runs)
        win_rate = (len(win_runs) / total) if total else 0.0
        median_hops_over_shortest = _median(hops_over_shortest_wins)
        median_tokens_win = _median(tokens_wins)
        win_latency_values: list[float] = []
        if win_runs:
            for rid in bucket_run_ids:
                run = runs.get(rid)
                if not run or run.get("result") != "win":
                    continue
                latency = run.get("llm_latency_ms")
                if isinstance(latency, int):
                    win_latency_values.append(float(latency))
        median_latency_win = _median(win_latency_values)

        score_v2 = None
        if total:
            score_v2 = float(win_rate * 1_000_000_000.0)
            if median_hops_over_shortest is not None:
                score_v2 -= median_hops_over_shortest * 1_000_000.0
            if median_tokens_win is not None:
                score_v2 -= median_tokens_win * 100.0
            if median_latency_win is not None:
                score_v2 -= median_latency_win

        return {
            "total_runs": total,
            "wins": len(win_runs),
            "losses": len(lose_runs),
            "win_rate": win_rate,
            "score_sum": float(sum(scores)),
            "score_mean": _mean(scores),
            "legacy_score_v1_sum": float(sum(scores)),
            "legacy_score_v1_mean": _mean(scores),
            "score_v2": score_v2,
            "hops_win": _metric_summary(hops_wins),
            "hops_over_shortest_win": _metric_summary(hops_over_shortest_wins),
            "hops_gap_win": _metric_summary(hops_over_shortest_wins),
            "duration_ms_win": _metric_summary(duration_wins),
            "duration_ms_all": _metric_summary(duration_all),
            "duration_ms_loss": _metric_summary(duration_losses),
            "total_tokens_win": _metric_summary(tokens_wins),
            "total_tokens_all": _metric_summary(tokens_all),
            "total_tokens_loss": _metric_summary(tokens_losses),
            "tokens_per_hop_win": _metric_summary(tokens_per_hop_wins),
            "llm_latency_ms_per_hop_win": _metric_summary(latency_per_hop_wins),
            "llm_latency_ms_win": _metric_summary(
                [
                    float(run["llm_latency_ms"])
                    for rid in bucket_run_ids
                    if (run := runs.get(rid))
                    and run.get("result") == "win"
                    and isinstance(run.get("llm_latency_ms"), int)
                ]
            ),
            "llm_latency_ms_all": _metric_summary(latency_all),
            "llm_latency_ms_loss": _metric_summary(latency_losses),
            "mean_total_tokens_all": _mean(tokens_all),
            "mean_llm_latency_ms_all": _mean(latency_all),
            "mean_total_tokens_loss": _mean(tokens_losses),
            "mean_llm_latency_ms_loss": _mean(latency_losses),
            "loss_reasons": dict(sorted(loss_reasons.items())),
            "ground_truth_coverage": {
                "runs_with_shortest_path_hops": runs_with_shortest_path_hops,
                "win_runs_with_shortest_path_hops": win_runs_with_shortest_path_hops,
            },
            "solved_at_optimal_win": {
                "count": solved_at_optimal_wins,
                "rate": (
                    float(solved_at_optimal_wins) / float(win_runs_with_shortest_path_hops)
                    if win_runs_with_shortest_path_hops > 0
                    else None
                ),
            },
        }

    dataset_ids: set[str] = set()
    suite_ids: set[str] = set()
    slice_ids: set[str] = set()
    setup_ids: set[str] = set()
    prompt_versions: set[str] = set()
    semantics_versions: set[str] = set()
    model_settings_values: dict[str, dict[str, Any]] = {}
    budgets_values: dict[str, dict[str, Any]] = {}
    git_shas: set[str] = set()
    db_paths: set[str] = set()
    db_sha256s: set[str] = set()
    raw_output_modes: set[str] = set()

    for run in runs.values():
        dataset_id = run.get("dataset_id")
        if isinstance(dataset_id, str) and dataset_id:
            dataset_ids.add(dataset_id)
        suite_id = run.get("suite_id")
        if isinstance(suite_id, str) and suite_id:
            suite_ids.add(suite_id)
        slice_id = run.get("slice_id")
        if isinstance(slice_id, str) and slice_id:
            slice_ids.add(slice_id)
        setup_id = run.get("setup_id")
        if isinstance(setup_id, str) and setup_id:
            setup_ids.add(setup_id)
        prompt_version = run.get("prompt_version")
        if isinstance(prompt_version, str) and prompt_version:
            prompt_versions.add(prompt_version)
        semantics_version = run.get("semantics_version")
        if isinstance(semantics_version, str) and semantics_version:
            semantics_versions.add(semantics_version)

        ms = run.get("model_settings")
        if isinstance(ms, dict):
            model_settings_values.setdefault(_stable_json(ms), ms)

        budgets = run.get("budgets")
        if isinstance(budgets, dict):
            budgets_values.setdefault(_stable_json(budgets), budgets)

        prov = run.get("provenance")
        if isinstance(prov, dict):
            sha = prov.get("git_sha")
            if isinstance(sha, str) and sha:
                git_shas.add(sha)
            dbp = prov.get("db_path")
            if isinstance(dbp, str) and dbp:
                db_paths.add(dbp)
            db_hash = prov.get("db_sha256")
            if isinstance(db_hash, str) and db_hash:
                db_sha256s.add(db_hash)
            raw_output_mode = prov.get("raw_output_mode")
            if isinstance(raw_output_mode, str) and raw_output_mode:
                raw_output_modes.add(raw_output_mode)

    model_settings_list = list(model_settings_values.values())
    budgets_list = list(budgets_values.values())

    all_run_ids = list(runs.keys())
    summary: dict[str, Any] = {
        "version": 2,
        "source_jsonl": source_jsonl,
        "weights": asdict(weights),
        "meta": {
            "dataset_ids": sorted(dataset_ids),
            "suite_ids": sorted(suite_ids),
            "slice_ids": sorted(slice_ids),
            "setup_ids": sorted(setup_ids),
            "prompt_versions": sorted(prompt_versions),
            "semantics_versions": sorted(semantics_versions),
            "models": sorted(
                {ms.get("model") for ms in model_settings_list if isinstance(ms.get("model"), str) and ms.get("model")}
            ),
            "model_settings": model_settings_list[0] if len(model_settings_list) == 1 else model_settings_list,
            "budgets": budgets_list[0] if len(budgets_list) == 1 else budgets_list,
            "git_shas": sorted(git_shas),
            "db_paths": sorted(db_paths),
            "db_sha256s": sorted(db_sha256s),
            "raw_output_modes": sorted(raw_output_modes),
            "attempt_record_count": sum(len(items) for items in attempts_by_run.values()),
        },
        "overall": compute_bucket(all_run_ids),
        "tiers": {},
        "slices": {},
    }
    slice_run_ids_map: dict[str, list[str]] = {}
    for tier in tiers:
        tier_run_ids = [rid for rid, run in runs.items() if run.get("tier") == tier]
        summary["tiers"][tier] = compute_bucket(tier_run_ids)
    for slice_id in slices:
        bucket_run_ids = [rid for rid, run in runs.items() if run.get("slice_id") == slice_id]
        summary["slices"][slice_id] = compute_bucket(bucket_run_ids)
        slice_run_ids_map[slice_id] = bucket_run_ids

    summary["analysis"] = build_summary_analysis(
        runs=runs,
        steps_by_run=steps_by_run,
        attempts_by_run=attempts_by_run,
        all_run_ids=all_run_ids,
        slice_run_ids=slice_run_ids_map,
        summary_slices=summary["slices"],
        db_paths=db_paths,
    )

    agent_settings: dict[str, Any] = {"model": "mixed", "api_base": None, "max_links": None, "max_tries": None}
    if len(model_settings_list) == 1 and len(budgets_list) == 1:
        ms = model_settings_list[0]
        budgets = budgets_list[0]
        agent_settings = {
            "model": ms.get("model") or "llm",
            "api_base": ms.get("api_base"),
            "openai_api_mode": ms.get("openai_api_mode"),
            "openai_reasoning_effort": ms.get("openai_reasoning_effort"),
            "openai_reasoning_summary": ms.get("openai_reasoning_summary"),
            "anthropic_thinking_budget_tokens": ms.get("anthropic_thinking_budget_tokens"),
            "google_thinking_config": ms.get("google_thinking_config"),
            "max_links": budgets.get("max_links"),
            "max_tokens": budgets.get("max_tokens"),
            "max_tries": budgets.get("max_tries"),
        }

    viewer: dict[str, Any] = {
        "article_list": [],
        "num_trials": 1,
        "num_workers": 1,
        "max_steps": max((int(run.get("budgets", {}).get("max_hops") or 20) for run in runs.values()), default=20),
        "agent_settings": agent_settings,
        "runs": [],
        "benchmark_meta": summary["meta"],
    }

    for rid, run in runs.items():
        model_settings = run.get("model_settings") or {}
        model = model_settings.get("model") if isinstance(model_settings, dict) else None
        api_base = model_settings.get("api_base") if isinstance(model_settings, dict) else None
        budgets = run.get("budgets") or {}
        max_hops = budgets.get("max_hops") if isinstance(budgets, dict) else None
        max_links = budgets.get("max_links") if isinstance(budgets, dict) else None
        max_tokens = budgets.get("max_tokens") if isinstance(budgets, dict) else None
        max_tries = budgets.get("max_tries") if isinstance(budgets, dict) else None
        shortest_path_hops = run.get("shortest_path_hops")
        shortest_path_hops = int(shortest_path_hops) if isinstance(shortest_path_hops, int) else None
        hops = int(run.get("hops") or 0)
        hops_gap = (hops - shortest_path_hops) if shortest_path_hops is not None else None

        viewer_steps: list[dict[str, Any]] = []
        for step in steps_by_run.get(rid) or []:
            extra_meta = step.get("meta") if isinstance(step.get("meta"), dict) else {}
            choice = step.get("choice") if isinstance(step.get("choice"), dict) else {}
            usage = step.get("usage") if isinstance(step.get("usage"), dict) else {}
            viewer_steps.append(
                {
                    "type": step.get("step_type"),
                    "article": step.get("article"),
                    "metadata": {
                        **extra_meta,
                        "selected_index": choice.get("selected_index"),
                        "selected_title": step.get("selected_title"),
                        "tries": choice.get("tries"),
                        "attempt_count": step.get("attempt_count"),
                        "answer_errors": choice.get("answer_errors"),
                        "prompt_tokens": usage.get("prompt_tokens"),
                        "completion_tokens": usage.get("completion_tokens"),
                        "total_tokens": usage.get("total_tokens"),
                        "latency_ms": step.get("latency_ms"),
                        "current_article": step.get("current_article"),
                        "links_presented_count": step.get("links_presented_count"),
                        "links_presented_ref": step.get("links_presented_ref"),
                    },
                }
            )

        viewer["runs"].append(
            {
                "model": model or "llm",
                "api_base": api_base,
                "openai_api_mode": model_settings.get("openai_api_mode") if isinstance(model_settings, dict) else None,
                "openai_reasoning_effort": model_settings.get("openai_reasoning_effort")
                if isinstance(model_settings, dict)
                else None,
                "openai_reasoning_summary": model_settings.get("openai_reasoning_summary")
                if isinstance(model_settings, dict)
                else None,
                "anthropic_thinking_budget_tokens": model_settings.get("anthropic_thinking_budget_tokens")
                if isinstance(model_settings, dict)
                else None,
                "google_thinking_config": model_settings.get("google_thinking_config")
                if isinstance(model_settings, dict)
                else None,
                "max_steps": max_hops,
                "max_links": max_links,
                "max_tokens": max_tokens,
                "max_tries": max_tries,
                "result": run.get("result"),
                "start_article": run.get("start"),
                "destination_article": run.get("target"),
                "suite_id": run.get("suite_id"),
                "slice_id": run.get("slice_id"),
                "setup_id": run.get("setup_id"),
                "prompt_version": run.get("prompt_version"),
                "semantics_version": run.get("semantics_version"),
                "shortest_path_hops": shortest_path_hops,
                "hops_gap": hops_gap,
                "steps": [{"type": "start", "article": run.get("start")}] + viewer_steps,
            }
        )

    return summary, viewer


def summarize_benchmark_jsonl(
    *,
    jsonl_path: Path,
    out_summary_path: Optional[Path],
    out_viewer_path: Optional[Path],
    weights: CompositeWeights = CompositeWeights(),
) -> None:
    lines = read_jsonl(jsonl_path)
    summary, viewer = build_summary_and_viewer(lines=lines, source_jsonl=str(jsonl_path), weights=weights)

    if out_summary_path is not None:
        out_summary_path.parent.mkdir(parents=True, exist_ok=True)
        out_summary_path.write_text(json.dumps(summary, indent=2), "utf-8")

    if out_viewer_path is not None:
        out_viewer_path.parent.mkdir(parents=True, exist_ok=True)
        out_viewer_path.write_text(json.dumps(viewer, indent=2), "utf-8")
