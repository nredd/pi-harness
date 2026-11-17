Real accounting summaries from [here](https://github.com/nredd/pi-harness/actions/runs/44104072624), main-push CI, run `44104072624`, attempt `1`, head/tested SHA `a8622f3551585ac84f9edc840bf684f86cd9e43b`.

- Copy `coverage/summary.json` byte-for-byte from artifacts `coverage-ubuntu-24.04` (`14339550291`), `coverage-macos-14` (`14347919161`) and `coverage-wsl2` (`14338064184`).
- Omit the accompanying raw LCOV/native reports, which the presentation renderer does not consume. No summary rows or counters are trimmed.
- `os` is `linux` in both Ubuntu and WSL; the trusted artifact name, not that field, distinguishes those cells.
- Summaries contain measured `packages`/`files` and metadata-only `signals`; missing planned signals cannot be discovered from these summaries. The caller must provide the complete trusted plan separately.
