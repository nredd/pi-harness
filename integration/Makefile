.PHONY: help install format lint type test verify-fast verify verify-live baselines goldens clean

PYTEST := uv run pytest

help:  ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-14s\033[0m %s\n", $$1, $$2}'

install:  ## Install dependencies with uv
	uv sync

format:  ## Format with ruff
	uv run ruff format .

lint:  ## Lint with ruff
	uv run ruff check . --fix --ignore-noqa

type:  ## Type check with ty
	uv run ty check

test:  ## Unit tests for the harness library and content-free capture probe
	$(PYTEST) tests -v
	node --test probes/transcript-types.test.ts

verify-fast: format lint type test  ## Static + integration scenarios, under 2 min
	$(PYTEST) scenarios -m "static or integration"

verify: verify-fast  ## Fast + TUI + bench; required before any fork tag, tap bump, or pin bump
	$(PYTEST) scenarios -m "tui or bench"

verify-live:  ## Real providers, opt-in, cost-capped
	HARNESS_LIVE=1 $(PYTEST) scenarios -m live

baselines:  ## Re-record bench baselines
	UPDATE_BASELINES=1 $(PYTEST) scenarios -m bench

goldens:  ## Re-record golden files
	UPDATE_GOLDEN=1 $(PYTEST) scenarios -m "integration or tui"

clean:  ## Remove artifacts and caches
	rm -rf artifacts .pytest_cache .ruff_cache
	find . -type d -name __pycache__ -exec rm -rf {} +
