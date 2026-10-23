.PHONY: help install check check-ts check-scripts check-integration check-probes check-import-audit check-benchmark check-package-contracts check-plan-mode-package-contract check-computer-use-package-contract check-subagents-package-contract check-todo-package-contract check-resource-sampler-contract release-manifest clean

PY_CHECK = uv run --locked ruff format --check . && uv run --locked ruff check --no-fix --ignore-noqa . && uv run --locked ty check

help:  ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-24s\033[0m %s\n", $$1, $$2}'

install:  ## Install owned dependencies (npm ci --ignore-scripts, uv sync --locked). Never touches forks/
	npm ci --ignore-scripts
	cd integration && uv sync --locked
	cd benchmarks/comparison && uv sync --locked --all-extras

check: check-ts check-scripts check-integration check-benchmark  ## Owned-code gates only (NOT forks, NOT the full stack)

check-ts:  ## Biome (non-rewriting), tsc, vitest for every npm workspace
	npm run check

check-scripts:  ## Format/lint/type/tests for scripts/ (real disposable git repos)
	cd scripts && uv run --locked --project ../integration ruff format --check . && uv run --locked --project ../integration ruff check --no-fix --ignore-noqa . && uv run --locked --project ../integration ty check
	uv run --locked --project integration pytest scripts -c scripts/pyproject.toml -p no:cacheprovider
	$(MAKE) check-import-audit

check-integration:  ## integration units; requires initialized `forks/pi` Gitlink (no pi, tmux, or scenarios)
	cd integration && $(PY_CHECK)
	cd integration && uv run --locked pytest tests -p no:cacheprovider
	$(MAKE) check-probes

check-probes:  ## Probes (process-lifecycle, stack-resources) Biome + strict tsc against real sources, then explicit node --test files (no glob)
	node_modules/.bin/biome check --config-path=packages/dev-tools/biome.json integration/probes/process-lifecycle.test.ts integration/probes/stack-resources.ts
	node_modules/.bin/tsc -p integration/probes/tsconfig.probes.json
	node --test integration/probes/transcript-types.test.ts integration/probes/process-lifecycle.test.ts

check-import-audit:  ## Import-audit helper Biome + strict tsc, then node --test against the real TypeScript parser
	node_modules/.bin/biome check --config-path=packages/dev-tools/biome.json scripts/import_audit.ts scripts/import_audit.test.ts
	node_modules/.bin/tsc -p scripts/tsconfig.import-audit.json
	node --test scripts/import_audit.test.ts

check-benchmark:  ## benchmarks/comparison unit gate with coverage threshold
	cd benchmarks/comparison && $(PY_CHECK)
	cd benchmarks/comparison && uv run --locked pytest -p no:cacheprovider --cov --cov-report=term-missing:skip-covered

check-package-contracts: check-resource-sampler-contract  ## Pack, audit, install and exercise each @nredd/pi-* tarball alone through exact stock Pi 1.3.0, plus audit+install of the packed preset (npm registry on first run)
	cd scripts && uv run --locked --project ../integration python package_contracts.py $(if $(REPORT),--report $(REPORT))
	cd scripts && uv run --locked --project ../integration python package_contracts.py --audit-preset $(if $(REPORT),--report $(basename $(REPORT))-preset.json)

check-resource-sampler-contract:  ## Pack, audit, install and exercise the independent ESM resource library
	npm run build --workspace @nredd/pi-resource-sampler
	cd scripts && uv run --locked --project ../integration python package_contracts.py --audit-resource-sampler $(if $(REPORT),--report $(basename $(REPORT))-resource-sampler.json)

check-plan-mode-package-contract:  ## Packed @nredd/pi-plan-mode through exact stock Pi 1.3.0
	cd scripts && uv run --locked --project ../integration python stock_package_contract.py --package @nredd/pi-plan-mode $(if $(REPORT),--report $(REPORT))

check-computer-use-package-contract:  ## Packed @nredd/pi-computer-use through exact stock Pi; postinstall and native desktop behavior are reported NOT RUN
	cd scripts && uv run --locked --project ../integration python stock_package_contract.py --package @nredd/pi-computer-use $(if $(REPORT),--report $(REPORT))

check-subagents-package-contract:  ## Packed @nredd/pi-subagents (+ croner/nanoid from the npm registry) through exact stock Pi 1.3.0, incl. one faux `Agent` call
	cd scripts && uv run --locked --project ../integration python stock_package_contract.py --package @nredd/pi-subagents $(if $(REPORT),--report $(REPORT))

check-todo-package-contract:  ## Packed @nredd/pi-todo through exact stock Pi 1.3.0
	cd scripts && uv run --locked --project ../integration python stock_package_contract.py --package @nredd/pi-todo $(if $(REPORT),--report $(REPORT))

release-manifest:  ## Generate releases/<release-id>.json from Gitlinks and package manifests
	cd scripts && uv run --locked --project ../integration python release_manifest.py $(ARGS)

clean:  ## Remove caches and build output (never touches forks/)
	rm -rf node_modules integration/.venv benchmarks/comparison/.venv
	find packages integration benchmarks scripts -type d \( -name __pycache__ -o -name .pytest_cache -o -name .ruff_cache -o -name .ty_cache \) -prune -exec rm -rf {} +
