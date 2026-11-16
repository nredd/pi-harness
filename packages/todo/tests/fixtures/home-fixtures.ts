/** Real production entry points bound to the disposable test home. */
import registerTodoAtHome from "../../src/index.ts";
import { registerTodoTool as registerTodoToolAtHome } from "../../src/todo.ts";
import { TodoOverlay as TodoOverlayAtHome } from "../../src/todo-overlay.ts";
import { TEST_HOME } from "./setup.ts";

export type { Task, TaskAction, TaskDetails, TaskStatus } from "../../src/todo.ts";
export {
	__resetState,
	applyTaskCall,
	applyTaskMutation,
	DEFAULT_PROMPT_GUIDELINES,
	DEFAULT_PROMPT_SNIPPET,
	deriveBlocks,
	detectCycle,
	getNextId,
	getTodos,
	isTransitionValid,
	registerTodosCommand,
	setActiveRenderSession,
	sid,
	TOOL_NAME,
} from "../../src/todo.ts";
export { windowFor } from "../../src/todo-overlay.ts";

export const registerTodoTool: typeof registerTodoToolAtHome = (pi, options = {}) =>
	registerTodoToolAtHome(pi, { homeDir: TEST_HOME, ...options });

export default function registerTodo(...[pi, importer, options]: Parameters<typeof registerTodoAtHome>) {
	return registerTodoAtHome(pi, importer, { homeDir: TEST_HOME, ...options });
}

export class TodoOverlay extends TodoOverlayAtHome {
	constructor(homeDir = TEST_HOME) {
		super(homeDir);
	}
}
