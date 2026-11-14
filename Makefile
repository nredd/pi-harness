.PHONY: help build verify-root-overrides install install-owned install-benchmark check check-ts check-scripts check-coverage check-integration check-probes check-providers check-import-audit check-benchmark check-package-contracts check-plan-mode-package-contract check-computer-use-package-contract check-subagents-package-contract check-todo-package-contract check-resource-sampler-contract release-manifest clean

PY_CHECK = uv run --locked ruff format --check . && uv run --locked ruff check --no-fix --ignore-noqa . && uv run --locked ty check

# One Python gate: ruff, ty, then pytest across cores (`--dist loadfile` keeps each test file on one worker)
# with branch-measured LCOV written under `<dir>/coverage/python/` for `scripts/coverage_accounting.py`.
# $(1) project dir (cwd, so LCOV paths are project-relative), $(2) extra uv flags, $(3) pytest paths, $(4) --cov source.
define PY_GATE
cd $(1) && uv run --locked $(2) ruff format --check . && uv run --locked $(2) ruff check --no-fix --ignore-noqa . && uv run --locked $(2) ty check
cd $(1) && uv run --locked $(2) pytest $(3) -n auto --dist loadfile -p no:cacheprovider --cov=$(4) --cov-branch --cov-report=lcov:coverage/python/lcov.info --cov-report=term:skip-covered --cov-fail-under=100
endef

help:  ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-24s\033[0m %s\n", $$1, $$2}'

# Standard library only, so it runs before `uv sync`. Non-legacy core tags also need `gh` >= 2.49 (authenticated).
verify-root-overrides:  ## Verify root core overrides against the lockfile, SHA256SUMS/legacy pins and provenance
	PYTHONPATH=integration python3 -m harness.release --verify-root-overrides --root .

install: install-owned install-benchmark  ## Install everything `make check` needs. Never touches forks/

install-owned: verify-root-overrides  ## Verify root core overrides, install owned dependencies (npm ci --ignore-scripts, uv sync --locked), then `make build`. Never touches forks/
	env -u GH_TOKEN npm ci --ignore-scripts
	$(MAKE) build
	cd integration && env -u GH_TOKEN uv sync --locked

build:  ## Build every generated `dist/` (gitignored; `pi.extensions`, the `local` stack and inprocess tests load it). Needs `npm ci` first
	env -u GH_TOKEN npm run build

install-benchmark:  ## Install benchmarks/comparison, only `check-benchmark` reads it
	cd benchmarks/comparison && env -u GH_TOKEN uv sync --locked --all-extras

.PHONY: check-core-compaction
check-core-compaction:  ## Assembled child compaction on built candidate forks/pi, isolated from real auth
	npm run build --workspace packages/subagents
	node_modules/.bin/biome check --config-path=packages/dev-tools/biome.json integration/core-source
	node_modules/.bin/tsc -p integration/core-source/tsconfig.json
	@sandbox=$$(mktemp -d); trap 'rm -rf "$$sandbox"' EXIT; \
	mkdir -p "$$sandbox/home" "$$sandbox/tmp"; \
	env -i PATH="$$PATH" HOME="$$sandbox/home" USERPROFILE="$$sandbox/home" \
	  XDG_CONFIG_HOME="$$sandbox/home/.config" XDG_CACHE_HOME="$$sandbox/home/.cache" \
	  TMPDIR="$$sandbox/tmp" TMP="$$sandbox/tmp" TEMP="$$sandbox/tmp" \
	  PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 JITI_FS_CACHE=false AWS_EC2_METADATA_DISABLED=true \
	  GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_TERMINAL_PROMPT=0 \
	  node --import ./forks/pi/packages/coding-agent/src/experimental/source-resolver.ts \
	  --test --test-concurrency=1 --test-timeout=120000 integration/core-source/compaction-children.test.ts

check: check-ts check-scripts check-integration check-benchmark  ## Owned-code gates only (NOT forks, NOT the full stack)
	$(MAKE) check-coverage

check-ts:  ## Biome (non-rewriting), tsc, vitest for every npm workspace, or only WORKSPACES (paths, in npm order)
	PATH="$$PATH:$${HOME}/.pi/agent/bin" npm run check$(foreach workspace,$(WORKSPACES), --workspace=$(workspace))

check-scripts:  ## Format/lint/type/tests for scripts/ (real disposable git repos)
	$(call PY_GATE,scripts,--project ../integration,,.)
	$(MAKE) check-import-audit

# Unset BASE: compare against where HEAD diverged from origin/main. Any explicit BASE, even empty, is passed unchanged.
check-coverage:  ## Account for existing reports without running any tests; compare budgets to BASE, else HEAD's merge base with origin/main; COVERAGE_OS=darwin|linux names the reports' OS, COVERAGE_HOST the CI host class, COVERAGE_SKIPPED_GATES the gates the CI plan skipped
	uv run --locked --project integration python scripts/coverage_accounting.py $(if $(filter undefined,$(origin BASE)),--compare-ref origin/main,--base "$(BASE)")$(if $(COVERAGE_OS), --os "$(COVERAGE_OS)")$(if $(COVERAGE_HOST), --host "$(COVERAGE_HOST)")$(if $(COVERAGE_SKIPPED_GATES), --skipped-gates "$(COVERAGE_SKIPPED_GATES)")

check-integration:  ## integration units; requires initialized `forks/pi` Gitlink and tmux (stub pi on private servers; no real pi or scenarios)
	$(call PY_GATE,integration,,tests,harness)
	$(MAKE) check-probes
	$(MAKE) check-providers

check-probes:  ## Offline probes: Biome + strict tsc, then Node coverage and Bun compatibility on the config's explicit test files (no glob)
	node_modules/.bin/biome check --config-path=packages/dev-tools/biome.json integration/probes/anthropic-block-types.mjs integration/probes/anthropic-block-types.test.ts integration/probes/latency.ts integration/probes/latency.test.ts integration/probes/process-lifecycle.test.ts integration/probes/render.ts integration/probes/render.test.ts integration/probes/session-kit-child-scope.ts integration/probes/session-kit-child-scope.test.ts integration/probes/stack-resources.ts integration/probes/stack-resources.test.ts integration/probes/transcript-types.ts integration/probes/transcript-types.test.ts integration/probes/vitest.config.ts
	node_modules/.bin/tsc -p integration/probes/tsconfig.probes.json
	@sandbox=$$(mktemp -d); trap 'rm -rf "$$sandbox"' EXIT; \
	cd integration/probes && env -i PATH="$$PATH" HOME="$$sandbox" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 \
	  node ../../scripts/run-vitest.ts node --coverage
	@sandbox=$$(mktemp -d); trap 'rm -rf "$$sandbox"' EXIT; \
	cd integration/probes && env -i PATH="$$PATH" HOME="$$sandbox" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 \
	  node ../../scripts/run-vitest.ts bun --coverage.enabled=false

check-providers:  ## Synthetic providers and auth preloads Biome + strict tsc, then Vitest on the config's explicit test files (no glob)
	node_modules/.bin/biome check --config-path=packages/dev-tools/biome.json integration/providers/auth_guard.mjs integration/providers/auth_runtime_fixture.mjs integration/providers/auth_transport.mjs integration/providers/bun_runtime.mjs integration/providers/bun_runtime.test.ts integration/providers/extension_inventory.test.ts integration/providers/extension_inventory.ts integration/providers/faux.test.ts integration/providers/faux.ts integration/providers/preloads.test.ts integration/providers/redirect_anthropic.mjs integration/providers/usage_fixture.test.ts integration/providers/usage_fixture.ts integration/providers/vitest.config.ts
	node_modules/.bin/tsc -p integration/providers/tsconfig.providers.json
	cd integration/providers && node ../../scripts/run-vitest.ts node --coverage
	cd integration/providers && node ../../scripts/run-vitest.ts bun

check-import-audit:  ## Offline import audit: Biome + strict tsc, then Node coverage and Bun compatibility against the real TypeScript parser
	node_modules/.bin/biome check --config-path=packages/dev-tools/biome.json scripts/check-biome-paths.mjs scripts/check-biome-paths.test.mjs scripts/coverage-configs.test.ts scripts/import_audit.ts scripts/import_audit.test.ts scripts/merge-pr.ts scripts/merge-pr.test.ts scripts/router_contract.mjs scripts/router_contract.test.mjs scripts/runtime-builder.mjs scripts/run-vitest.ts scripts/run-vitest.test.ts scripts/vitest.config.ts
	node --check scripts/router_contract.mjs
	node_modules/.bin/tsc -p scripts/tsconfig.import-audit.json
	@sandbox=$$(mktemp -d); trap 'rm -rf "$$sandbox"' EXIT; \
	cd scripts && env -i PATH="$$PATH" HOME="$$sandbox" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 \
	  node run-vitest.ts node --coverage
	@sandbox=$$(mktemp -d); trap 'rm -rf "$$sandbox"' EXIT; \
	cd scripts && env -i PATH="$$PATH" HOME="$$sandbox" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 \
	  node run-vitest.ts bun --coverage.enabled=false

check-benchmark:  ## benchmarks/comparison unit gate, 100% statement+branch coverage, LCOV under coverage/python/
	cd benchmarks/comparison && $(PY_CHECK)
	cd benchmarks/comparison && uv run --locked pytest -p no:cacheprovider --cov --cov-report=lcov:coverage/python/lcov.info --cov-report=term-missing:skip-covered

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
