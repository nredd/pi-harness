.PHONY: help install bootstrap-forks bootstrap-forks-check check check-ts check-scripts check-integration check-probes check-benchmark check-package-contracts clean

PY_CHECK = uv run --locked ruff format --check . && uv run --locked ruff check --no-fix --ignore-noqa . && uv run --locked ty check

help:  ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-24s\033[0m %s\n", $$1, $$2}'

install:  ## Install owned dependencies (npm ci --ignore-scripts, uv sync --locked). Never touches forks/
	npm ci --ignore-scripts
	cd integration && uv sync --locked
	cd benchmarks/comparison && uv sync --locked --all-extras

bootstrap-forks:  ## Init/update fork submodules; refuses (changing nothing) if any initialized fork is dirty
	python3 scripts/bootstrap_forks.py

bootstrap-forks-check:  ## Preflight fork dirty state only; never updates
	python3 scripts/bootstrap_forks.py --check

check: check-ts check-scripts check-integration check-benchmark  ## Owned-code gates only (NOT forks, NOT the full stack)

check-ts:  ## Biome (non-rewriting), tsc, vitest for every npm workspace
	npm run check

check-scripts:  ## Format/lint/type/tests for scripts/ (real disposable git repos)
	cd scripts && uv run --locked --project ../integration ruff format --check . && uv run --locked --project ../integration ruff check --no-fix --ignore-noqa . && uv run --locked --project ../integration ty check
	uv run --locked --project integration pytest scripts -c scripts/pyproject.toml -p no:cacheprovider

check-integration:  ## integration/ unit gate (no pi, tmux, or scenarios)
	cd integration && $(PY_CHECK)
	cd integration && uv run --locked pytest tests -p no:cacheprovider
	$(MAKE) check-probes

check-probes:  ## Lifecycle probe Biome + strict tsc against real sources, then explicit node --test files (no glob)
	node_modules/.bin/biome check --config-path=packages/dev-tools/biome.json integration/probes/process-lifecycle.test.ts
	node_modules/.bin/tsc -p integration/probes/tsconfig.process-lifecycle.json
	node --test integration/probes/transcript-types.test.ts integration/probes/process-lifecycle.test.ts

check-benchmark:  ## benchmarks/comparison unit gate with coverage threshold
	cd benchmarks/comparison && $(PY_CHECK)
	cd benchmarks/comparison && uv run --locked pytest -p no:cacheprovider --cov --cov-report=term-missing:skip-covered

check-package-contracts:  ## Pack, audit, install and exercise each @nredd/pi-* tarball alone through exact stock Pi 1.3.0 (npm registry on first run)
	cd scripts && uv run --locked --project ../integration python package_contracts.py $(if $(REPORT),--report $(REPORT))

clean:  ## Remove caches and build output (never touches forks/)
	rm -rf node_modules integration/.venv benchmarks/comparison/.venv
	find packages integration benchmarks scripts -type d \( -name __pycache__ -o -name .pytest_cache -o -name .ruff_cache -o -name .ty_cache \) -prune -exec rm -rf {} +
