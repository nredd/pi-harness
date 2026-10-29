import { defineConfig } from "vitest/config";

export default defineConfig({
  // The print-mode e2e suite (test/subagents-print-mode-e2e.test.ts) drives REAL
  // faux-model turns through pi-coding-agent + pi-agent-core. That requires ONE
  // shared @earendil-works/pi-ai instance so the faux provider the test registers
  // lands in the same api-registry the session streams through. npm physically
  // duplicates pi-ai (a top-level copy and one nested under pi-coding-agent), which
  // otherwise yields two registries and "No API provider registered" errors.
  // Inlining the @earendil-works packages routes them through Vite's resolver so
  // dedupe can collapse pi-ai to a single instance — for the parent AND for every
  // subagent session the extension spawns. dedupe alone is insufficient (it only
  // affects modules Vite resolves; without inline the runtime stays externalized).
  test: {
    setupFiles: ["../../integration/inprocess/verification/home-setup.ts"],
    server: { deps: { inline: [/@earendil-works\/pi-/] } },
    // `istanbul`, NOT the `v8` default. v8 under-reports badly on this suite:
    // `src/env.ts` came out at 54.54% for the full run but 90.9% for
    // `vitest run --coverage test/env.test.ts` — coverage cannot fall as more
    // tests run. Bisecting pins it on test/subagents-print-mode-e2e.test.ts,
    // which boots a REAL pi session; pi's own resource loader re-loads the
    // extension and its imports, so the same source file appears to v8 twice —
    // once executed, once barely — and the merge takes the wrong one rather
    // than the union. The damage was not confined to env.ts: v8 also reported
    // module-level `const` declarations in src/settings.ts as uncovered, which
    // is impossible since they run on import.
    //
    // istanbul instruments at transform time and accumulates per source path,
    // so a second load adds to the same counters instead of shadowing them.
    // Same suite, same run: v8 68.6% vs istanbul 76.5% statements, and the
    // per-file numbers now match what a single-file run reports. If you switch
    // this back to v8, re-check env.ts against `--coverage test/env.test.ts`
    // before trusting anything the table says.
    coverage: {
      provider: "istanbul",
      enabled: true,
      reporter: ["text", "lcov"],
      reportsDirectory: "coverage/primary",
      reportOnFailure: true,
      include: ["src/abortable.ts","src/agent-color.ts","src/agent-file-toggle.ts","src/agent-manager.ts","src/agent-runner.ts","src/agent-source-badge.ts","src/agent-types.ts","src/child-context.ts","src/clock.ts","src/completion-outbox.ts","src/context.ts","src/cross-extension-rpc.ts","src/custom-agents.ts","src/default-agents.ts","src/detached-results.ts","src/enabled-models.ts","src/enterprise-local.ts","src/env.ts","src/group-join.ts","src/home-paths.ts","src/index.ts","src/invocation-config.ts","src/memory.ts","src/mention-clone.ts","src/mention.ts","src/model-call.ts","src/model-resolver.ts","src/model-selection.ts","src/model-scope.ts","src/model-tiers.ts","src/nested-tools.ts","src/output-file.ts","src/package-resources.ts","src/process-budget.ts","src/prompts.ts","src/quota-admission.ts","src/resource-loader.ts","src/schedule-store.ts","src/schedule.ts","src/settings.ts","src/skill-loader.ts","src/stale-ctx.ts","src/startup-error.ts","src/status-note.ts","src/structured-output.ts","src/types.ts","src/usage.ts","src/worktree.ts","src/xml.ts","src/ui/agent-mention.ts","src/ui/agent-row.ts","src/ui/agent-widget.ts","src/ui/conversation-viewer.ts","src/ui/fallback-flag.ts","src/ui/fleet-list.ts","src/ui/fleet-state.ts","src/ui/notification-view.ts","src/ui/schedule-menu.ts","src/ui/select-item.ts","src/ui/viewer-keys.ts","src/ui/workflow-card.ts","src/ui/workflow-dialog.ts","src/ui/workflow-menu.ts","src/workflow/collisions.ts","src/workflow/entry.ts","src/workflow/host.ts","src/workflow/journal.ts","src/workflow/json-schema.ts","src/workflow/meta.ts","src/workflow/progress.ts","src/workflow/runtime.ts","src/workflow/saved.ts","src/workflow/task.ts","src/workflow/tool-description.ts","src/workflow/worker-source.ts"],
    },
  },
  resolve: { dedupe: ["@earendil-works/pi-ai"] },
});
