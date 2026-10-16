/**
 * Child process for the cross-process lock tests: run one git_worktree_add against a repo and
 * print the result as JSON. Started with a real `node`, so it is a separate pid with its own
 * in-process lock map. argv: repo branch path [startAtEpochMs]
 */
import { registerGitTools } from "../../src/git/index.ts";
import { createMockPi } from "../support.ts";

const [repo, branch, path, startAt] = process.argv.slice(2);
if (!repo || !branch || !path) throw new Error("usage: worktree-child <repo> <branch> <path> [startAt]");
const mock = createMockPi();
registerGitTools(mock.pi);
// Line the children up so they really race.
const wait = Number(startAt ?? 0) - Date.now();
if (wait > 0) await new Promise((r) => setTimeout(r, wait));
// The lock poll timer is unref'd on purpose, so a lone waiter would let node exit: keep this process alive.
const keepAlive = setInterval(() => {}, 1000);
const r = await mock.call("git_worktree_add", { branch, path }, repo);
clearInterval(keepAlive);
process.stdout.write(JSON.stringify({ isError: r.isError, text: mock.text(r) }));
