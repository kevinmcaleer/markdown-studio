# Common tasks. Run `make help` for the list.
PYTHON ?= python3
VENV   ?= .venv
BIN    := $(VENV)/bin

.PHONY: help install dev dev-server dev-web build test lint format docker-up docker-down backup clean

help:
	@grep -E '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

$(BIN)/activate:
	$(PYTHON) -m venv $(VENV)

install: $(BIN)/activate ## Create the virtualenv and install Python + JS dependencies
	$(BIN)/pip install -r requirements-dev.txt
	$(BIN)/pip install -e packages/powertools-auth
	npm install

dev-server: ## Run the API with auto-reload on http://127.0.0.1:8000
	cd server && RELOAD=true ../$(BIN)/python -m studio

dev-web: ## Run the web app with hot reload on http://127.0.0.1:5173 (proxies the API)
	npm run dev

dev: ## Run both (Ctrl+C stops both)
	$(MAKE) -j2 dev-server dev-web

build: ## Build the web app into web/dist
	npm run build

test: ## Run the server and web tests
	$(BIN)/pytest
	npm test

lint: ## Lint and check formatting
	$(BIN)/ruff check .
	$(BIN)/ruff format --check .
	npm run typecheck

format: ## Auto-format the Python code
	$(BIN)/ruff check --fix .
	$(BIN)/ruff format .

docker-up: ## Build and start with Docker Compose
	docker compose up -d --build

docker-down: ## Stop the Docker Compose stack
	docker compose down

backup: ## Take a consistent backup of the running app's database into ./backups
	docker compose exec -u app markdown-studio scripts/backup.sh /data/studio.db /backups

clean: ## Remove caches and build output
	rm -rf .pytest_cache .ruff_cache .coverage htmlcov web/dist
