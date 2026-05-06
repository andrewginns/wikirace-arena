from pathlib import Path

try:
    from parallel_eval.benchmark.semantics import hop_rows_from_steps
    from parallel_eval.game import AgentPlayer, SQLiteDB, Game
except ModuleNotFoundError:
    from benchmark.semantics import hop_rows_from_steps
    from game import AgentPlayer, SQLiteDB, Game
from logfire_compat import logfire
import os
import json
import asyncio
import argparse
import tempfile
import hashlib

from llm_client import configure_observability, run_span_name


SCRIPT_DIR = Path(__file__).resolve().parent


def _resolve_local_path(path: str) -> str:
    p = Path(path)
    if p.is_absolute():
        return str(p)
    return str((SCRIPT_DIR / p).resolve())


def _db_identity(db_path: str) -> dict[str, object]:
    resolved_path = Path(db_path).resolve()
    try:
        stat = resolved_path.stat()
    except OSError:
        return {
            "path": str(resolved_path),
            "exists": False,
        }

    return {
        "path": str(resolved_path),
        "exists": True,
        "size_bytes": stat.st_size,
        "mtime_ns": stat.st_mtime_ns,
    }


def _build_run_config(
    *,
    agent_settings: dict,
    max_steps: int,
    db_path: str,
) -> dict[str, object]:
    return {
        "model": agent_settings.get("model"),
        "api_base": agent_settings.get("api_base"),
        "max_steps": max_steps,
        "max_links": agent_settings.get("max_links"),
        "max_tries": agent_settings.get("max_tries"),
        "openai_api_mode": agent_settings.get("openai_api_mode"),
        "openai_reasoning_effort": agent_settings.get("openai_reasoning_effort"),
        "openai_reasoning_summary": agent_settings.get("openai_reasoning_summary"),
        "anthropic_thinking_budget_tokens": agent_settings.get("anthropic_thinking_budget_tokens"),
        "google_thinking_config": agent_settings.get("google_thinking_config"),
        "db": _db_identity(db_path),
    }


def _run_config_hash(run_config: dict[str, object]) -> str:
    payload = json.dumps(run_config, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _run_output_is_valid(
    output: object,
    *,
    start_article: str,
    destination_article: str,
    run_config_hash: str,
) -> bool:
    if not isinstance(output, dict):
        return False

    steps = output.get("steps")
    if not isinstance(steps, list) or not steps:
        return False
    if not all(isinstance(step, dict) for step in steps):
        return False

    result = output.get("result")
    if result not in ("win", "lose"):
        return False

    if output.get("run_config_hash") != run_config_hash:
        return False

    return (
        output.get("start_article") == start_article
        and output.get("destination_article") == destination_article
        and steps[-1].get("type") == result
    )


def _existing_run_output_is_valid(
    output_file: str,
    *,
    start_article: str,
    destination_article: str,
    run_config_hash: str,
) -> bool:
    try:
        with open(output_file, "r", encoding="utf-8") as f:
            output = json.load(f)
    except (OSError, json.JSONDecodeError):
        return False

    return _run_output_is_valid(
        output,
        start_article=start_article,
        destination_article=destination_article,
        run_config_hash=run_config_hash,
    )


def _write_json_atomic(output_file: str, output: object) -> None:
    output_path = Path(output_file)
    fd, temp_path = tempfile.mkstemp(
        prefix=f".{output_path.name}.",
        suffix=".tmp",
        dir=output_path.parent,
        text=True,
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(output, f, indent=4)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temp_path, output_path)
    except Exception:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


class Proctor:
    def __init__(
        self,
        article_list: list[tuple[str, str]],
        num_trials: int,
        num_workers: int,
        max_steps: int,
        agent_settings: dict,
        db_path: str,
        verbose: bool = True,
        output_dir: str = "./proctor_tmp",
        proctor_id: str = "proctor_1",
    ):
        self.article_list = article_list
        self.num_trials = num_trials
        self.num_workers = num_workers
        self.max_steps = max_steps
        self.agent_settings = agent_settings
        self.db_path = db_path
        self.verbose = verbose
        self.output_dir = output_dir
        self.proctor_id = proctor_id
        self.db = SQLiteDB(self.db_path)
        self.run_config = _build_run_config(
            agent_settings=self.agent_settings,
            max_steps=self.max_steps,
            db_path=self.db_path,
        )
        self.run_config_hash = _run_config_hash(self.run_config)

        os.makedirs(self.output_dir, exist_ok=True)

        self.runs = []

        self.setup_runs()

    def setup_runs(self):
        for start in self.article_list:
            for destination in self.article_list:
                if start == destination:
                    continue
                for n in range(self.num_trials):
                    run_id = f"{self.proctor_id}_{start}_{destination}_{n}"
                    self.runs.append(
                        Run(
                            start,
                            destination,
                            self.max_steps,
                            self.agent_settings,
                            self.db,
                            self.output_dir,
                            self.verbose,
                            run_id,
                            self.run_config,
                            self.run_config_hash,
                        )
                    )
                    print(f"Setup run {run_id}")

    async def run(self):
        if not self.runs:
            self.analyze_runs()
            return

        worker_count = min(max(1, self.num_workers), len(self.runs))
        queue: asyncio.Queue[Run] = asyncio.Queue()
        for run_instance in self.runs:
            queue.put_nowait(run_instance)

        async def worker():
            while True:
                try:
                    run_instance = queue.get_nowait()
                except asyncio.QueueEmpty:
                    return

                if self.verbose:
                    print(f"Starting run {run_instance.id}")
                try:
                    await run_instance.run()
                finally:
                    if self.verbose:
                        print(f"Finished run {run_instance.id}")
                    queue.task_done()

        tasks = [asyncio.create_task(worker()) for _ in range(worker_count)]
        await asyncio.gather(*tasks)

        self.analyze_runs()

    def analyze_runs(self):
        """We need to analze all the runs into a .json"""
        final_results = {
            "article_list": self.article_list,
            "num_trials": self.num_trials,
            "num_workers": self.num_workers,
            "max_steps": self.max_steps,
            "agent_settings": self.agent_settings,
            "runs": [],
        }

        win_count = 0
        lose_count = 0
        hops_distribution = []

        for run in self.runs:
            with open(run.output_file, "r") as f:
                result = json.load(f)
                final_results["runs"].append(result)
                if result["result"] == "win":
                    win_count += 1
                    _, hops = hop_rows_from_steps(
                        result.get("steps", []),
                        result.get("start_article", run.start_article),
                    )
                    hops_distribution.append(hops)
                else:
                    lose_count += 1

        run_count = len(self.runs)
        final_results["hops_distribution"] = hops_distribution
        final_results["average_hops"] = (
            sum(hops_distribution) / len(hops_distribution) if hops_distribution else None
        )
        final_results["win_rate"] = win_count / run_count if run_count else 0.0
        final_results["lose_rate"] = lose_count / run_count if run_count else 0.0

        with open(f"{self.output_dir}/{self.proctor_id}-final-results.json", "w") as f:
            json.dump(final_results, f, indent=4)


class Run:
    def __init__(
        self,
        start_article: str,
        destination_article: str,
        max_steps: int,
        agent_settings: dict,
        db: SQLiteDB,
        output_dir: str,
        verbose: bool,
        id: str,
        run_config: dict[str, object],
        run_config_hash: str,
    ):
        self.start_article = start_article
        self.destination_article = destination_article
        self.max_steps = max_steps
        self.agent_settings = agent_settings
        self.db = db
        self.output_dir = output_dir
        self.verbose = verbose
        self.id = id
        self.run_config = run_config
        self.run_config_hash = run_config_hash

        self.output_file = f"{self.output_dir}/run_{self.id}.json"

    async def run(self):
        if _existing_run_output_is_valid(
            self.output_file,
            start_article=self.start_article,
            destination_article=self.destination_article,
            run_config_hash=self.run_config_hash,
        ):
            return

        configure_observability()

        model = self.agent_settings.get("model")
        model = model.strip() if isinstance(model, str) else ""
        openai_reasoning_effort = self.agent_settings.get("openai_reasoning_effort")
        openai_reasoning_effort = (
            openai_reasoning_effort
            if isinstance(openai_reasoning_effort, str) and openai_reasoning_effort.strip()
            else None
        )

        provider_tag = model.split(":", 1)[0] if ":" in model else None
        tags = ["wikirace", "attempt", "proctor"]
        if provider_tag:
            tags.append(provider_tag)

        span_name = run_span_name(model=model or "unknown", openai_reasoning_effort=openai_reasoning_effort)

        with logfire.span(
            span_name,
            _span_name=span_name,
            _tags=tags,
            run_id=self.id,
            start_article=self.start_article,
            destination_article=self.destination_article,
            model=model or None,
            api_base=self.agent_settings.get("api_base"),
            max_links=self.agent_settings.get("max_links"),
            max_tries=self.agent_settings.get("max_tries"),
            max_steps=self.max_steps,
            openai_reasoning_effort=openai_reasoning_effort,
        ):

            player = AgentPlayer(
                model=self.agent_settings["model"],
                api_base=self.agent_settings["api_base"],
                max_links=self.agent_settings["max_links"],
                max_tries=self.agent_settings["max_tries"],
                verbose=False,
                openai_api_mode=self.agent_settings.get("openai_api_mode"),
                openai_reasoning_effort=self.agent_settings.get("openai_reasoning_effort"),
                openai_reasoning_summary=self.agent_settings.get("openai_reasoning_summary"),
                anthropic_thinking_budget_tokens=self.agent_settings.get(
                    "anthropic_thinking_budget_tokens"
                ),
                google_thinking_config=self.agent_settings.get("google_thinking_config"),
            )

            game = Game(
                self.start_article,
                self.destination_article,
                self.db,
                self.max_steps,
                player,
                verbose=False,
            )

            steps = await game.run()

            output = {
                "model": self.agent_settings["model"],
                "api_base": self.agent_settings["api_base"],
                "max_links": self.agent_settings["max_links"],
                "max_tries": self.agent_settings["max_tries"],
                "max_steps": self.max_steps,
                "openai_api_mode": self.agent_settings.get("openai_api_mode"),
                "openai_reasoning_effort": self.agent_settings.get("openai_reasoning_effort"),
                "openai_reasoning_summary": self.agent_settings.get("openai_reasoning_summary"),
                "anthropic_thinking_budget_tokens": self.agent_settings.get(
                    "anthropic_thinking_budget_tokens"
                ),
                "google_thinking_config": self.agent_settings.get("google_thinking_config"),
                "run_config": self.run_config,
                "run_config_hash": self.run_config_hash,
                "start_article": self.start_article,
                "destination_article": self.destination_article,
                "steps": steps,
                "result": steps[-1]["type"],
            }

            _write_json_atomic(self.output_file, output)

            print(f"Run {self.id} completed in {len(steps)} steps")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run parallel Wikispeedia evaluations")
    parser.add_argument(
        "--model",
        type=str,
        default="openai-responses:gpt-5-mini",
        help="PydanticAI model id to use for agent",
    )
    parser.add_argument("--api-base", type=str, default=None, help="API base URL for hosted models")
    parser.add_argument(
        "--openai-api-mode",
        type=str,
        default=None,
        help="When --api-base is set: 'chat' (default) or 'responses'",
    )
    parser.add_argument(
        "--openai-reasoning-effort",
        type=str,
        default=None,
        help="OpenAI reasoning effort: low / medium / high / xhigh",
    )
    parser.add_argument("--workers", type=int, default=20, help="Number of parallel workers")
    parser.add_argument("--trials", type=int, default=1, help="Number of trials per start-destination pair")
    parser.add_argument("--max-steps", type=int, default=20, help="Maximum steps per game")
    parser.add_argument("--max-links", type=int, default=200, help="Maximum links per page for agent")
    parser.add_argument("--max-tries", type=int, default=3, help="Maximum retries for agent")
    parser.add_argument("--db-path", type=str, default="wikihop.db", help="Path to the wikihop database")
    parser.add_argument("--output-dir", type=str, default="./proctor_tmp", help="Directory for output files")
    parser.add_argument("--proctor-id", type=str, default="proctor_1", help="Unique identifier for this proctor run")
    parser.add_argument("--verbose", action="store_true", help="Enable verbose output")
    parser.add_argument("--article-list", type=str, default="supernodes.json", 
                        help="Path to JSON file with list of articles to test")

    args = parser.parse_args()

    # Resolve default relative paths relative to this folder so the script can be
    # run from anywhere (repo root, a CI runner, etc.).
    args.db_path = _resolve_local_path(args.db_path)
    args.article_list = _resolve_local_path(args.article_list)
    args.output_dir = _resolve_local_path(args.output_dir)

    # check if db exists
    if not os.path.exists(args.db_path):
        raise FileNotFoundError(f"Database file not found at {args.db_path}")
    
    # check if article list exists
    if not os.path.exists(args.article_list):
        raise FileNotFoundError(f"Article list file not found at {args.article_list}")

    # Read article list from file
    with open(args.article_list, "r") as f:
        article_list = json.load(f)

    agent_settings = {
        "model": args.model,
        "api_base": args.api_base,
        "max_links": args.max_links,
        "max_tries": args.max_tries,
        "openai_api_mode": args.openai_api_mode,
        "openai_reasoning_effort": args.openai_reasoning_effort,
    }

    proctor = Proctor(
        article_list=article_list,
        num_trials=args.trials,
        num_workers=args.workers,
        max_steps=args.max_steps,
        agent_settings=agent_settings,
        db_path=args.db_path,
        verbose=args.verbose,
        output_dir=args.output_dir,
        proctor_id=args.proctor_id,
    )

    asyncio.run(proctor.run())
