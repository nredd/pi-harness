# Batch outcomes

`todo({ ops })` is atomic: a failed operation rejects the whole call and keeps
its input state. Successful mutations still execute in order, so each mutation
records its own immutable outcome when it runs.

That matters when later operations change or remove the same task. For example,
creating a task, clearing it, and creating another task with the reused id
reports both created subjects correctly. Likewise, successive deferrals report
the reason supplied by each operation, even if a later operation changes that
reason or reopens the task.

`list` and `get` are deliberately different. They are read operations and are
resolved after every mutation has succeeded, against the final batch state.
Their result lines therefore describe the final task list, regardless of where
they occur in `ops`.

Plan-item deferral warnings are also evaluated once after the complete call:

- a task deferred and then reopened produces no warning;
- a newly deferred task produces one warning with its final reason;
- a task that was already deferred produces a warning only when its final
  reason changed.

This coalescing affects only user notifications. The operation result text
continues to show each successful mutation's local outcome.
