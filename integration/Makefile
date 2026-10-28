.PHONY: help install format lint type test stack installer bench live baselines clean

PYTEST := uv run --locked pytest
STACK_ARGS = --stack "$(STACK)"
STACK_FILES = scenarios/test_*.py scenarios/tui/test_footer_resize.py

help:  ## List targets
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-14s\033[0m %s\n", $$1, $$2}'

install:  ## Install locked harness dependencies
	uv sync --locked

format:  ## Format with ruff
	uv run --locked ruff format .

lint:  ## Lint with ruff
	uv run --locked ruff check . --fix --ignore-noqa

type:  ## Type check with ty
	uv run --locked ty check

test:  ## Infrastructure units only, no Pi or tmux
	$(PYTEST) tests -v
	$(MAKE) -C .. check-probes

stack:  ## Real D/E boundaries; explicit PI_BIN and STACK, CI/runner only
	@test -n "$(STACK)" || (printf 'Set STACK=stacks/personal.json or stacks/local.json\n'; exit 2)
	$(PYTEST) $(STACK_FILES) $(STACK_ARGS) -m stack -n 2 --dist loadfile --log-cli-level=INFO

installer:  ## Real one-shot installer in throwaway HOMEs; explicit INSTALLER_SPEC and STACK_SHA, network
	@test -n "$(INSTALLER_SPEC)" -a -n "$(STACK_SHA)" || (printf 'Set INSTALLER_SPEC=git+https://github.com/nredd/pi-harness@<sha>#subdirectory=integration STACK_SHA=<promoted sha>\n'; exit 2)
	INSTALLER_SPEC="$(INSTALLER_SPEC)" STACK_SHA="$(STACK_SHA)" $(PYTEST) scenarios/installer -m installer -n 3 --log-cli-level=INFO

bench:  ## Serial quiet-runner F only, explicit PI_BIN and STACK
	@test -n "$(STACK)"
	$(PYTEST) scenarios/bench $(STACK_ARGS) -m bench --log-cli-level=INFO

live:  ## Opt-in G only, explicit HARNESS_AUTH_FILE, PI_BIN and STACK; never CI
	@test -n "$(STACK)"
	HARNESS_LIVE=1 $(PYTEST) scenarios/live $(STACK_ARGS) -m live

baselines:  ## Quiet-runner rebaseline only, never hosted CI
	@test -n "$(STACK)"
	UPDATE_BASELINES=1 $(PYTEST) scenarios/bench $(STACK_ARGS) -m bench --log-cli-level=INFO

clean:  ## Remove artifacts and caches
	rm -rf artifacts .pytest_cache .ruff_cache
	find . -type d -name __pycache__ -exec rm -rf {} +
