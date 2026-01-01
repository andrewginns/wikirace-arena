# Parallel Eval (CLI)

This folder contains the command-line tooling for:

- Running a single WikiRace as a **human** or an **LLM agent** (`game.py`)
- Running many races in parallel to benchmark a model (`proctor.py`)

All Python commands in this repo are intended to be run via `uv`.

## Setup

Install Python dependencies once from the repo root:

```bash
uv sync
```

### Get the `wikihop.db` database

Generate the DB via the script (recommended/required).
It builds `parallel_eval/wikihop.db` from Wikimedia SQL dumps (no scraping) and caches downloads under `parallel_eval/wikimedia_dumps/`.

```bash
uv run python get_wikihop.py \
  --wiki simplewiki \
  --dump-date latest \
  --download \
  --output parallel_eval/wikihop.db \
  --overwrite
```

Why: direct download URLs have been brittle; a 404/error page saved to disk can cause `SQLITE_NOTADB` when opened by SQLite.

## Which models are supported?

Agent moves are generated via **PydanticAI**, so you can use multiple providers via their native SDKs.

You typically just need to export the right API key for your provider, for example:

```bash
export OPENAI_API_KEY=...
# or: export ANTHROPIC_API_KEY=...
# or: export GEMINI_API_KEY=...
```

Common providers:

- OpenAI (hosted, Responses API): `OPENAI_API_KEY`, model like `openai-responses:gpt-5-mini`
- Anthropic: `ANTHROPIC_API_KEY`, model like `anthropic:claude-3-haiku-20240307`
- Google AI Studio (Gemini): `GEMINI_API_KEY` (or `GOOGLE_API_KEY`), model like `google-gla:gemini-2.0-flash`
- OpenRouter: `OPENROUTER_API_KEY`, model like `openrouter:anthropic/claude-3.5-sonnet`

For OpenAI-compatible hosted endpoints (vLLM, etc.), pass `--api-base` and use an OpenAI model id:

- `openai:<model>` (Chat Completions)
- `openai-responses:<model>` (Responses API)

If your server doesn’t require auth, setting `OPENAI_API_KEY=EMPTY` is often enough.

## Play a single game

### Human (interactive)

```bash
uv run python parallel_eval/game.py --human --start 'Saint Lucia' --end 'Italy' --db parallel_eval/wikihop.db
```

### Agent (LLM)

```bash
export OPENAI_API_KEY=sk_...
uv run python parallel_eval/game.py --agent --start 'Saint Lucia' --end 'Italy' --db parallel_eval/wikihop.db --model openai-responses:gpt-5-mini --max-steps 20
```

## Run a parallel evaluation (many games)

Note: `proctor.py` resolves relative paths (like `--db-path`, `--article-list`, `--output-dir`) relative to the `parallel_eval/` folder.
So when running from the repo root, pass `--db-path wikihop.db` (or omit the flag) rather than `--db-path parallel_eval/wikihop.db`.

`proctor.py` runs a full cross-product of `article_list × article_list` (excluding same→same), optionally with multiple trials.

The default article list is `supernodes.json`.

Example: evaluate a vLLM-hosted model with 200 workers:

```bash
uv run python parallel_eval/proctor.py \
  --model 'openai:Qwen/Qwen3-30B-A3B' \
  --api-base 'http://localhost:8000/v1' \
  --workers 200 \
  --db-path wikihop.db
```

Outputs (in `--output-dir`, default `parallel_eval/proctor_tmp`):

- `run_<proctor-id>_<start>_<destination>_<trial>.json` for each run (includes the full step list)
- `<proctor-id>-final-results.json` summary file aggregating all runs (includes `runs` plus high-level metrics like win rate and hop distribution)

The run files are idempotent: if you re-run the same command, existing run files are skipped.

## Visualize results

The web UI can load the `*-final-results.json` file.

1) Start the web app (see the repo root `README.md`).
2) Open **View Runs** → **Upload JSON**.

## Shrinking large JSON files

If your results include full LLM conversations in `step.metadata.conversation`, files can get large.
You can strip the conversation payloads while keeping everything needed for visualization:

```bash
jq '{
  article_list: .article_list,
  num_trials: .num_trials,
  num_workers: .num_workers,
  max_steps: .max_steps,
  agent_settings: .agent_settings,
  runs: [.runs[] | {
    model: .model,
    api_base: .api_base,
    max_links: .max_links,
    max_tries: .max_tries,
    result: .result,
    start_article: .start_article,
    destination_article: .destination_article,
    steps: [.steps[] | {
      type: .type,
      article: .article,
      metadata: (if (.metadata | has("conversation")) then (.metadata | del(.conversation)) else .metadata end)
    }]
  }]
}' parallel_eval/proctor_tmp/proctor_1-final-results.json > cleaned_data.json
```
