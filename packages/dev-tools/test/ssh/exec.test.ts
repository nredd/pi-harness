import { describe, expect, it } from "vitest";
import {
	redact,
	remoteScript,
	SCP_BASE_ARGS,
	shellQuote,
	splitSentinel,
	sshArgs,
	validateRemotePath,
} from "../../src/ssh/exec.ts";

describe("ssh argv and script", () => {
	it("pins the safety flags, ends options before the host, and sends the command on stdin", () => {
		const args = sshArgs("home");
		expect(args.slice(-3)).toEqual(["--", "home", "exec sh -s"]);
		for (const flag of ["-T", "-a", "-x"]) expect(args).toContain(flag);
		for (const opt of ["BatchMode=yes", "ClearAllForwardings=yes", "RequestTTY=no", "ConnectTimeout=8"])
			expect(args).toContain(opt);
		expect(SCP_BASE_ARGS).not.toContain("-T");
		expect(SCP_BASE_ARGS).toContain("BatchMode=yes");
	});
	it("writes the command to a remote temp file through a quoted heredoc and runs it in a subshell", () => {
		const script = remoteScript("ls -la", "/con fig's");
		const eof = /<<'(__PI_CMD_[0-9a-f]{12})'/.exec(script)?.[1];
		expect(eof).toBeDefined();
		expect(script.split("\n")).toEqual([
			`__pi_tmp=$(mktemp 2>/dev/null) || { printf '\\n__PI_NO_MKTEMP\\n__PI_RC=98'; exit 98; }`,
			`trap 'rm -f "$__pi_tmp"' EXIT HUP TERM`,
			`cat > "$__pi_tmp" <<'${eof}'`,
			"ls -la",
			`${eof}`,
			`( cd -- '/con fig'"'"'s' || { printf '\\n__PI_CWD_MISSING'; exit 97; }; sh "$__pi_tmp" </dev/null )`,
			"__pi_rc=$?",
			`printf '\\n__PI_RC=%d' "$__pi_rc"`,
			"",
		]);
		expect(remoteScript("a\nb\n")).toContain("\na\nb\n__PI_CMD_");
	});
	it("picks a delimiter the command does not contain", () => {
		const evil = Array.from({ length: 3 }, (_, i) => `__PI_CMD_${"0".repeat(11)}${i}`).join("\n");
		const script = remoteScript(evil);
		const eof = /<<'(__PI_CMD_[0-9a-f]{12})'/.exec(script)?.[1] ?? "";
		expect(evil.includes(eof)).toBe(false);
	});
	it("shellQuote handles quotes and metacharacters", () => {
		expect(shellQuote("a'b $c `d`")).toBe(`'a'"'"'b $c \`d\`'`);
	});
});

describe("splitSentinel", () => {
	it("extracts the remote exit code and strips the markers", () => {
		expect(splitSentinel("out\nmore\n__PI_RC=3")).toEqual({
			remoteExit: 3,
			cwdMissing: false,
			noMktemp: false,
			stdout: "out\nmore",
		});
		expect(splitSentinel("\n__PI_RC=0")).toEqual({ remoteExit: 0, cwdMissing: false, noMktemp: false, stdout: "" });
		expect(splitSentinel("\n__PI_CWD_MISSING\n__PI_RC=97")).toEqual({
			remoteExit: 97,
			cwdMissing: true,
			noMktemp: false,
			stdout: "",
		});
		expect(splitSentinel("\n__PI_NO_MKTEMP\n__PI_RC=98")).toEqual({
			remoteExit: 98,
			cwdMissing: false,
			noMktemp: true,
			stdout: "",
		});
	});
	it("reports null when ssh died before the sentinel", () => {
		expect(splitSentinel("partial output")).toEqual({
			remoteExit: null,
			cwdMissing: false,
			noMktemp: false,
			stdout: "partial output",
		});
		expect(splitSentinel("x\n__PI_RC=")).toEqual({ remoteExit: null, cwdMissing: false, noMktemp: false, stdout: "x" });
	});
});

describe("redact", () => {
	it.each([
		["Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123", "Authorization: Bearer <redacted>"],
		["authorization: bearer abcd", "authorization: bearer <redacted>"],
		["HA_TOKEN=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnop", "HA_TOKEN=<redacted>"],
		["HA_TOKEN=abcd", "HA_TOKEN=<redacted>"],
		['export API_KEY="sk-live-0123456789abcdef"', "export API_KEY=<redacted>"],
		["token=abc12345 ok", "token=<redacted> ok"],
		["api_key=sk-12345678", "api_key=<redacted>"],
		["password: hunter2!", "password: <redacted>"],
		['"password": "hunter2hunter2"', '"password": <redacted>'],
		["passwd=x1y2z3", "passwd=<redacted>"],
		[
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
			"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.<redacted>",
		],
	])("redacts %j", (input, expected) => {
		expect(redact(input)).toBe(expected);
	});
	it.each(["plain text with no secrets", "the token was rejected", "password length must be 8", "a=b"])(
		"leaves %j alone",
		(input) => {
			expect(redact(input)).toBe(input);
		},
	);
	it("over-redacts count-like keys rather than risk a leak", () => {
		expect(redact("TOKEN_COUNT=12345678")).toBe("TOKEN_COUNT=<redacted>");
	});
	it("stays linear on adversarial input", () => {
		const t0 = Date.now();
		redact("token".repeat(100_000));
		redact("a_token=".repeat(50_000));
		redact("x".repeat(500_000));
		expect(Date.now() - t0).toBeLessThan(2_000);
	});
});

describe("validateRemotePath", () => {
	it.each(["/config/configuration.yaml", "backups/2026-10-09.tar", "a_b-c.d+e@f%g:h=i,j"])("accepts %s", (p) => {
		expect(validateRemotePath(p)).toBeUndefined();
	});
	it.each(["", "-r", "/etc/hostname;touch /tmp/pwn", "$(id)", "`id`", "a b", "~/x", "'q'", '"q"', "x|y", "x>y", "x*"])(
		"rejects %j",
		(p) => {
			expect(validateRemotePath(p)).toBeDefined();
		},
	);
});
