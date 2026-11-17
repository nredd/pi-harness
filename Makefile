.PHONY: help build verify-root-overrides install install-owned install-benchmark check check-commits check-ts check-scripts check-coverage check-integration check-probes check-providers check-import-audit check-benchmark check-package-contracts check-plan-mode-package-contract check-computer-use-package-contract check-subagents-package-contract check-todo-package-contract check-resource-sampler-contract release-manifest clean

PY_CHECK = uv run --locked ruff format --check . && uv run --locked ruff check --no-fix --ignore-noqa . && uv run --locked ty check

# One Python gate: ruff, ty, then pytest across cores (`--dist loadfile` keeps each test file on one worker)
# with branch-measured LCOV written under `<dir>/coverage/python/` for `scripts/coverage_accounting.py`.
# $(1) project dir (cwd, so LCOV paths are project-relative), $(2) extra uv flags, $(3) pytest paths, $(4) --cov source.
define PY_GATE
cd $(1) && uv run --locked $(2) ruff format --check . && uv run --locked $(2) ruff check --no-fix --ignore-noqa . && uv run --locked $(2) ty check
cd $(1) && uv run --locked $(2) pytest $(3) -n 2 --dist loadfile -p no:cacheprovider --cov=$(4) --cov-branch --cov-report=lcov:coverage/python/lcov.info --cov-report=term:skip-covered --cov-fail-under=100
endef

help:  ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-24s\033[0m %s\n", $$1, $$2}'

# Standard library only, so it runs before `uv sync`. Non-legacy core tags also need `gh` >= 2.49 (authenticated).
verify-root-overrides:  ## Verify root core overrides against the lockfile, SHA256SUMS/legacy pins and provenance
	PYTHONPATH=release python3 -m pi_release.release --verify-root-overrides --root .

install: install-owned install-benchmark  ## Install everything `make check` needs. Never touches forks/

install-owned: verify-root-overrides  ## Verify root core overrides, install owned dependencies (npm ci --ignore-scripts, uv sync --locked), then `make build`. Never touches forks/
	env -u GH_TOKEN npm ci --ignore-scripts
	$(MAKE) build
	cd release && env -u GH_TOKEN uv sync --locked
	cd tests/integration && env -u GH_TOKEN uv sync --locked
	$(MAKE) install-lint-tools

.PHONY: install-lint-tools check-native-lint
install-lint-tools:  ## Bootstrap checksum-pinned shellcheck/actionlint/PowerShell/PSScriptAnalyzer in .native-lint (no global installs)
	env -u GH_TOKEN uv run --locked --project tests/integration python scripts/native_lint.py bootstrap

check-native-lint:  ## Statically lint tracked shell/workflow/PowerShell sources; absent or wrong-version tools fail closed
	uv run --locked --project tests/integration python scripts/native_lint.py check

build:  ## Build every generated `dist/` (gitignored; `pi.extensions`, the `local` stack and inprocess tests load it). Needs `npm ci` first
	env -u GH_TOKEN npm run build

install-benchmark:  ## Install tests/benchmarks/comparison, only `check-benchmark` reads it
	cd tests/benchmarks/comparison && env -u GH_TOKEN uv sync --locked --all-extras

check: check-commits check-ts check-scripts check-integration check-benchmark  ## Owned-code gates only (NOT forks, NOT the full stack)
	$(MAKE) check-coverage

check-commits:  ## Validate the complete PR/push commit range, or the latest local commit (COMMIT_RANGE overrides)
	node scripts/check-commit-messages.mjs

check-ts:  ## Biome (non-rewriting), tsc, vitest for every npm workspace, or only WORKSPACES (paths, in npm order)
	PATH="$$PATH:$${HOME}/.pi/agent/bin" npm run check$(foreach workspace,$(WORKSPACES), --workspace=$(workspace))

check-scripts: check-changelog-fragments check-native-lint  ## Format/lint/type/tests for scripts/ (real disposable git repos), then the package layout gate (allowlist may only shrink vs BASE; unset or empty BASE means origin/main)
	$(MAKE) build
	$(call PY_GATE,scripts,--project ../tests/integration,,.)
	uv run --locked --project tests/integration python scripts/package_contracts.py --packed-files-only
	uv run --locked --project tests/integration python scripts/package_layout.py --compare-ref "$(or $(BASE),origin/main)"
	$(MAKE) check-import-audit

# Unset BASE: compare against where HEAD diverged from origin/main. Any explicit BASE, even empty, is passed unchanged.
check-coverage:  ## Account for existing reports without running any tests; compare budgets to BASE, else HEAD's merge base with origin/main; COVERAGE_OS=darwin|linux names the reports' OS, COVERAGE_HOST the CI host class, COVERAGE_SKIPPED_GATES the gates the CI plan skipped
	uv run --locked --project tests/integration python scripts/coverage_accounting.py $(if $(filter undefined,$(origin BASE)),--compare-ref origin/main,--base "$(BASE)")$(if $(COVERAGE_OS), --os "$(COVERAGE_OS)")$(if $(COVERAGE_HOST), --host "$(COVERAGE_HOST)")$(if $(COVERAGE_SKIPPED_GATES), --skipped-gates "$(COVERAGE_SKIPPED_GATES)")

check-integration:  ## Integration and release units; requires initialized `forks/pi` Gitlink and tmux (stub pi on private servers; no real pi or scenarios)
	$(call PY_GATE,release,,-c pyproject.toml ../tests/integration/tests,pi_release)
	$(call PY_GATE,tests/integration,,tests,harness)
	$(MAKE) check-probes
	$(MAKE) check-providers

check-probes:  ## Offline probes: Biome + strict tsc, then independent Node/V8 and Bun/Istanbul coverage on the same explicit tests
	node_modules/.bin/biome check tests/integration/probes
	node_modules/.bin/tsc -p tests/integration/probes/tsconfig.probes.json
	@sandbox=$$(mktemp -d); trap 'rm -rf "$$sandbox"' EXIT; \
	cd tests/integration/probes && env -i PATH="$$PATH" HOME="$$sandbox" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 \
	  node ../../../scripts/run-vitest.ts node --coverage
	@sandbox=$$(mktemp -d); trap 'rm -rf "$$sandbox"' EXIT; \
	cd tests/integration/probes && env -i PATH="$$PATH" HOME="$$sandbox" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 \
	  node ../../../scripts/run-vitest.ts bun

check-providers:  ## Synthetic providers and auth preloads Biome on the directory + strict tsc, then Vitest on the config's explicit test files (no glob)
	node_modules/.bin/biome check tests/integration/providers
	node_modules/.bin/tsc -p tests/integration/providers/tsconfig.providers.json
	cd tests/integration/providers && node ../../../scripts/run-vitest.ts node --coverage
	cd tests/integration/providers && node ../../../scripts/run-vitest.ts bun

check-import-audit:  ## Offline import audit: Biome + strict tsc, then independent Node/V8 and Bun/Istanbul coverage against the real TypeScript parser
	node_modules/.bin/biome check scripts/*.ts scripts/*.mjs scripts/tests/*.mjs
	node --check scripts/router_contract.mjs
	node_modules/.bin/tsc -p scripts/tsconfig.import-audit.json
	@sandbox=$$(mktemp -d); trap 'rm -rf "$$sandbox"' EXIT; \
	cd scripts && env -i PATH="$$PATH" HOME="$$sandbox" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 \
	  node run-vitest.ts node --coverage
	@sandbox=$$(mktemp -d); trap 'rm -rf "$$sandbox"' EXIT; \
	cd scripts && env -i PATH="$$PATH" HOME="$$sandbox" PI_OFFLINE=1 PI_NO_LOCAL_LLM=1 \
	  node run-vitest.ts bun --coverage.reportsDirectory=scripts/coverage/bun

check-benchmark:  ## tests/benchmarks/comparison unit gate, 100% statement+branch coverage, LCOV under coverage/python/
	cd tests/benchmarks/comparison && $(PY_CHECK)
	cd tests/benchmarks/comparison && uv run --locked pytest -p no:cacheprovider --cov --cov-report=lcov:coverage/python/lcov.info --cov-report=term-missing:skip-covered

check-package-contracts: check-resource-sampler-contract  ## Pack, audit, install and exercise each @nredd/pi-* tarball alone through exact stock Pi 1.3.0, plus audit+install of the packed preset (npm registry on first run)
	cd scripts && uv run --locked --project ../tests/integration python package_contracts.py $(if $(REPORT),--report $(REPORT))
	cd scripts && uv run --locked --project ../tests/integration python package_contracts.py --audit-preset $(if $(REPORT),--report $(basename $(REPORT))-preset.json)

check-resource-sampler-contract:  ## Pack, audit, install and exercise the independent ESM resource library
	npm run build --workspace @nredd/pi-resource-sampler
	cd scripts && uv run --locked --project ../tests/integration python package_contracts.py --audit-resource-sampler $(if $(REPORT),--report $(basename $(REPORT))-resource-sampler.json)

check-plan-mode-package-contract:  ## Packed @nredd/pi-plan-mode through exact stock Pi 1.3.0
	cd scripts && uv run --locked --project ../tests/integration python stock_package_contract.py --package @nredd/pi-plan-mode $(if $(REPORT),--report $(REPORT))

check-computer-use-package-contract:  ## Packed @nredd/pi-computer-use through exact stock Pi; postinstall and native desktop behavior are reported NOT RUN
	cd scripts && uv run --locked --project ../tests/integration python stock_package_contract.py --package @nredd/pi-computer-use $(if $(REPORT),--report $(REPORT))

check-subagents-package-contract:  ## Packed @nredd/pi-subagents (+ croner/nanoid from the npm registry) through exact stock Pi 1.3.0, incl. one faux `Agent` call
	cd scripts && uv run --locked --project ../tests/integration python stock_package_contract.py --package @nredd/pi-subagents $(if $(REPORT),--report $(REPORT))

check-todo-package-contract:  ## Packed @nredd/pi-todo through exact stock Pi 1.3.0
	cd scripts && uv run --locked --project ../tests/integration python stock_package_contract.py --package @nredd/pi-todo $(if $(REPORT),--report $(REPORT))

.PHONY: check-changelog-fragments fold-changelog
check-changelog-fragments:  ## Validate subagents fragment names, issue attribution, bullets and fold inputs without writing
	uv run --locked --project tests/integration python scripts/changelog_fragments.py

fold-changelog: check-changelog-fragments  ## Explicitly fold subagents fragments into Unreleased, without publishing or releasing
	uv run --locked --project tests/integration python scripts/changelog_fragments.py --fold

release-manifest:  ## Generate releases/<release-id>.json from Gitlinks and package manifests
	cd scripts && uv run --locked --project ../tests/integration python release_manifest.py $(ARGS)

clean:  ## Remove caches and build output (never touches forks/)
	rm -rf node_modules tests/integration/.venv tests/benchmarks/comparison/.venv
	find packages tests release scripts -type d \( -name __pycache__ -o -name .pytest_cache -o -name .ruff_cache -o -name .ty_cache \) -prune -exec rm -rf {} +
