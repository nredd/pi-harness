# Footer cache marker on the ultrawide

The harness covers widths 60 to 320 columns in tmux (`scenarios/tui/test_footer_cache.py`), but it
cannot drive Ghostty on the real Mac mini ultrawide. Eyeball it there once after a footer change.

## Probe

Open Ghostty full width on the ultrawide, then in the pi pane:

```sh
tput cols; tput lines
pi
```

Send any prompt so a turn exists (the marker needs one assistant response), then check:

- Stats row reads `in .. out .. read .. write .. hit NN.N% warm cost $.. ctx ..%/.. (auto)` with the model name flush right and no gap or overlap before it
- `warm` flips to `cold` about 5 minutes after the last response with no input (the footer sets one timer for it); the TTL is the model's `promptCache.short` (seconds) or 300; long retention is deliberately not read, so a model with no declared TTL uses 300
- Quota row is the `Quota left: Anthropic ...` form, one row, and the status row below it
- After a drop, one cause tag follows the marker: `idle>ttl`, `model-switch`, `compaction` or `prefix-changed`. Force each:
  - wait more than 5 minutes between two prompts -> `idle>ttl`
  - `/model` to another model between prompts -> `model-switch`
  - `/compact` between prompts -> `compaction`
  - edit `AGENTS.md` or toggle a tool between prompts -> `prefix-changed`
- Drag the window narrow (below ~100 columns): the stats row swaps to `↑ ↓ R W CH..% w`/`c`, `$cost`, `ctx` with no wrapped or duplicated footer rows, and widening restores the word labels
- Wide sanity: at 300+ columns a long cwd plus branch plus session name truncates with `...` on the first row only

## Record

Note the columns, Ghostty font size, and anything awkward (wrapped row, stale row after resize,
marker detached from `hit`) in the PR or issue. Attach `pi` captured via
`tmux capture-pane -p` if it runs under tmux.
