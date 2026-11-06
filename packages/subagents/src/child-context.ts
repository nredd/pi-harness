import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks resource loading/session construction performed for a subagent. This is
 * async-context-local so concurrent top-level extension work is unaffected.
 */
// Pi reloads extension modules with jiti's module cache disabled. The parent
// runner and the discovered child extension can therefore hold different module
// instances, but must consult the same async-local session marker.
const contextKey = Symbol.for("pi-subagents:child-session-context");
const globals = globalThis as typeof globalThis & { [contextKey]?: AsyncLocalStorage<boolean> };
const childSessionContext = globals[contextKey] ?? new AsyncLocalStorage<boolean>();
globals[contextKey] = childSessionContext;

export function inChildSessionContext(): boolean {
  return childSessionContext.getStore() === true;
}

export function runInChildSessionContext<T>(fn: () => Promise<T>): Promise<T> {
  return childSessionContext.run(true, fn);
}

/**
 * Make every future `reload()` of a child session's loader run in the child
 * context. A session reload (e.g. an extension calling `ctx.reload()`) calls
 * `loader.reload()` again and re-runs each extension factory, long after the
 * construction-time {@link runInChildSessionContext} has exited.
 */
export function bindChildResourceLoader<T extends { reload(): Promise<void> }>(loader: T): T {
  const reload = loader.reload.bind(loader);
  loader.reload = () => runInChildSessionContext(reload);
  return loader;
}
