from __future__ import annotations

import asyncio
import json
import random
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from llm_client import achat
from parallel_eval.benchmark.prompt import build_llm_prompt, extract_answer
from parallel_eval.benchmark.schema import (
    BenchmarkAttemptRecordV1,
    BenchmarkRunRecordV1,
    BenchmarkStepRecordV1,
    MatchupV1,
    RawOutputMode,
    RunBudgetsV1,
    RunModelSettingsV1,
    RunProvenanceV1,
    TokenTotalsV1,
    write_jsonl_line,
)
from parallel_eval.benchmark.semantics import canonicalize_title, titles_reach_target
from parallel_eval.benchmark.settings import (
    BenchmarkSetup,
    PROMPT_VERSION,
    SEMANTICS_VERSION,
    get_benchmark_setup,
)
from parallel_eval.benchmark.summarize import summarize_benchmark_jsonl
from parallel_eval.benchmark.utils import benchmark_dataset_id, sha256_file, sha256_hex
from parallel_eval.game import SQLiteDB
from tqdm.auto import tqdm


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _git_sha() -> Optional[str]:
    try:
        import subprocess

        result = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, check=False)
        sha = (result.stdout or "").strip()
        return sha if sha else None
    except Exception:
        return None


def _read_dataset(dataset_path: Path) -> list[MatchupV1]:
    matchups: list[MatchupV1] = []
    with open(dataset_path, "r", encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            data = json.loads(raw)
            matchups.append(MatchupV1.model_validate(data))
    return matchups


def _coerce_raw_output_mode(value: str | None) -> RawOutputMode:
    mode = (value or "").strip().lower()
    if mode in {"none", "truncated", "full"}:
        return mode  # type: ignore[return-value]
    return "none"


def _artifact_root_for_records(records_path: Path) -> Path:
    if records_path.name == "records.jsonl":
        return records_path.parent / "blobs"
    return records_path.parent / f"{records_path.stem}.blobs"


def _summary_and_viewer_paths(records_path: Path) -> tuple[Path, Path]:
    if records_path.name == "records.jsonl":
        return records_path.parent / "summary.json", records_path.parent / "viewer.json"
    return Path(str(records_path) + ".summary.json"), Path(str(records_path) + ".viewer.json")


@dataclass
class StoredBlob:
    ref: Optional[str]
    preview: Optional[str] = None


class ArtifactStore:
    def __init__(self, *, records_path: Path, raw_output_mode: RawOutputMode, preview_chars: int):
        self.records_path = records_path
        self.raw_output_mode = raw_output_mode
        self.preview_chars = max(0, preview_chars)
        self.root = _artifact_root_for_records(records_path)

    def _write_blob(self, *, category: str, suffix: str, data: bytes) -> str:
        digest = sha256_hex(data)
        blob_dir = self.root / category
        blob_dir.mkdir(parents=True, exist_ok=True)
        blob_path = blob_dir / f"{digest}{suffix}"
        if not blob_path.exists():
            blob_path.write_bytes(data)
        return str(blob_path.relative_to(self.records_path.parent))

    def store_links(self, links: list[str]) -> Optional[str]:
        payload = json.dumps(links, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        return self._write_blob(category="links", suffix=".json", data=payload)

    def store_raw_output(self, output: str) -> StoredBlob:
        if self.raw_output_mode == "none":
            return StoredBlob(ref=None, preview=None)

        preview = output[: self.preview_chars] if self.preview_chars > 0 else output
        payload_text = output if self.raw_output_mode == "full" else preview
        ref = self._write_blob(category="raw", suffix=".txt", data=payload_text.encode("utf-8"))
        return StoredBlob(ref=ref, preview=preview)


@dataclass
class ChooseLinkResult:
    chosen_index: Optional[int]
    attempt_records: list[BenchmarkAttemptRecordV1]
    attempt_count: int
    prompt_tokens: Optional[int]
    completion_tokens: Optional[int]
    total_tokens: Optional[int]
    latency_ms: Optional[int]
    answer_errors: list[str]
    raw_output_ref: Optional[str]
    raw_output_preview: Optional[str]
    llm_error: Optional[str]
    provider_response_id: Optional[str]


async def _choose_link(
    *,
    run_id: str,
    hop: int,
    prompt_version: str,
    model: str,
    api_base: Optional[str],
    openai_api_mode: Optional[str],
    openai_reasoning_effort: Optional[str],
    openai_reasoning_summary: Optional[str],
    anthropic_thinking_budget_tokens: Optional[int],
    google_thinking_config: Optional[dict[str, Any]],
    current: str,
    target: str,
    path: list[str],
    links: list[str],
    max_tries: int,
    max_tokens: Optional[int],
    artifact_store: ArtifactStore,
    links_presented_ref: Optional[str],
) -> ChooseLinkResult:
    base_prompt = build_llm_prompt(current, target, path, links)
    prompt = base_prompt

    attempt_records: list[BenchmarkAttemptRecordV1] = []
    answer_errors: list[str] = []
    prompt_tokens_sum = 0
    completion_tokens_sum = 0
    total_tokens_sum = 0
    latency_ms_sum = 0
    saw_any_usage = False
    saw_prompt = False
    saw_completion = False

    chosen: Optional[int] = None
    llm_error: Optional[str] = None
    last_output_ref: Optional[str] = None
    last_output_preview: Optional[str] = None
    last_provider_response_id: Optional[str] = None

    for try_num in range(max_tries):
        prompt_hash = sha256_hex(prompt.encode("utf-8"))
        started_at = _now_iso()
        started_monotonic = time.monotonic()

        try:
            result = await achat(
                model=model,
                prompt=prompt,
                max_tokens=max_tokens,
                api_base=api_base,
                openai_api_mode=openai_api_mode,
                openai_reasoning_effort=openai_reasoning_effort,
                openai_reasoning_summary=openai_reasoning_summary,
                anthropic_thinking_budget_tokens=anthropic_thinking_budget_tokens,
                google_thinking_config=google_thinking_config,
            )
        except Exception as exc:
            latency_ms = int((time.monotonic() - started_monotonic) * 1000)
            llm_error = str(exc)
            attempt_records.append(
                BenchmarkAttemptRecordV1(
                    run_id=run_id,
                    hop=hop,
                    try_index=try_num,
                    at=started_at,
                    prompt_version=prompt_version,
                    prompt_hash=prompt_hash,
                    links_presented_count=len(links),
                    links_presented_ref=links_presented_ref,
                    selected_index_parsed=None,
                    selected_title_parsed=None,
                    parse_error=f"llm_error: {llm_error}",
                    latency_ms=latency_ms,
                )
            )
            latency_ms_sum += latency_ms
            break

        latency_ms = int((time.monotonic() - started_monotonic) * 1000)
        latency_ms_sum += latency_ms
        provider_response_id = result.provider_response_id
        if isinstance(provider_response_id, str) and provider_response_id.strip():
            last_provider_response_id = provider_response_id.strip()

        output = result.content
        raw_output = artifact_store.store_raw_output(output)
        last_output_ref = raw_output.ref
        last_output_preview = raw_output.preview

        prompt_tokens: Optional[int] = None
        completion_tokens: Optional[int] = None
        total_tokens: Optional[int] = None
        if result.usage is not None:
            p = result.usage.prompt_tokens
            c = result.usage.completion_tokens
            t = result.usage.total_tokens
            prompt_tokens = p if isinstance(p, int) else None
            completion_tokens = c if isinstance(c, int) else None
            if isinstance(t, int):
                total_tokens = t
            elif prompt_tokens is not None or completion_tokens is not None:
                total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)

            if prompt_tokens is not None:
                prompt_tokens_sum += prompt_tokens
                saw_prompt = True
                saw_any_usage = True
            if completion_tokens is not None:
                completion_tokens_sum += completion_tokens
                saw_completion = True
                saw_any_usage = True
            if total_tokens is not None:
                total_tokens_sum += total_tokens
                saw_any_usage = True

        selected_index, parse_error = extract_answer(output, len(links))
        selected_title = None
        if isinstance(selected_index, int) and 1 <= selected_index <= len(links):
            selected_title = links[selected_index - 1]

        attempt_records.append(
            BenchmarkAttemptRecordV1(
                run_id=run_id,
                hop=hop,
                try_index=try_num,
                at=started_at,
                prompt_version=prompt_version,
                prompt_hash=prompt_hash,
                links_presented_count=len(links),
                links_presented_ref=links_presented_ref,
                selected_index_parsed=selected_index,
                selected_title_parsed=selected_title,
                parse_error=parse_error,
                prompt_tokens=prompt_tokens,
                completion_tokens=completion_tokens,
                total_tokens=total_tokens,
                latency_ms=latency_ms,
                provider_response_id=last_provider_response_id,
                raw_output_ref=raw_output.ref,
            )
        )

        if selected_index is not None:
            chosen = selected_index
            break

        if parse_error:
            answer_errors.append(parse_error)
            prompt = f"{base_prompt}\n\nIMPORTANT: {parse_error}"

    return ChooseLinkResult(
        chosen_index=chosen,
        attempt_records=attempt_records,
        attempt_count=len(attempt_records),
        prompt_tokens=prompt_tokens_sum if saw_prompt else None,
        completion_tokens=completion_tokens_sum if saw_completion else None,
        total_tokens=total_tokens_sum if saw_any_usage else None,
        latency_ms=latency_ms_sum if attempt_records else None,
        answer_errors=answer_errors,
        raw_output_ref=last_output_ref,
        raw_output_preview=last_output_preview,
        llm_error=llm_error,
        provider_response_id=last_provider_response_id,
    )


def _dataset_id_for_run(dataset_path: Path, matchups: list[MatchupV1]) -> str:
    return benchmark_dataset_id(dataset_path, matchups)


def _canonical_setup(
    *,
    setup_id: Optional[str],
    max_hops: int,
    max_links: Optional[int],
    max_tokens: Optional[int],
    max_tries: int,
) -> tuple[Optional[str], int, Optional[int], Optional[int], int, str, str, Optional[BenchmarkSetup]]:
    setup = get_benchmark_setup(setup_id)
    if setup is None:
        return setup_id, max_hops, max_links, max_tokens, max_tries, PROMPT_VERSION, SEMANTICS_VERSION, None

    resolved_max_hops = max_hops if isinstance(max_hops, int) and max_hops > 0 else setup.max_hops
    resolved_max_links = max_links if max_links is not None else setup.max_links
    resolved_max_tokens = max_tokens if max_tokens is not None else setup.max_tokens
    resolved_max_tries = max_tries if isinstance(max_tries, int) and max_tries > 0 else setup.max_tries
    return (
        setup.id,
        resolved_max_hops,
        resolved_max_links,
        resolved_max_tokens,
        resolved_max_tries,
        setup.prompt_version,
        setup.semantics_version,
        setup,
    )


def _serialize_internal_error_run(
    *,
    matchup: MatchupV1,
    dataset_id: str,
    model_settings: RunModelSettingsV1,
    budgets: RunBudgetsV1,
    provenance: RunProvenanceV1,
    prompt_version: str,
    semantics_version: str,
    out_path: Path,
    error: Exception,
) -> None:
    started_at = _now_iso()
    finished_at = _now_iso()
    run_id = f"run_{uuid.uuid4().hex[:16]}"
    score_inputs: dict[str, Any] = {
        "shortest_path_hops": matchup.shortest_path_hops if isinstance(matchup.shortest_path_hops, int) else None,
        "hops_over_shortest": None,
        "primary_time_metric": "llm_latency_ms",
        "secondary_time_metric": "duration_ms",
        "final_reason": "benchmark_error",
    }
    if matchup.path_bucket:
        score_inputs["path_bucket"] = matchup.path_bucket

    write_jsonl_line(
        out_path,
        BenchmarkRunRecordV1(
            run_id=run_id,
            dataset_id=dataset_id,
            matchup_id=matchup.id,
            tier=matchup.tier,
            suite_id=matchup.suite_id,
            slice_id=matchup.slice_id,
            setup_id=matchup.setup_id,
            prompt_version=matchup.prompt_version or prompt_version,
            semantics_version=matchup.semantics_version or semantics_version,
            start=matchup.start,
            target=matchup.target,
            started_at=started_at,
            finished_at=finished_at,
            result="lose",
            hops=0,
            duration_ms=0,
            llm_latency_ms=None,
            model_settings=model_settings,
            budgets=budgets,
            totals=TokenTotalsV1(),
            score_inputs=score_inputs,
            provenance=provenance,
        ),
    )
    write_jsonl_line(
        out_path,
        BenchmarkStepRecordV1(
            run_id=run_id,
            hop=0,
            at=finished_at,
            step_type="lose",
            article=matchup.start,
            current_article=matchup.start,
            current_article_canonical=matchup.start,
            target_canonical=matchup.target,
            meta={"reason": "benchmark_error", "error": str(error)},
        ),
    )


async def _run_one(
    *,
    matchup: MatchupV1,
    db: SQLiteDB,
    dataset_id: str,
    model_settings: RunModelSettingsV1,
    budgets: RunBudgetsV1,
    provenance: RunProvenanceV1,
    benchmark_setup: Optional[BenchmarkSetup],
    prompt_version: str,
    semantics_version: str,
    raw_output_mode: RawOutputMode,
    llm_output_max_chars: int,
    out_path: Path,
) -> None:
    run_id = f"run_{uuid.uuid4().hex[:16]}"
    started_at = _now_iso()
    artifact_store = ArtifactStore(records_path=out_path, raw_output_mode=raw_output_mode, preview_chars=llm_output_max_chars)

    current = matchup.start
    current_canonical = canonicalize_title(db, current)
    path = [current_canonical]
    target_canonical = canonicalize_title(db, matchup.target)

    totals_prompt = 0
    totals_completion = 0
    totals_total = 0
    saw_prompt = False
    saw_completion = False
    saw_total = False
    llm_latency_ms = 0
    saw_latency = False

    hop = 0
    result: str = "lose"
    finished_at = started_at
    final_reason: Optional[str] = None

    while hop < budgets.max_hops:
        if titles_reach_target(db, current, matchup.target):
            result = "win"
            break

        hop += 1

        _, links = db.get_article_with_links(current)
        if budgets.max_links is not None:
            links = links[: budgets.max_links]
        links_presented_ref = artifact_store.store_links(links) if links else None

        if not links:
            finished_at = _now_iso()
            final_reason = "no_links"
            write_jsonl_line(
                out_path,
                BenchmarkStepRecordV1(
                    run_id=run_id,
                    hop=hop,
                    at=finished_at,
                    step_type="lose",
                    article=current,
                    current_article=current,
                    attempt_count=0,
                    links_presented_count=0,
                    links_presented_ref=links_presented_ref,
                    current_article_canonical=current_canonical,
                    target_canonical=target_canonical,
                    meta={"reason": final_reason},
                ),
            )
            break

        try:
            choice = await _choose_link(
                run_id=run_id,
                hop=hop,
                prompt_version=prompt_version,
                model=model_settings.model,
                api_base=model_settings.api_base,
                openai_api_mode=model_settings.openai_api_mode,
                openai_reasoning_effort=model_settings.openai_reasoning_effort,
                openai_reasoning_summary=model_settings.openai_reasoning_summary,
                anthropic_thinking_budget_tokens=model_settings.anthropic_thinking_budget_tokens,
                google_thinking_config=model_settings.google_thinking_config,
                current=current,
                target=matchup.target,
                path=path,
                links=links,
                max_tries=budgets.max_tries,
                max_tokens=budgets.max_tokens,
                artifact_store=artifact_store,
                links_presented_ref=links_presented_ref,
            )
        except Exception as exc:
            choice = ChooseLinkResult(
                chosen_index=None,
                attempt_records=[],
                attempt_count=0,
                prompt_tokens=None,
                completion_tokens=None,
                total_tokens=None,
                latency_ms=None,
                answer_errors=[],
                raw_output_ref=None,
                raw_output_preview=None,
                llm_error=str(exc),
                provider_response_id=None,
            )

        for attempt_record in choice.attempt_records:
            write_jsonl_line(out_path, attempt_record)

        if isinstance(choice.prompt_tokens, int):
            totals_prompt += choice.prompt_tokens
            saw_prompt = True
        if isinstance(choice.completion_tokens, int):
            totals_completion += choice.completion_tokens
            saw_completion = True
        if isinstance(choice.total_tokens, int):
            totals_total += choice.total_tokens
            saw_total = True
        if isinstance(choice.latency_ms, int):
            llm_latency_ms += choice.latency_ms
            saw_latency = True

        if choice.llm_error:
            finished_at = _now_iso()
            final_reason = "llm_error"
            write_jsonl_line(
                out_path,
                BenchmarkStepRecordV1(
                    run_id=run_id,
                    hop=hop,
                    at=finished_at,
                    step_type="lose",
                    article=current,
                    current_article=current,
                    attempt_count=choice.attempt_count,
                    links_presented_count=len(links),
                    links_presented_ref=links_presented_ref,
                    current_article_canonical=current_canonical,
                    target_canonical=target_canonical,
                    choice={
                        "selected_index": None,
                        "tries": max(0, choice.attempt_count - 1),
                        "answer_errors": choice.answer_errors,
                    },
                    usage={
                        "prompt_tokens": choice.prompt_tokens,
                        "completion_tokens": choice.completion_tokens,
                        "total_tokens": choice.total_tokens,
                    },
                    latency_ms=choice.latency_ms,
                    meta={
                        "reason": final_reason,
                        "error": choice.llm_error,
                        **({"raw_output_ref": choice.raw_output_ref} if choice.raw_output_ref else {}),
                        **({"llm_output_preview": choice.raw_output_preview} if choice.raw_output_preview else {}),
                    },
                ),
            )
            break

        if choice.chosen_index is None or choice.chosen_index < 1 or choice.chosen_index > len(links):
            finished_at = _now_iso()
            final_reason = "bad_answer"
            write_jsonl_line(
                out_path,
                BenchmarkStepRecordV1(
                    run_id=run_id,
                    hop=hop,
                    at=finished_at,
                    step_type="lose",
                    article=current,
                    current_article=current,
                    attempt_count=choice.attempt_count,
                    links_presented_count=len(links),
                    links_presented_ref=links_presented_ref,
                    current_article_canonical=current_canonical,
                    target_canonical=target_canonical,
                    choice={
                        "selected_index": None,
                        "tries": max(0, choice.attempt_count - 1),
                        "answer_errors": choice.answer_errors,
                    },
                    usage={
                        "prompt_tokens": choice.prompt_tokens,
                        "completion_tokens": choice.completion_tokens,
                        "total_tokens": choice.total_tokens,
                    },
                    latency_ms=choice.latency_ms,
                    meta={
                        "reason": final_reason,
                        **({"raw_output_ref": choice.raw_output_ref} if choice.raw_output_ref else {}),
                        **({"llm_output_preview": choice.raw_output_preview} if choice.raw_output_preview else {}),
                    },
                ),
            )
            break

        selected = links[choice.chosen_index - 1]
        selected_canonical = canonicalize_title(db, selected)

        finished_at = _now_iso()
        step_type: str
        step_article: str
        reason: Optional[str] = None

        if titles_reach_target(db, selected, matchup.target):
            step_type = "win"
            step_article = matchup.target
            result = "win"
        elif hop >= budgets.max_hops:
            step_type = "lose"
            step_article = selected_canonical
            reason = "max_steps"
            final_reason = reason
            result = "lose"
        else:
            step_type = "move"
            step_article = selected_canonical

        write_jsonl_line(
            out_path,
            BenchmarkStepRecordV1(
                run_id=run_id,
                hop=hop,
                at=finished_at,
                step_type=step_type,  # type: ignore[arg-type]
                article=step_article,
                current_article=current,
                selected_title=selected,
                attempt_count=choice.attempt_count,
                links_presented_count=len(links),
                links_presented_ref=links_presented_ref,
                current_article_canonical=current_canonical,
                selected_title_canonical=selected_canonical,
                target_canonical=target_canonical,
                choice={
                    "selected_index": choice.chosen_index,
                    "tries": max(0, choice.attempt_count - 1),
                    "answer_errors": choice.answer_errors,
                },
                usage={
                    "prompt_tokens": choice.prompt_tokens,
                    "completion_tokens": choice.completion_tokens,
                    "total_tokens": choice.total_tokens,
                },
                latency_ms=choice.latency_ms,
                meta={
                    **({"reason": reason} if reason else {}),
                    **({"raw_output_ref": choice.raw_output_ref} if choice.raw_output_ref else {}),
                    **({"llm_output_preview": choice.raw_output_preview} if choice.raw_output_preview else {}),
                },
            ),
        )

        if step_type in ("win", "lose"):
            break

        current = selected_canonical
        current_canonical = selected_canonical
        path.append(current_canonical)

    finished_at = finished_at or _now_iso()
    duration_ms = None
    try:
        start_dt = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        end_dt = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
        duration_ms = max(0, int((end_dt - start_dt).total_seconds() * 1000))
    except Exception:
        duration_ms = None

    shortest_path_hops = matchup.shortest_path_hops if isinstance(matchup.shortest_path_hops, int) else None
    score_inputs: dict[str, Any] = {
        "shortest_path_hops": shortest_path_hops,
        "hops_over_shortest": hop - shortest_path_hops if shortest_path_hops is not None else None,
        "primary_time_metric": (benchmark_setup.primary_time_metric if benchmark_setup else "llm_latency_ms"),
        "secondary_time_metric": (benchmark_setup.secondary_time_metric if benchmark_setup else "duration_ms"),
        "final_reason": final_reason,
    }
    if matchup.path_bucket:
        score_inputs["path_bucket"] = matchup.path_bucket

    totals = TokenTotalsV1(
        prompt_tokens=totals_prompt if saw_prompt else None,
        completion_tokens=totals_completion if saw_completion else None,
        total_tokens=totals_total if saw_total else None,
    )

    run_record = BenchmarkRunRecordV1(
        run_id=run_id,
        dataset_id=dataset_id,
        matchup_id=matchup.id,
        tier=matchup.tier,
        suite_id=matchup.suite_id,
        slice_id=matchup.slice_id,
        setup_id=matchup.setup_id,
        prompt_version=matchup.prompt_version or prompt_version,
        semantics_version=matchup.semantics_version or semantics_version,
        start=matchup.start,
        target=matchup.target,
        shortest_path_hops=matchup.shortest_path_hops,
        started_at=started_at,
        finished_at=finished_at,
        result=result,  # type: ignore[arg-type]
        hops=hop,
        duration_ms=duration_ms,
        llm_latency_ms=llm_latency_ms if saw_latency else None,
        model_settings=model_settings,
        budgets=budgets,
        totals=totals,
        score_inputs=score_inputs,
        provenance=provenance,
    )
    write_jsonl_line(out_path, run_record)


def run_benchmark_dataset(
    *,
    dataset_path: Path,
    db_path: Path,
    out_path: Path,
    model: str,
    api_base: Optional[str],
    openai_api_mode: Optional[str],
    openai_reasoning_effort: Optional[str],
    openai_reasoning_summary: Optional[str],
    anthropic_thinking_budget_tokens: Optional[int],
    google_thinking_config: Optional[dict[str, Any]],
    max_hops: int,
    max_links: Optional[int],
    max_tokens: Optional[int],
    max_tries: int,
    concurrency: int,
    seed: int,
    raw_output_mode: RawOutputMode | str = "none",
    llm_output_max_chars: int = 4000,
    write_viewer_json: bool = True,
    write_summary_json: bool = True,
    overwrite: bool = False,
    setup_id: Optional[str] = None,
    slice_id: Optional[str] = None,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    if out_path.exists() and not overwrite:
        raise FileExistsError(f"Output already exists: {out_path} (use --overwrite or pick a new path)")
    out_path.write_text("", "utf-8")

    matchups = _read_dataset(dataset_path)
    if slice_id:
        matchups = [matchup for matchup in matchups if matchup.slice_id == slice_id]
    if not matchups:
        raise ValueError(f"No matchups found in {dataset_path} for slice_id={slice_id!r}")
    dataset_id = _dataset_id_for_run(dataset_path, matchups)

    first_matchup = matchups[0] if matchups else None
    resolved_setup_id, resolved_max_hops, resolved_max_links, resolved_max_tokens, resolved_max_tries, prompt_version, semantics_version, benchmark_setup = _canonical_setup(
        setup_id=setup_id or (first_matchup.setup_id if first_matchup else None),
        max_hops=max_hops,
        max_links=max_links,
        max_tokens=max_tokens,
        max_tries=max_tries,
    )

    model_settings = RunModelSettingsV1(
        model=model,
        run_kind="llm",
        api_base=api_base,
        openai_api_mode=openai_api_mode,
        openai_reasoning_effort=openai_reasoning_effort,
        openai_reasoning_summary=openai_reasoning_summary,
        anthropic_thinking_budget_tokens=anthropic_thinking_budget_tokens,
        google_thinking_config=google_thinking_config,
    )
    budgets = RunBudgetsV1(
        max_hops=resolved_max_hops,
        max_links=resolved_max_links,
        max_tokens=resolved_max_tokens,
        max_tries=resolved_max_tries,
    )

    raw_output_mode = _coerce_raw_output_mode(raw_output_mode if isinstance(raw_output_mode, str) else None)
    provenance = RunProvenanceV1(
        git_sha=_git_sha(),
        db_path=str(db_path),
        db_sha256=sha256_file(db_path),
        concurrency=concurrency,
        seed=seed,
        raw_output_mode=raw_output_mode,
    )

    rng = random.Random(seed)
    matchups = matchups[:]
    rng.shuffle(matchups)

    db = SQLiteDB(str(db_path))

    failed_matchups: list[tuple[str, Exception]] = []
    progress_lock = asyncio.Lock()
    succeeded = 0
    failed = 0

    async def worker(queue: asyncio.Queue[MatchupV1], progress: tqdm):
        nonlocal succeeded, failed
        while True:
            matchup = await queue.get()
            try:
                enriched_matchup = matchup.model_copy(
                    update={
                        "setup_id": matchup.setup_id or resolved_setup_id,
                        "prompt_version": matchup.prompt_version or prompt_version,
                        "semantics_version": matchup.semantics_version or semantics_version,
                    }
                )
                await _run_one(
                    matchup=enriched_matchup,
                    db=db,
                    dataset_id=dataset_id,
                    model_settings=model_settings,
                    budgets=budgets,
                    provenance=provenance,
                    benchmark_setup=benchmark_setup,
                    prompt_version=prompt_version,
                    semantics_version=semantics_version,
                    raw_output_mode=raw_output_mode,
                    llm_output_max_chars=llm_output_max_chars,
                    out_path=out_path,
                )
                async with progress_lock:
                    succeeded += 1
            except Exception as exc:
                async with progress_lock:
                    failed += 1
                    failed_matchups.append((matchup.id, exc))
                try:
                    _serialize_internal_error_run(
                        matchup=matchup,
                        dataset_id=dataset_id,
                        model_settings=model_settings,
                        budgets=budgets,
                        provenance=provenance,
                        prompt_version=prompt_version,
                        semantics_version=semantics_version,
                        out_path=out_path,
                        error=exc,
                    )
                except Exception:
                    pass
            finally:
                async with progress_lock:
                    progress.update(1)
                    progress.set_postfix({"ok": succeeded, "fail": failed}, refresh=True)
                queue.task_done()

    async def run_all():
        q: asyncio.Queue[MatchupV1] = asyncio.Queue()
        for matchup in matchups:
            q.put_nowait(matchup)
        progress = tqdm(total=len(matchups), desc="Benchmark", unit="matchup", dynamic_ncols=True)
        progress.set_postfix({"ok": 0, "fail": 0}, refresh=True)
        tasks = [asyncio.create_task(worker(q, progress)) for _ in range(max(1, concurrency))]
        try:
            await q.join()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            progress.close()

    asyncio.run(run_all())

    if write_summary_json or write_viewer_json:
        out_summary_path, out_viewer_path = _summary_and_viewer_paths(out_path)
        summarize_benchmark_jsonl(
            jsonl_path=out_path,
            out_summary_path=out_summary_path if write_summary_json else None,
            out_viewer_path=out_viewer_path if write_viewer_json else None,
        )
