install:
	yarn install
	uv sync

build:
	yarn build

server:
	WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --reload --port 8000

ui:
	yarn dev

test:
	yarn test

lint:
	yarn lint
	uv run ruff check . --fix
