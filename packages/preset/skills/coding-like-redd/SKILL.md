---
name: coding-like-redd
description: Redd's Python and Rust coding standards -- tooling (uv/ruff/ty; cargo/clippy/nextest), code style rules, error/logging/subprocess conventions, and required-project-file templates (including Makefiles). Load whenever writing, reviewing, editing, or scaffolding Python or Rust code, or asked about Redd's coding standards, in ANY project.
---

## Python Development

### Tooling (Astral Ecosystem)
- **Package Manager**: `uv` for all dependency management
- **Virtual Environments**: Use them!
- **Formatting & Linting**: `ruff` -- single tool for both
- **Type Checking**: `ty`. Not mypy, not pyright
- **Testing**: `pytest` with comprehensive coverage
- **Matrix Testing**: `tox`, configured in `[tool.tox]` inside `pyproject.toml`

### Code Standards
- PEP 604 unions only: `str | None`, `list[str]`, `dict[str, Any]`. Never `Optional[]`,
  `Union[]`, `typing.List` -- including inside docstrings, which drift because nothing
  enforces agreement with the signature
- `from __future__ import annotations` at the top of every new module
- Annotate every return, including `-> None`
- Follow PEP 8 strictly
- Module order: docstring, `__future__`, stdlib, third-party, first-party,
  `LOGGER = logging.getLogger(__name__)`, compiled regex and SCREAMING constants, code
- Module docstrings carry a `References:` list of links to whatever upstream tool or spec
  the module models
- Docstrings use my form, not Google or NumPy: `Parameters:` / `Returns:` / `Raises:`,
  repeating types even though they are annotated. Private helpers get docstrings too.
  Pydantic models do not -- `description=` on the field is the doc
- Imports at module top. The only two acceptable local imports are breaking a cycle and
  deferring genuine import cost. Comment which one it is
- Compile regex once at module level, `SCREAMING_CASE`. Never `re.compile` in a loop
- `pathlib` only. `Path(str(x)).resolve()`, then check `.exists()` / `.is_file()`
- Pick the container deliberately: Pydantic `BaseModel` for validated or serialized data,
  `TypedDict` for a function's return shape, `@dataclass(frozen=True)` for internal
  holders, `StrEnum` for closed string sets
- `dict` merge with `|` and `|=`, never `.update()` in an expression. Order-preserving
  dedup is `list(dict.fromkeys(...))`
- `TODO(redd):` and `NOTE(redd):` are the only marker forms. No FIXME, HACK, or XXX, no
  bare `TODO`. A bare issue URL as the body is fine, so is candid self-criticism
- My abbreviations: `cfg` (never `config`), `ti`, `ws`, `env`, `opts`, `cmd`

### Never Waive, Fix
- Never add `# noqa` or `# type: ignore`. I configure both to be ignored outright
  (`ruff check --fix --ignore-noqa`, ty `respect-type-ignore-comments = false`). Fix the
  source. If a rule is genuinely wrong, change the config and say so
- Never widen an exclude or ignore list to make a check pass. Tighten the gate, then fix
  the code to clear it
- Every lint exception carries a written reason for why it exists

### Errors, Logging, Validation
- Guard clauses open every function. Validate, coerce, then re-validate
- Backtick identifiers inside message strings. Single-quote interpolated VALUES so an
  empty string is visible: `f"Path does not exist: '{source_path}'"`
- Exception choice is semantic, respect it. `ValueError` / `TypeError` /
  `FileNotFoundError` mean bad input and the caller is at fault. Domain-retryable and
  domain-fatal failures get distinct types. Never `raise Exception` in new code
- Wrap and re-raise with `from e`. The new message names the operation and interpolates
  the original
- Module-level `LOGGER`, never `print`. **f-strings in log calls are the house style --
  do not "fix" them to `%s` lazy formatting.** Use levels with intent
- Validate before expensive work starts, not after

### Shell-out and Subprocess
- Logic goes in Python, never in the shell string. Evaluate every conditional, loop,
  retry, and parse in Python and interpolate the result:
  `{"set -e" if self.exit_on_error else ""}`. No branching inside embedded shell
- Build args as `list[str]` and join at the very end with `shlex.join`. `shlex.quote`
  anything interpolated. Optional flags via `*([flag] if cond else [])` so the command
  stays one expression
- `textwrap.dedent` for any embedded script block
- Absolute binary paths always (`/usr/bin/find -O3`). `$PATH` is not trusted
- `subprocess.check_output(..., text=True, stderr=subprocess.STDOUT)`, list-form args.
  `shell=True` only for a genuine pipeline

### Required Project Files
1. **pyproject.toml** -- comprehensive, including `[tool.ruff]`, `[tool.ty]`, `[tool.tox]`
2. **README.md** -- kept current with installation, usage, examples
3. **Makefile** -- developer convenience commands (template below)
4. **tests/** -- unit tests with real coverage

`src/` layout is right for a distributable library. A flat package layout is fine for
applications and DAG or automation repos. Do not impose `src/` where it buys nothing.

### Makefile Template for Python
```makefile
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
```

## Rust Development

### Tooling
- **Formatter**: `rustfmt` with rustfmt.toml config
- **Linter**: `clippy` at pedantic level
- **Testing**: `cargo test` and `cargo nextest` (preferred)
- **Documentation**: `cargo doc` must build without warnings
- **Additional Tools**: cargo-deny, cargo-outdated

### Code Standards
- Follow Rust idioms and conventions religiously
- Leverage the type system fully
- Modern patterns (async/await, Result/Option)
- Zero-cost abstractions
- Comprehensive documentation comments (`///` and `//!`)
- Proper error handling, avoid unwrap/expect in production

### Required Project Files
1. **Cargo.toml** -- complete project configuration
2. **README.md** -- kept current
3. **Makefile** -- developer convenience commands (template below)
4. **rustfmt.toml** -- formatting configuration
5. **tests/** -- integration tests
6. **examples/** -- usage examples
7. **benches/** -- benchmarks for performance-critical code

### Makefile Template for Rust
```makefile
.PHONY: help build test fmt lint doc check clean all

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-20s\033[0m %s\n", $$1, $$2}'

build:  ## Build the project
	cargo build

test:  ## Run tests
	cargo test --all-features

fmt:  ## Format code
	cargo fmt --all

lint:  ## Run clippy
	cargo clippy --all-targets --all-features -- -W clippy::pedantic

doc:  ## Build documentation
	cargo doc --no-deps --all-features

check:  ## Fast compile check
	cargo check --all-targets --all-features

clean:  ## Clean artifacts
	cargo clean

all: fmt lint check test doc  ## Run full CI
```
