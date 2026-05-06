from typing import List, Tuple, Dict, Optional
import sqlite3
import json
import asyncio
import argparse
import time
from functools import lru_cache
from pathlib import Path
from urllib.parse import quote

from llm_client import achat
from parallel_eval.benchmark.prompt import build_llm_prompt, extract_answer
class SQLiteDB:
    def __init__(self, db_path: str):
        """Initialize the database with path to SQLite database"""
        self.db_path = db_path
        resolved_path = Path(db_path).resolve()
        db_uri = f"file:{quote(str(resolved_path))}?mode=ro&immutable=1"
        self.conn = sqlite3.connect(db_uri, uri=True)
        self.conn.row_factory = sqlite3.Row
        self.cursor = self.conn.cursor()
        self._article_count = self._get_article_count()
        print(f"Connected to SQLite database with {self._article_count} articles")

    def _get_article_count(self):
        self.cursor.execute("SELECT COUNT(*) FROM core_articles")
        return self.cursor.fetchone()[0]

    @lru_cache(maxsize=8192)
    def get_article_with_links(self, article_title: str) -> Tuple[str, List[str]]:
        self.cursor.execute(
            "SELECT title, links_json FROM core_articles WHERE title = ?",
            (article_title,),
        )
        article = self.cursor.fetchone()
        if not article:
            return None, []

        links = json.loads(article["links_json"])
        return article["title"], links

    def resolve_title(self, article_title: str) -> Optional[str]:
        if not article_title:
            return None

        title = article_title.replace("_", " ").strip()
        if not title:
            return None

        return self._resolve_title_normalized(title)

    @lru_cache(maxsize=32768)
    def _resolve_title_normalized(self, title: str) -> Optional[str]:
        self.cursor.execute(
            "SELECT title FROM core_articles WHERE title = ? LIMIT 1",
            (title,),
        )
        row = self.cursor.fetchone()
        if row:
            return row[0]

        self.cursor.execute(
            "SELECT title FROM core_articles WHERE title = ? COLLATE NOCASE LIMIT 1",
            (title,),
        )
        row = self.cursor.fetchone()
        if row:
            return row[0]

        return None

    @lru_cache(maxsize=16384)
    def canonical_title(self, article_title: str) -> Optional[str]:
        resolved = self.resolve_title(article_title)
        if not resolved:
            return None

        current = resolved
        seen = {current}

        for _ in range(6):
            title, links = self.get_article_with_links(current)
            if not title:
                break
            if len(links) != 1:
                break

            candidate = self.resolve_title(links[0])
            if not candidate or candidate in seen:
                break
            seen.add(candidate)
            current = candidate

        return current


class Player:
    def __init__(self, name: str):
        self.name = name

    async def get_move(self, game_state: List[Dict]) -> Tuple[str, Dict]:
        print("Link choices:")
        for i, link in enumerate(game_state[-1]["links"]):
            print(f"{i}: {link}")

        idx = int(input("Enter the index of the link you want to select: "))
        return game_state[-1]["links"][idx], {
            "message": f"{self.name} selected link #{i}"
        }  # select the first link


class AgentPlayer(Player):
    def __init__(
        self,
        model: str,
        api_base: Optional[str],
        verbose: bool = True,
        max_links=None,
        max_tries=10,
        target_article = None,
        openai_api_mode: Optional[str] = None,
        openai_reasoning_effort: Optional[str] = None,
        openai_reasoning_summary: Optional[str] = None,
        anthropic_thinking_budget_tokens: Optional[int] = None,
        google_thinking_config: Optional[dict[str, object]] = None,
    ):
        super().__init__(model)
        self.model = model
        self.api_base = api_base
        self.verbose = verbose
        self.max_links = max_links
        self.max_tries = max_tries
        self.target_article = target_article
        self.openai_api_mode = openai_api_mode
        self.openai_reasoning_effort = openai_reasoning_effort
        self.openai_reasoning_summary = openai_reasoning_summary
        self.anthropic_thinking_budget_tokens = anthropic_thinking_budget_tokens
        self.google_thinking_config = google_thinking_config

    async def get_move(self, game_state: List[Dict]) -> Tuple[str, Dict]:
        current = game_state[-1]["article"]
        target = self.target_article
        all_links = game_state[-1]["links"]
        links = all_links
        if isinstance(self.max_links, int) and self.max_links > 0:
            links = all_links[: self.max_links]

        path_so_far = [step["article"] for step in game_state]
        base_prompt = build_llm_prompt(current, target, path_so_far, links)
        prompt = base_prompt

        llm_outputs: list[str] = []
        answer_errors: list[str] = []

        prompt_tokens_sum = 0
        completion_tokens_sum = 0
        total_tokens_sum = 0
        saw_prompt_tokens = False
        saw_completion_tokens = False
        saw_any_usage = False
        latency_ms_sum = 0

        chosen_index: Optional[int] = None
        used_try: Optional[int] = None

        for try_number in range(self.max_tries):
            started = time.monotonic()
            result = await achat(
                model=self.model,
                prompt=prompt,
                api_base=self.api_base,
                openai_api_mode=self.openai_api_mode,
                openai_reasoning_effort=self.openai_reasoning_effort,
                openai_reasoning_summary=self.openai_reasoning_summary,
                anthropic_thinking_budget_tokens=self.anthropic_thinking_budget_tokens,
                google_thinking_config=self.google_thinking_config,
            )
            latency_ms_sum += int((time.monotonic() - started) * 1000)

            response_text = result.content
            llm_outputs.append(response_text)

            if result.usage is not None:
                prompt_tokens = result.usage.prompt_tokens
                completion_tokens = result.usage.completion_tokens
                total_tokens = result.usage.total_tokens

                if isinstance(prompt_tokens, int):
                    prompt_tokens_sum += prompt_tokens
                    saw_prompt_tokens = True
                    saw_any_usage = True
                if isinstance(completion_tokens, int):
                    completion_tokens_sum += completion_tokens
                    saw_completion_tokens = True
                    saw_any_usage = True

                if isinstance(total_tokens, int):
                    total_tokens_sum += total_tokens
                    saw_any_usage = True
                elif isinstance(prompt_tokens, int) or isinstance(completion_tokens, int):
                    total_tokens_sum += (
                        (prompt_tokens if isinstance(prompt_tokens, int) else 0)
                        + (completion_tokens if isinstance(completion_tokens, int) else 0)
                    )
                    saw_any_usage = True

            answer, error = extract_answer(response_text, len(links))
            if answer is not None:
                chosen_index = answer
                used_try = try_number
                break

            if error:
                answer_errors.append(error)
                prompt = f"{base_prompt}\n\nIMPORTANT: {error}"

        if chosen_index is None:
            metadata: Dict[str, object] = {
                "tries": self.max_tries,
                "answer_errors": answer_errors,
                "llm_output": llm_outputs[-1] if llm_outputs else None,
                "latency_ms": latency_ms_sum,
            }
            if len(llm_outputs) > 1:
                metadata["llm_outputs"] = llm_outputs
            if saw_any_usage:
                if saw_prompt_tokens:
                    metadata["prompt_tokens"] = prompt_tokens_sum
                if saw_completion_tokens:
                    metadata["completion_tokens"] = completion_tokens_sum
                metadata["total_tokens"] = total_tokens_sum
            return -1, metadata

        metadata: Dict[str, object] = {
            "tries": used_try or 0,
            "llm_output": llm_outputs[-1] if llm_outputs else None,
            "latency_ms": latency_ms_sum,
        }
        if len(llm_outputs) > 1:
            metadata["llm_outputs"] = llm_outputs
        if saw_any_usage:
            if saw_prompt_tokens:
                metadata["prompt_tokens"] = prompt_tokens_sum
            if saw_completion_tokens:
                metadata["completion_tokens"] = completion_tokens_sum
            metadata["total_tokens"] = total_tokens_sum

        return links[chosen_index - 1], metadata

class Game:
    def __init__(
        self,
        start_article: str,
        target_article: str,
        db: SQLiteDB,
        max_allowed_steps: int,
        player: Player,
        verbose: bool = True,
    ):
        self.start_article = start_article
        self.target_article = target_article
        self.db = db
        self.max_allowed_steps = max_allowed_steps
        self.steps = []
        self.steps_taken = 0
        self.player = player
        self.verbose = verbose
        # Ensure the player knows the target article
        if isinstance(self.player, AgentPlayer):
            self.player.target_article = self.target_article

    async def run(self):

        if self.verbose:
            print(f"Starting game from {self.start_article} to {self.target_article}")

        # get the start article
        _, links = self.db.get_article_with_links(self.start_article)

        self.steps.append(
            {
                "type": "start",
                "article": self.start_article,
                "links": links,
                "metadata": {"message": "Game started"},
            }
        )

        # while the current article is not the target article and the number of steps taken is less than the max allowed steps
        while self.steps_taken < self.max_allowed_steps:
            self.steps_taken += 1

            # Await the async player move
            player_move, metadata = await self.player.get_move(self.steps)

            # player couldn't select a valid link
            if player_move == -1:
                self.steps.append(
                    {"type": "lose", "article": player_move, "metadata": metadata}
                )
                break

            if self.verbose:
                print(f" ->  Step {self.steps_taken}: {player_move}")
                # input("Press Enter to continue...")

            # if we found it its over
            if player_move == self.target_article:
                self.steps.append(
                    {"type": "win", "article": player_move, "metadata": metadata}
                )
                break

            # if not lets get the next article
            _, links = self.db.get_article_with_links(player_move)

            if len(links) == 0:
                self.steps.append(
                    {"type": "lose", "article": player_move, "metadata": metadata}
                )
                break

            if self.steps_taken >= self.max_allowed_steps:
                self.steps.append(
                    {
                        "type": "lose",
                        "article": player_move,
                        "links": links,
                        "metadata": {
                            **metadata,
                            "reason": metadata.get("reason", "max_steps"),
                            "max_steps": self.max_allowed_steps,
                        },
                    }
                )
                break

            self.steps.append(
                {
                    "type": "move",
                    "article": player_move,
                    "links": links,
                    "metadata": metadata,
                }
            )

        return self.steps


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Play the WikiRun game")
    
    # Add mutual exclusion group for player type
    player_group = parser.add_mutually_exclusive_group(required=True)
    player_group.add_argument("--human", action="store_true", help="Play as a human")
    player_group.add_argument("--agent", action="store_true", help="Use an AI agent to play")
    
    # Game parameters
    parser.add_argument("--start", type=str, default="British Library", help="Starting article title")
    parser.add_argument("--end", type=str, default="Saint Lucia", help="Target article title")
    parser.add_argument("--db", type=str, required=True, help="Path to SQLite database")
    parser.add_argument("--max-steps", type=int, default=10, help="Maximum number of steps allowed (default: 10)")
    
    # Agent parameters (only used with --agent)
    parser.add_argument(
        "--model",
        type=str,
        default="openai-responses:gpt-5-mini",
        help="PydanticAI model id for the agent (default: openai-responses:gpt-5-mini)",
    )
    parser.add_argument(
        "--api-base",
        type=str,
        default=None,
        help="Optional OpenAI-compatible base URL override (e.g. http://localhost:8001/v1)",
    )
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
    parser.add_argument("--max-links", type=int, default=200, help="Maximum number of links to consider (default: 200)")
    parser.add_argument("--max-tries", type=int, default=3, help="Maximum number of tries for the agent (default: 3)")
    
    args = parser.parse_args()

    # Initialize the database
    db = SQLiteDB(args.db)
    
    # Initialize the player based on the argument
    if args.human:
        player = Player("Human")
    else:  # args.agent is True
        player = AgentPlayer(
            model=args.model,
            api_base=args.api_base,
            verbose=True,
            max_links=args.max_links,
            max_tries=args.max_tries,
            target_article=args.end,
            openai_api_mode=args.openai_api_mode,
            openai_reasoning_effort=args.openai_reasoning_effort,
        )

    # Create and run the game
    game = Game(
        start_article=args.start,
        target_article=args.end,
        db=db,
        max_allowed_steps=args.max_steps,
        player=player,
        verbose=True
    )

    steps = asyncio.run(game.run())

    print(f"Game over in {len(steps)} steps")
    for i, step in enumerate(steps):
        print(f"Step {i}: {step['type']}")
        print(f"  Article: {step['article']}")
        print(f"  Links: {step.get('links', [])}")
        print(f"  Metadata: {step.get('metadata', {})}")
        print("\n\n")
