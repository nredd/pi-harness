/** Chunk -> complete lines, UTF-8 safe, with a per-line length cap so one endless line cannot eat memory. */

import { StringDecoder } from "node:string_decoder";

export const MAX_LINE_CHARS = 4096;
const TRUNCATED = " ...[line truncated]";

export class LineSplitter {
	private readonly decoder = new StringDecoder("utf8");
	private pending = "";
	/** The current line already overflowed and was emitted; drop the rest of it. */
	private skipping = false;

	constructor(private readonly maxChars = MAX_LINE_CHARS) {}

	push(chunk: Buffer): string[] {
		return this.feed(this.decoder.write(chunk));
	}

	/** Emit the unterminated last line, if any. */
	flush(): string[] {
		const out = this.feed(this.decoder.end());
		if (!this.skipping && this.pending) out.push(this.pending);
		this.pending = "";
		this.skipping = false;
		return out;
	}

	private feed(text: string): string[] {
		const out: string[] = [];
		let start = 0;
		while (start < text.length) {
			const nl = text.indexOf("\n", start);
			const end = nl < 0 ? text.length : nl;
			if (this.skipping) {
				if (nl >= 0) this.skipping = false;
			} else {
				this.pending += text.slice(start, end);
				if (nl >= 0) {
					out.push(this.finish(this.pending));
					this.pending = "";
				} else if (this.pending.length > this.maxChars) {
					out.push(this.pending.slice(0, this.maxChars) + TRUNCATED);
					this.pending = "";
					this.skipping = true;
				}
			}
			start = end + 1;
		}
		return out;
	}

	private finish(line: string): string {
		const bare = line.endsWith("\r") ? line.slice(0, -1) : line;
		return bare.length > this.maxChars ? bare.slice(0, this.maxChars) + TRUNCATED : bare;
	}
}
