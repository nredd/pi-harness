# Per-file missing lines/functions

Baseline `b51e1774`; final test contents after `00bcdd9`. All 75 measured sources are present. Separate ownership is not an exclusion.

| Source | Owner | Before L/F | After L/F |
| --- | --- | ---: | ---: |
| `src/abortable.ts` | Lifecycle | 0/0 | 0/0 |
| `src/agent-color.ts` | Lifecycle | 0/0 | 0/0 |
| `src/agent-file-toggle.ts` | Lifecycle | 1/0 | 0/0 |
| `src/agent-manager.ts` | Lifecycle | 21/7 | 6/1 |
| `src/agent-runner.ts` | Lifecycle | 8/2 | 0/1 |
| `src/agent-source-badge.ts` | Lifecycle | 0/0 | 0/0 |
| `src/agent-types.ts` | Lifecycle | 0/0 | 0/0 |
| `src/child-context.ts` | Lifecycle | 0/0 | 0/0 |
| `src/clock.ts` | Lifecycle | 0/0 | 0/0 |
| `src/completion-outbox.ts` | Lifecycle | 0/0 | 0/0 |
| `src/context.ts` | Lifecycle | 0/0 | 0/0 |
| `src/cross-extension-rpc.ts` | Lifecycle | 0/0 | 0/0 |
| `src/custom-agents.ts` | Lifecycle | 2/0 | 0/0 |
| `src/default-agents.ts` | Lifecycle | 0/0 | 0/0 |
| `src/detached-results.ts` | Lifecycle | 0/0 | 0/0 |
| `src/enabled-models.ts` | Lifecycle | 0/0 | 0/0 |
| `src/enterprise-local.ts` | Lifecycle | 3/0 | 0/0 |
| `src/env.ts` | Lifecycle | 1/0 | 0/0 |
| `src/group-join.ts` | Lifecycle | 0/0 | 0/0 |
| `src/home-paths.ts` | Lifecycle | 0/0 | 0/0 |
| `src/index.ts` | Separate index/#193 wave | 352/33 | 352/33 |
| `src/invocation-config.ts` | Lifecycle | 0/0 | 0/0 |
| `src/memory.ts` | Lifecycle | 1/0 | 0/0 |
| `src/mention-clone.ts` | Lifecycle | 0/0 | 0/0 |
| `src/mention.ts` | Lifecycle | 0/0 | 0/0 |
| `src/model-call.ts` | Lifecycle | 0/0 | 0/0 |
| `src/model-resolver.ts` | Lifecycle | 0/1 | 0/0 |
| `src/model-scope.ts` | Lifecycle | 0/0 | 0/0 |
| `src/model-selection.ts` | Lifecycle | 0/0 | 0/0 |
| `src/model-tiers.ts` | Lifecycle | 2/3 | 0/0 |
| `src/nested-tools.ts` | Lifecycle | 6/0 | 0/0 |
| `src/output-file.ts` | Lifecycle | 1/0 | 0/0 |
| `src/package-resources.ts` | Lifecycle | 2/0 | 0/0 |
| `src/process-budget.ts` | Lifecycle | 1/0 | 0/0 |
| `src/prompts.ts` | Lifecycle | 0/0 | 0/0 |
| `src/quota-admission.ts` | Lifecycle | 0/0 | 0/0 |
| `src/resource-loader.ts` | Lifecycle | 0/0 | 0/0 |
| `src/schedule-store.ts` | Lifecycle | 5/0 | 0/0 |
| `src/schedule.ts` | Lifecycle | 6/3 | 0/0 |
| `src/settings.ts` | Lifecycle | 5/0 | 0/0 |
| `src/skill-loader.ts` | Lifecycle | 2/0 | 0/0 |
| `src/stale-ctx.ts` | Lifecycle | 0/0 | 0/0 |
| `src/startup-error.ts` | Lifecycle | 0/0 | 0/0 |
| `src/status-note.ts` | Lifecycle | 0/0 | 0/0 |
| `src/structured-output.ts` | Lifecycle | 0/0 | 0/0 |
| `src/types.ts` | Lifecycle | 1/0 | 0/0 |
| `src/usage.ts` | Lifecycle | 0/0 | 0/0 |
| `src/worktree.ts` | Lifecycle | 1/1 | 0/0 |
| `src/xml.ts` | Lifecycle | 0/0 | 0/0 |
| `src/ui/agent-mention.ts` | Lifecycle | 0/0 | 0/0 |
| `src/ui/agent-row.ts` | Lifecycle | 2/2 | 0/0 |
| `src/ui/agent-widget.ts` | Lifecycle | 15/0 | 0/0 |
| `src/ui/conversation-viewer.ts` | Separate index/#193 wave | 15/8 | 15/8 |
| `src/ui/fallback-flag.ts` | Lifecycle | 0/0 | 0/0 |
| `src/ui/fleet-list.ts` | Lifecycle | 7/3 | 2/0 |
| `src/ui/fleet-state.ts` | Lifecycle | 1/0 | 0/0 |
| `src/ui/notification-view.ts` | Lifecycle | 0/1 | 0/0 |
| `src/ui/schedule-menu.ts` | Lifecycle | 0/0 | 0/0 |
| `src/ui/select-item.ts` | Lifecycle | 0/0 | 0/0 |
| `src/ui/viewer-keys.ts` | Lifecycle | 0/0 | 0/0 |
| `src/ui/workflow-card.ts` | Lifecycle | 1/0 | 0/0 |
| `src/ui/workflow-dialog.ts` | Lifecycle | 1/1 | 0/0 |
| `src/ui/workflow-menu.ts` | Separate index/#193 wave | 11/4 | 11/4 |
| `src/workflow/collisions.ts` | Lifecycle | 0/0 | 0/0 |
| `src/workflow/entry.ts` | Lifecycle | 0/0 | 0/0 |
| `src/workflow/host.ts` | Lifecycle | 2/1 | 0/0 |
| `src/workflow/journal.ts` | Lifecycle | 0/0 | 0/0 |
| `src/workflow/json-schema.ts` | Lifecycle | 3/0 | 0/0 |
| `src/workflow/meta.ts` | Separate index/#193 wave | 11/1 | 11/1 |
| `src/workflow/progress.ts` | Lifecycle | 0/0 | 0/0 |
| `src/workflow/runtime.ts` | Lifecycle | 12/1 | 1/0 |
| `src/workflow/saved.ts` | Lifecycle | 2/0 | 0/0 |
| `src/workflow/task.ts` | Lifecycle | 2/0 | 0/0 |
| `src/workflow/tool-description.ts` | Lifecycle | 0/0 | 0/0 |
| `src/workflow/worker-source.ts` | Lifecycle | 0/0 | 0/0 |
