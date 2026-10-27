# Home-directory injection

For package developers and embedders. Runtime defaults stay call-time host defaults;
there is no new user setting. Tests must pass a disposable home, not mutate `HOME`.

`createSubagentsExtension({ homeDir })` binds activation, global settings, custom
agents, package-resource discovery, saved workflows, model scope, mention clones,
agent-file operations, and explicit settings paths in child runs to that home. `RunOptions.homeDir`
provides the same seam for direct runner callers. Nested children inherit it through
the owning manager and nested-tool context. Explicit `PI_CODING_AGENT_DIR` and
session-directory overrides still win; an explicit absolute override is intentionally
not rebased under the supplied home.

`home-paths.ts` centralizes the agent-directory override and path normalization.
Pi's `normalizePath` helper is not exported from its public package entry point;
the local adapter preserves file URLs, drive-letter strings, Windows shell drive
forms (`/c`, `/mnt/c`, `/cygdrive/c`) and Windows-only `~\\` expansion without
importing a private package path. Default persisted sessions
use Pi's cwd encoding under the injected agent directory instead of allowing
`SessionManager.create` to rediscover the host home.

Audit command:

```sh
grep -nE 'getAgentDir|homedir|HOME|USERPROFILE|XDG_|~/' packages/subagents/src/*.ts packages/subagents/src/workflow/*.ts
```

The requested exhaustive audit scope is `packages/subagents/src`. Every matching
code boundary and prose occurrence is grouped by symbol below. Test-side default
API assertions in `agent-runner.test.ts` and `invocation-config.test.ts` compare
`homedir()` values without filesystem access. `helpers/print-mode-runner.ts` and
`output-file-compaction-e2e.test.ts` intentionally use `getAgentDir()` after setting
`PI_CODING_AGENT_DIR` to their disposable fixture; the print helper's explicit live
mode remains opt-in and intentionally uses host credentials.

Every matching source occurrence:

| File / occurrence | Verdict |
| --- | --- |
| `home-paths.ts` import and omitted-home `getAgentDir()` call | Call-time host default, intentional only when no home was injected |
| `home-paths.ts` `homedir` import / `normalizeHomePath` default | Call-time default; explicit home wins |
| `home-paths.ts` `~/` / Windows `~\\` branches | Injected normalization |
| `memory.ts` `homedir` import and defaults on `resolveMemoryDir`, `buildMemoryBlock`, `buildReadOnlyMemoryBlock` | Call-time defaults; all forwarding is injected |
| `memory.ts` scope and legacy-path comments | Intentional documentation, no filesystem boundary |
| `skill-loader.ts` `homedir` import / `preloadSkills` default | Call-time default; every user root uses the injected home |
| `skill-loader.ts` three user-root comments | Intentional documentation |
| `invocation-config.ts` `homedir` import / `resolveCwdParam` default | Call-time default; no environment-based runtime-home workaround |
| `invocation-config.ts` `~/` branch | Injected; user-facing schema and JSDoc examples are intentional prose |
| `agent-runner.ts` `homedir` import / `parseExtensionsSpec` default / `resolveConfiguredSessionDir` default | Call-time defaults; runner forwards `RunOptions.homeDir` to both |
| `index.ts` local `getAgentDir` closure | Injected from factory options |
| `index.ts` compact/full/type descriptions, `agentDir` template variable, custom-description candidate | All use that injected closure; descriptions intentionally display the resolved runtime path |
| `settings.ts` global-path comment | Intentional documentation; implementation uses `resolveAgentDir(homeDir)` |
| `custom-agents.ts` module and hierarchy comments | Intentional documentation; agent and package tiers share the injected home |
| `workflow/saved.ts` root comment | Intentional documentation; every resolver/listing/package call forwards its home |
| `resource-loader.ts` leading `~/` / Windows `~\\` settings branches | Injected, through copied user/project resource entries and package sources/filters before the real package manager resolves them |

Former `getAgentDir` consumers without remaining grep hits are also injected:
`agent-file-toggle`, `enabled-models`, `enterprise-local`, `mention-clone`,
`package-resources`, `settings`, and `workflow/saved`. Package discovery normalizes
local package sources against the injected home before calling Pi's public installed-path
resolver, retaining original source strings for gates and diagnostics. Its cache key
includes both the home and resolved user directory. Enabled-model caching includes both full
settings paths, so changing homes cannot reuse another home's result.

Real loader settings:

`resource-loader.ts` wraps the public scoped settings readers before constructing
Pi's real `DefaultResourceLoader`. Its real package manager receives absolute
injected-home entries for user and trusted-project `packages`, `extensions`,
`skills`, `prompts` and `themes`, including package-object filters and resource
modifiers. Snapshots are copied on each read, so reload/trust changes remain Pi's
responsibility and persisted settings are never rewritten. Both `runAgent` and
mention clones use this boundary; passing only `agentDir` was insufficient.

`resource-loader-home.test.ts` starts separate Node/Bun processes with a disposable
ambient home containing decoy package/extension files. It runs the real runner or
mention clone through the real loader and package manager, with filesystem canaries
for those explicit settings entries. Runner cases execute only the injected
extension factories; both lanes stop before any model request. Vite bundles only
owned TypeScript; the actual Pi SDK stays external. Pi's automatic discovery of
ambient `~/.agents/skills` remains host-owned; this adapter is not a filesystem
sandbox and the explicit-settings canary does not claim to cover that upstream root.
The required public host seam is tracked [here](https://github.com/nredd/pi-harness/issues/179).

Frontmatter extension compatibility:

This caller retains its old expansion rules, rather than adopting every rule in
`normalizeHomePath`. On POSIX, with `cwd=/work` and the old/new home dependency
set to `/injected/home`, `extension-path-compatibility.test.ts` pins:

| Input | Before | After injection |
| --- | --- | --- |
| `~` | `/injected/home` | `/injected/home` |
| `~/x` | `/injected/home/x` | `/injected/home/x` |
| `~\x` | `/injected/home\x` | `/injected/home\x` |
| `file:///tmp/x` | `/work/file:/tmp/x` | `/work/file:/tmp/x` |
| `C:\x` | `/work/C:\x` | `/work/C:\x` |
| `C:/x` | `/work/C:/x` | `/work/C:/x` |
| `/c/x` | `/c/x` | `/c/x` |
| `/mnt/c/x` | `/mnt/c/x` | `/mnt/c/x` |
| `/absolute/x` | `/absolute/x` | `/absolute/x` |
| `./relative/x` | `/work/relative/x` | `/work/relative/x` |

Drive-letter absoluteness continues to use the native platform's `isAbsolute`.
Frontmatter `session_dir` also retains its previous caller-specific rules. SDK
session-directory settings retain their different native contract: file URLs expand,
relative settings remain relative, and injected homes only replace tilde expansion
and the implicit default storage root. Three role-specific runner regressions pin
those distinctions. The canonical Pi adapter remains appropriate for SDK settings
and agent-directory overrides; it must
not silently redefine these existing frontmatter callers.

Tests:

- `home-injection.test.ts` uses real disposable files and filesystem probes. It
  asserts zero probes resolve under `os.homedir()`, including missing resources
  and legacy fallback paths. It covers memory, skills, custom agents, settings,
  enterprise manifests, enabled models, saved workflows, packages, and path forms.
  A scoped `process.platform` descriptor override tests Windows normalization on
  both CI operating systems without changing `HOME` or the actual filesystem.
- `agent-runner.test.ts` independently pins skill, writable/read-only memory,
  extension tilde, frontmatter `session_dir`, resource/settings and default-session
  forwarding. Each forwarding argument can be removed independently to make its
  regression fail.
- `test/helpers/home-extension.ts` binds wiring tests to their disposable agent
  directory; `scenario-session.ts` passes its explicit root to the factory.
- `custom-agents.test.ts` and `skill-loader.test.ts` bind every loader invocation to
  their test home, including not-found and symlink tests.

Neighbor decisions: [#173](https://github.com/nredd/pi-harness/issues/173) tracks
`dev-tools` SSH Includes, `session-kit` titles/aliases/stats/config/rules,
`plan-mode` settings/tool policy, and `preset` footer registration. They have their
own package gates and security/presentation contracts, so this change does not mix
their implementation into the demonstrated subagents/todo leak. Invocation config
is included here. `computer-use` remains explicitly set aside by the owner.
