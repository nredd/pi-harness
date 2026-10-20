/** Shapes shared by the monitor manager, message formatter, tools and widget. */

export type MonitorStatus = "running" | "exited" | "stopped" | "timeout";

export interface MonitorMessageDetails {
	id: string;
	name: string;
	firstLine: number;
	lastLine: number;
	matched: number[];
	status: MonitorStatus;
}

export interface MonitorMessage {
	text: string;
	details: MonitorMessageDetails;
	/** Trigger an agent turn (match, exit, timeout, or `wake: true`). */
	wake: boolean;
}

export interface MonitorInfo {
	id: string;
	name: string;
	argv: string[];
	pid: number;
	status: MonitorStatus;
	startedAt: number;
	endedAt?: number;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	lines: number;
	/** Newest buffered output, for the compact TUI summary only. */
	lastLine?: string;
	wake: boolean;
	match?: string;
	timeoutMs: number;
}
