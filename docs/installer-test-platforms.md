# Installer transaction test platforms

`integration/tests/runtime_fixtures.py::model_supported_platform` selects a logical, non-WSL Linux/x86_64 installation for synthetic transaction and authenticated-graph fixtures. The shared `Harness` and bounded child-process fixtures apply it explicitly. This keeps transaction tests usable on an ARM64/WSL development host without bypassing the real `require_unix_runtime()` call.

Platform-contract tests override those seams explicitly. A separate regression still requires the production guard to reject Linux/aarch64. Changing that guard or declaring native ARM64 installer support requires actual artifact/runtime evidence and is outside this fixture correction.

Checks:
- Model an ARM64/WSL pytest host, construct the transaction harness, and require the synthetic transaction to pass on its explicit Linux/x86_64 model.
- Invoke the real runtime guard for Linux/aarch64 and require rejection.
- Require malformed-SHA refusal to name the malformed SHA, rather than accidentally pass on an earlier unsupported-host refusal.
- Run the complete integration suite with its existing coverage floor. Fixture success is not native ARM64 installer acceptance.
