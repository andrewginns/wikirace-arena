---
title: WikiRacing Language Models
emoji: 🏃
colorFrom: purple
colorTo: gray
sdk: docker
app_port: 7860
---

# WikiRacing LLMs

Race from one Wikipedia article to another using only hyperlinks.

This repo contains:

- A **web app** (Vite + React) to play the game and **visualize / compare** model runs.
- A **FastAPI backend** that serves the article graph from a local SQLite database.
- A **CLI evaluation toolkit** in `parallel_eval/` for running humans or LLM agents, plus a parallel evaluator (`proctor.py`).

The live demo runs on Hugging Face Spaces: https://huggingface.co/spaces/HuggingFaceTB/Wikispeedia

## How it works (in 60 seconds)

The “Wikipedia” in this project is a pruned snapshot of **Simple Wikipedia**. Each article has a list of outgoing links.
Those links are stored in a SQLite database named `wikihop.db` with a single table:

- `core_articles(title TEXT, links_json TEXT)`

Both the web app and the CLI “game engine” simply:

1. Look up the current article.
2. Present its outgoing links.
3. Choose one link (human click or model choice).
4. Repeat until the destination is reached or a hop limit is hit.

## Local setup

### 1) Install frontend deps

This repo uses Yarn (see `yarn.lock`):

```bash
yarn install
```

### 2) Install Python deps (uv)

This repo uses `uv` for Python environments and dependency management.

```bash
uv sync
```

### 3) Build the `wikihop.db` database (script-only)

The database is generated from a Hugging Face dataset.

```bash
uv run python get_wikihop.py --output parallel_eval/wikihop.db
```

Notes:

- This can take a while (it writes ~350k articles).
- Direct download URLs for `wikihop.db` have been brittle in practice; a 404 saved to disk can look like a file download but causes `SQLITE_NOTADB` when opened.

### 4) Start the API

The API serves graph endpoints used by the web app.

```bash
WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --reload --port 8000
```

If you want to use **AI Will Play** in the web UI, also export a provider key for LiteLLM, e.g.:

```bash
export OPENAI_API_KEY=sk_...
# or: export ANTHROPIC_API_KEY=...
# or: export GEMINI_API_KEY=...
WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --reload --port 8000
```

Endpoints you’ll care about:

- `GET /health`
- `GET /get_all_articles`
- `GET /get_article_with_links/{title}`
- `POST /llm/chat` (AI move generation via LiteLLM)

### 5) Start the web app

In a second terminal:

```bash
yarn dev
```

Open the printed Vite URL (typically `http://localhost:5173`).

Optional (single-server / production-like):

```bash
yarn build
WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --port 8000
```

When `dist/` exists, `api.py` serves it automatically.

## Playing the game

### In the browser

- Use the **Play Game** tab.
- **I’ll Play** works locally without any auth.
- **AI Will Play** calls the local API (`POST /llm/chat`) which uses **LiteLLM**.
  - Set provider keys as environment variables when starting the API (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
  - For local OpenAI-compatible servers (vLLM, etc.), set **API Base** in the UI (e.g. `http://localhost:8000/v1`).

The Play tab is session-based (local to your browser):

- Create a **session** for a start → destination pair.
- Start named **human runs**; the first human run auto-starts one **baseline LLM run** in the background.
- Start additional manual LLM runs (different models) for comparison.
- Export/import sessions as JSON.
- Select runs in the session leaderboard and **Save selected to View Runs**.

### LiteLLM provider cheat sheet

These env vars must be set in the shell where you run the API server.

| Provider | Example `model` string | Key / config env var(s) | Notes |
| --- | --- | --- | --- |
| OpenAI | `gpt-5.1` | `OPENAI_API_KEY` | Uses OpenAI’s hosted API. |
| Anthropic | `anthropic/claude-sonnet-4-5-20250929` | `ANTHROPIC_API_KEY` | Prefix the model with `anthropic/`. |
| Google AI Studio (Gemini) | `gemini/gemini-2.5-pro` | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | Prefix the model with `gemini/`. |
| Google Vertex AI (Gemini) | `vertex_ai/gemini-2.5-pro` | `VERTEXAI_PROJECT`, `VERTEXAI_LOCATION`, credentials (e.g. `GOOGLE_APPLICATION_CREDENTIALS`) | Useful for org/GCP deployments. |
| Local OpenAI-compatible server (vLLM, etc.) | (your server’s model name) | `OPENAI_API_KEY=EMPTY` (often) | Set **API Base** in the UI, e.g. `http://localhost:8000/v1`. |

LiteLLM supports many more providers; as long as LiteLLM recognizes the `model` string + the corresponding env vars are set, the web UI will work.

### In the CLI

See `parallel_eval/README.md` for full usage.

## Evaluating models and visualizing results

1) Run a batch evaluation with `parallel_eval/proctor.py`.

It produces:

- Per-run traces: `parallel_eval/proctor_tmp/run_*.json`
- A combined summary file: `parallel_eval/proctor_tmp/<proctor-id>-final-results.json`

2) Visualize/compare runs in the web UI:

- Open **View Runs**
- Click **Upload JSON** and select your `*-final-results.json`

The viewer shows success rate and hop statistics, and renders runs as a force-directed graph.

Notes:

- The repo includes a couple of small, checked-in sample result files in `results/` that load by default in **View Runs**.
- The current viewer list/graph focuses on successful runs (`result === "win"`) while still reporting overall success rate.

## What is `index.html`?

`index.html` is the Vite entrypoint for the React app (it mounts `src/main.tsx`).
It isn’t a standalone visualization file — the visualizations live in the React UI.

## Troubleshooting

- **API fails to start / “no such table: core_articles”**:
  - Ensure `WIKISPEEDIA_DB_PATH` points to a valid `wikihop.db` with the expected schema.
- **`SQLITE_NOTADB: file is not a database`**:
  - Your `wikihop.db` is likely an HTML 404/error page saved to disk. Regenerate it with `uv run python get_wikihop.py --output parallel_eval/wikihop.db --overwrite`.
