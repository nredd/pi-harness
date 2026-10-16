.PHONY: help install format lint type test tox clean all

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

install:  ## Install dependencies with uv
	uv sync --all-extras

format:  ## Format code with ruff
	uv run ruff format .

lint:  ## Lint code with ruff
	uv run ruff check . --fix --ignore-noqa

type:  ## Type check with ty
	uv run ty check

test:  ## Run tests with pytest
	uv run pytest -v --cov=src --cov-report=term-missing

tox:  ## Run matrix tests
	uv run tox

clean:  ## Clean artifacts
	rm -rf .pytest_cache .ruff_cache .tox dist build *.egg-info
	find . -type d -name __pycache__ -exec rm -rf {} +

all: format lint type test  ## Run full CI pipeline
