# Repository Guidelines

## Project Structure & Module Organization

- `src/`: Vite + React + TypeScript frontend (primary UI work).
  - `src/components/`: feature/UI components (prefer `kebab-case.tsx`).
    - `src/components/multiplayer/`: multiplayer setup/lobby/arena wrapper components.
    - `src/components/race/`: shared race UI (Arena, setup dialogs) used by both Local + Multiplayer.
  - `src/components/ui/`: shadcn/ui primitives (Radix + Tailwind).
  - `src/lib/`: shared helpers, state, and types.
    - `src/lib/race-state.ts` + `src/lib/race-driver.ts`: unify local + multiplayer into a common Arena interface.
    - `src/lib/multiplayer-store.ts`: client store + API calls + websocket sync for rooms.
    - Single sources of truth introduced by the Play Game refactor:
      - `src/lib/model-presets.ts`: recommended models + draft generators.
      - `src/lib/race-presets.ts`: Sprint/Classic/Marathon budgets.
      - `src/lib/race-participants.ts`: local participant draft/dupe logic.
      - `src/lib/run-display.ts`: canonical run display naming.
      - `src/lib/matchup-random.ts`: shared random matchup helpers.
      - `src/lib/number-utils.ts`: shared numeric parsing semantics.
- `public/`: static assets served by Vite.
- `dist/`: production build output (generated).
- `docs/ux-audit/`: Playwright UX screenshots.
- `scripts/`: developer scripts (e.g. `generate-ux-audit.mjs`).
- `api.py`: FastAPI backend (serves API and mounts `dist/` in production).
  - Multiplayer rooms live under `/rooms/*` (REST + websocket) and are stored in-memory.
- `get_wikihop.py`: build `parallel_eval/wikihop.db` from Wikimedia SQL dumps (no scraping; can auto-download dumps).
- `parallel_eval/`: Python tooling for running agents/evals.
- `parallel_eval/wikimedia_dumps/`: default cache location for downloaded dumps.
- `results/`: saved evaluation outputs used by the viewer.

## Key Code Entry Points

- Play tab + mode selection: `src/components/play-tab.tsx`
- Shared Arena UI: `src/components/race/race-arena.tsx`
- Driver abstraction (Local vs Multiplayer):
  - interface: `src/lib/race-driver.ts`
  - local: `src/lib/local-race-driver.ts`
  - multiplayer: `src/lib/multiplayer-race-driver.ts`
- Local session persistence: `src/lib/session-store.ts`
- Multiplayer client store + websocket sync: `src/lib/multiplayer-store.ts`
- Local AI orchestration: `src/components/llm-run-manager.tsx` + `src/lib/llm-runner.ts`
- Wiki iframe proxy + click bridge injection: `api.py` (`GET /wiki/*`)

## Build, Test, and Development Commands

Make targets (see `Makefile`):

- `make install`: install JS + Python deps (`yarn install`, `uv sync`).
- `make ui`: run the Vite dev server.
- `make server`: run the API (`uvicorn`) with `WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db`.
- `make build`: build the frontend to `dist/`.
- `make playwright-install`: install Playwright Chromium browsers.
- `make play-game-regression`: start API + UI and run Play Game regression assertions.
  - Runner source: `scripts/play-game-regression-runner.mjs`.
  - Automatically runs `make playwright-install` first.
- `make ux-audit`: start API + Vite and run Playwright UX screenshots (includes multiplayer + mobile participant captures).
  - Automatically runs `make playwright-install` first.
- `make ux-audit-headed`: same as above, but headed.

Frontend (prefer Yarn; repo includes both `yarn.lock` and `package-lock.json`):

- `yarn install`: install frontend deps.
- `yarn dev`: start Vite dev server (default `http://localhost:5173`).
- `yarn lint`: run ESLint.
- `yarn build`: production build to `dist/`.
- `yarn preview`: serve `dist/` locally.
- `yarn play:regression`: run the Play Game regression suite (assumes API + UI are already running).
- `yarn ux:audit`: generate UX audit screenshots under `docs/ux-audit/` (requires Playwright).

Playwright (for `yarn ux:audit`):

- Install browsers: `yarn playwright install chromium` (or `make playwright-install`)
- `make ux-audit` starts the API + UI automatically and writes screenshots to `docs/ux-audit/`.
- The UX audit script covers both desktop and mobile viewports, including a mobile participant joining a multiplayer room.
- For `yarn ux:audit`, run the API server (`make server`) and the Vite dev server (`yarn dev`) before generating screenshots.

Backend + DB (local API):

- `uv sync`: install Python deps.
- `uv run python get_wikihop.py --wiki simplewiki --dump-date latest --download --output parallel_eval/wikihop.db --overwrite`: build the SQLite DB from Wikimedia dumps (large download; cached under `parallel_eval/wikimedia_dumps/`).
- `WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --reload --port 8000`: run API.

## Coding Style & Naming Conventions

- TypeScript/React: follow existing patterns; avoid sweeping formatting-only changes.
- Tailwind: prefer utility classes over bespoke CSS.
- Keep components small and composable; reuse `src/components/ui/` primitives when possible.

## Product Semantics (Avoid Regressions)

- **Hop definition:** a hop is one move/link-click between articles (edge count). Many `steps[]` arrays include the start page at index 0, so hops are typically `max(0, steps.length - 1)` (see `src/lib/session-utils.ts` / `src/lib/hops.ts`).
- **Unlimited budgets:** LLM limits use `null` to mean “unlimited” for `max_links` and `max_tokens` (stored in session rules and passed down to runs). Classic/Marathon presets default to unlimited; Sprint retains finite defaults.
- **Invite links:** opening `/?room=room_XXXX` should land on **Play → Multiplayer** and focus **Join a room → Your name** when it’s empty.
- **Token accounting:** per-step metadata may include either `prompt_tokens`/`completion_tokens` or `input_tokens`/`output_tokens` (and sometimes `total_tokens`). The UI aggregates these across a run and also displays per-step usage in the Arena run details.
- **Move validation:** Local and Multiplayer human moves share the same server-side rules (`POST /local/validate_move` and `POST /rooms/{room_id}/move`). Fragment-only navigation (e.g. `#section`) is treated as a no-op.
- **Disable links view:** `disable_links_view` is a rules flag (default `false`) that hides Links/Split panel controls for human runs. It must not disable link clicking inside the Wikipedia iframe.
- **“You could have won” callout:** only show when there was a Direct-Link-to-Target Miss (a hop where the current page linked directly to the destination, but the next step was not the destination).
- **Add AI overrides:** leaving Add-AI Max links/tokens blank should omit `max_links`/`max_tokens` in the request so the server falls back to room/session rules; `null` means “explicit unlimited”.
- **Multiplayer “finished” behavior:** rooms stay open even after all runs are complete so hosts can add more players/AIs. The Arena shows “Race finished” based on run statuses, not `room.status`.
- **Arena layout storage:** local + multiplayer layout preferences are stored separately (`wikirace:arena-layout:v1` vs `wikirace:arena-layout:multiplayer:v1`). Multiplayer defaults to a collapsed leaderboard.

## Testing Guidelines

- No dedicated unit-test suite currently; minimum checks are `yarn lint` + `yarn build` (note: `make test` calls `yarn test`).
- For Play Game changes, run `make play-game-regression` (requires Playwright browsers installed).
- For UI changes, do a quick smoke test: start a race, add challengers, and verify leaderboard/arena interactions.
- For multiplayer UI changes, smoke test: create room, join from a second tab/device, add AI in lobby + arena (including Presets), make a human move, give up, hide/show runs, and verify websocket updates.

## Commit & Pull Request Guidelines

- Commit messages are short, descriptive phrases (no strict Conventional Commits).
- PRs should include: what/why, how to test, and screenshots/GIFs for UI layout changes.

## Security & Configuration Tips

- Don’t commit secrets; `.env` is ignored. Common env vars: `VITE_API_BASE`, `WIKISPEEDIA_DB_PATH`, provider keys (e.g. `OPENAI_API_KEY`), Logfire (`LOGFIRE_TOKEN`), local tracing controls like `WIKIRACE_LOCAL_RUN_TTL_SECONDS` / `WIKIRACE_LOCAL_RUN_CLEANUP_INTERVAL_SECONDS`, and multiplayer controls like `WIKIRACE_ROOM_TTL_SECONDS`, `WIKIRACE_ROOM_CLEANUP_INTERVAL_SECONDS`, `WIKIRACE_MAX_LLM_RUNS_PER_ROOM`, `WIKIRACE_MAX_CONCURRENT_LLM_CALLS`, `WIKIRACE_PUBLIC_HOST`.
- Backend env loading: `llm_client.py` calls `load_dotenv(override=True)`, so `.env` values take precedence over shell-exported vars (e.g. in `~/.zshrc`).
- Logfire: set `LOGFIRE_TOKEN` to enable trace export; when missing the app runs normally (`send_to_logfire="if-token-present"`).
- Local run tracing (Play → Local): the UI calls `/llm/local_run/start` once per run to create a Logfire parent “attempt” span, then sends the returned `traceparent` header (plus `x-wikirace-session-id` + `x-wikirace-run-id`) on each `/llm/local_run/step` call so all hops nest under that run.
- Wiki iframe proxy tuning (server-side `/wiki/*` fetch + cache): `WIKIRACE_WIKI_CACHE_MAX_ENTRIES`, `WIKIRACE_WIKI_CACHE_TTL_SECONDS`, `WIKIRACE_WIKI_FETCH_TIMEOUT_SECONDS`, `WIKIRACE_WIKI_FETCH_CONNECT_TIMEOUT_SECONDS`, `WIKIRACE_WIKI_HTTP_MAX_CONNECTIONS`.
- Title resolution caching: `WIKIRACE_RESOLVE_ARTICLE_CACHE_TTL_SECONDS` controls `Cache-Control` max-age for `/resolve_article/*`.
- Debugging wiki proxy cache: responses include `X-Wiki-Proxy-Cache: HIT|MISS|OFFLINE`.
- Client-side title resolution cache persists in `sessionStorage` under `wikirace:resolvedTitleCache:v1`.
- The app stores state in `localStorage`; clearing `wikirace:*` keys can help when debugging UI behavior.
