# Repository Guidelines

## Project Structure & Module Organization

- `src/`: Vite + React + TypeScript frontend (primary UI work).
  - `src/components/`: feature/UI components (prefer `kebab-case.tsx`).
  - `src/components/ui/`: shadcn/ui primitives (Radix + Tailwind).
  - `src/lib/`: shared helpers, state, and types.
- `public/`: static assets served by Vite.
- `dist/`: production build output (generated).
- `docs/ux-audit/`: UX audit notes + Playwright screenshots.
- `scripts/`: developer scripts (e.g. `generate-ux-audit.mjs`).
- `api.py`: FastAPI backend (serves API and mounts `dist/` in production).
- `get_wikihop.py`: build `parallel_eval/wikihop.db` from Wikimedia SQL dumps (no scraping; can auto-download dumps).
- `parallel_eval/`: Python tooling for running agents/evals.
- `parallel_eval/wikimedia_dumps/`: default cache location for downloaded dumps.
- `results/`: saved evaluation outputs used by the viewer.

## Build, Test, and Development Commands

Make targets (see `Makefile`):

- `make install`: install JS + Python deps (`yarn install`, `uv sync`).
- `make ui`: run the Vite dev server.
- `make server`: run the API (`uvicorn`) with `WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db`.
- `make build`: build the frontend to `dist/`.

Frontend (prefer Yarn; repo includes both `yarn.lock` and `package-lock.json`):

- `yarn install`: install frontend deps.
- `yarn dev`: start Vite dev server (default `http://localhost:5173`).
- `yarn lint`: run ESLint.
- `yarn build`: production build to `dist/`.
- `yarn preview`: serve `dist/` locally.
- `yarn ux:audit`: generate UX audit screenshots under `docs/ux-audit/` (requires Playwright).

Playwright (for `yarn ux:audit`):

- `npx playwright install chromium`
- Run the API server (`make server`) and the Vite dev server (`yarn dev`) before generating screenshots.

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
- **Token accounting:** per-step metadata may include either `prompt_tokens`/`completion_tokens` or `input_tokens`/`output_tokens` (and sometimes `total_tokens`). The UI aggregates these across a run and also displays per-step usage in the Arena run details.

## Testing Guidelines

- No dedicated unit-test suite currently; minimum checks are `yarn lint` + `yarn build` (note: `make test` calls `yarn test`).
- For UI changes, do a quick smoke test: start a race, add challengers, and verify leaderboard/arena interactions.

## Commit & Pull Request Guidelines

- Commit messages are short, descriptive phrases (no strict Conventional Commits).
- PRs should include: what/why, how to test, and screenshots/GIFs for UI layout changes.

## Security & Configuration Tips

- Don’t commit secrets; `.env` is ignored. Common env vars: `VITE_API_BASE`, `WIKISPEEDIA_DB_PATH`, and provider keys (e.g. `OPENAI_API_KEY`).
- The app stores state in `localStorage`; clearing `wikirace:*` keys can help when debugging UI behavior.
