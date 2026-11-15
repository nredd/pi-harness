/**
 * #583: a child's provider key comes from a `!command` helper that can fail transiently. Core
 * retries and briefly caches it (nredd/pi#18); these run a real shell helper behind real children
 * to prove a flaky helper costs the run nothing, and that a dead one leaves a resumable, secret-free failure.
 */
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getApiProvider, registerApiProvider } from "@earendil-works/pi-ai/compat";
import { deferred } from "@nredd/pi-test-lib/deferred";
import { nextEvent, text, toolCalls } from "@nredd/pi-test-lib/faux";
import { afterEach, expect, it } from "vitest";
import { answer, notices, ScenarioSession, spawn } from "./helpers/scenario-session.js";

/** Key-shaped text the helper writes to stderr; core must redact it from every surfaced error. */
const LEAK = "sk-ant-api03-LEAKEDLEAKEDLEAKED0123456789";
/** What the helper prints when it works. Never allowed in a failure, only ever sent as the key. */
const KEY = "sk-live-GOODGOODGOODGOOD0123456789";

let fixture: ScenarioSession;
afterEach(async () => {
  await fixture?.dispose();
  Reflect.deleteProperty(globalThis, Symbol.for("pi-subagents:manager"));
});

/** `fails` leading runs exit 1 (-1 = always); every run is counted in `count`. */
function helper(fails: number) {
  const dir = fixture.root;
  const script = join(dir, "helper.sh");
  writeFileSync(join(dir, "count"), "0");
  writeFileSync(join(dir, "fails"), String(fails));
  writeFileSync(script, [
    "#!/bin/sh",
    `n=$(($(cat "${dir}/count") + 1)); echo $n > "${dir}/count"`,
    `f=$(cat "${dir}/fails")`,
    `if [ "$f" -lt 0 ] || [ "$n" -le "$f" ]; then echo "auth failed token=${LEAK}" >&2; exit 1; fi`,
    `printf %s ${KEY}`,
    "",
  ].join("\n"));
  chmodSync(script, 0o755);
  return {
    command: `!"${script}"`,
    runs: () => Number(readFileSync(join(dir, "count"), "utf8")),
    /** From here on the helper works. */
    heal: () => writeFileSync(join(dir, "fails"), "0"),
  };
}

/** Resolves at the child's terminal lifecycle event, whichever way it ended. */
function settled() {
  const done = deferred();
  const pi = fixture.pi;
  if (!pi) throw new Error("Host not started");
  const offs: (() => void)[] = [];
  for (const name of ["subagents:completed", "subagents:failed"]) {
    offs.push(pi.events.on(name, () => {
      for (const off of offs) off();
      done.resolve();
    }));
  }
  return done.promise;
}

/** Child on a `!command`-keyed provider; the transport records the key each request actually carried. */
async function startChild(fails: number, responses: ReturnType<typeof answer>[]) {
  fixture = new ScenarioSession();
  const physical = fixture.physical("credphys", "physical", responses);
  const h = await fixture.start();
  const keys: (string | undefined)[] = [];
  /** User prompts each request carried, to tell a resumed transcript from a fresh one. */
  const prompts: string[][] = [];
  const delegate = getApiProvider(physical.api);
  if (!delegate) throw new Error(`Missing transport ${physical.api}`);
  const stream: typeof delegate.streamSimple = (model, context, options) => {
    keys.push(options?.apiKey);
    prompts.push(context.messages.filter(m => m.role === "user").map(m => text(m)));
    return delegate.streamSimple(model, context, options);
  };
  registerApiProvider({ ...delegate, stream, streamSimple: stream }, fixture.root);
  const key = helper(fails);
  // Replace the fixture's literal key with the helper, the way `models.json` would.
  h.session.modelRuntime.registerProvider("credphys", { baseUrl: physical.getModel().baseUrl, apiKey: key.command, api: physical.api, models: physical.models });
  h.setResponses([toolCalls(spawn("credential child", { model: "credphys/physical" })), answer("SPAWNED"), answer("NOTICE SEEN")]);
  const completed = settled();
  const before = h.session.messages.length;
  await h.session.prompt("go");
  const id = h.session.messages.slice(before)
    .filter(m => m.role === "toolResult" && m.toolName === "Agent")
    .flatMap(m => m.content)
    .find(p => p.type === "text")?.text.match(/Agent ID: (\S+)/)?.[1];
  if (!id) throw new Error("Missing spawn id");
  return { h, key, keys, prompts, completed, record: fixture.record(id) };
}

it("a helper that fails twice is retried inside the run and the child completes", { timeout: 30_000 }, async () => {
  const { key, keys, record } = await startChild(2, [answer("CHILD DONE")]);
  await record.promise;
  expect(record.error).toBeUndefined();
  expect(record.status).toBe("completed");
  expect(record.result).toBe("CHILD DONE");
  expect(key.runs()).toBe(3);
  expect(keys).toEqual([KEY]);
});

it("a dead helper fails the child with a bounded, redacted error and leaves it resumable", { timeout: 30_000 }, async () => {
  const { h, key, keys, prompts, completed, record } = await startChild(-1, [answer("RESUMED DONE")]);
  await record.promise;
  await completed;
  const noticeTurn = nextEvent(h, e => e.type === "agent_settled");
  // The notice hold: advance until the parent's notice turn has settled, whenever the timer is armed.
  let noticed = false;
  void noticeTurn.then(() => { noticed = true; });
  for (let ticks = 0; !noticed; ticks++) {
    if (ticks > 100) throw new Error("The parent never settled its notice turn");
    fixture.clock.advance(200);
    await new Promise(resolve => setImmediate(resolve));
  }
  expect(record.status).toBe("error");
  // Bounded: core's `resolveConfigValueOrThrowWithRetry` makes 3 attempts (200 ms and 800 ms of real
  // time between them, which is why these tests take about a second), and the model never saw a request.
  expect(key.runs()).toBe(3);
  expect(keys).toEqual([]);
  // Diagnostics survive redaction: the exit code is named, and no key-shaped text reaches the error or the stored transcript.
  expect(record.error ?? "").toContain("exited with code 1");
  expect(record.error).not.toContain(LEAK);
  expect(record.error).not.toContain(KEY);
  expect(JSON.stringify(record.session?.messages)).not.toContain(LEAK);
  // The parent is told the transcript is intact, and nothing it sees carries the secret.
  const delivered = notices(h).join("\n");
  expect(delivered).toContain(`transcript intact; resume agent ${record.id} to continue`);
  expect(delivered).not.toContain(LEAK);
  expect(delivered).not.toContain(KEY);
  expect(record.session).toBeDefined();
  // Fix the helper and resume the same agent: the retry continues the transcript instead of starting over.
  key.heal();
  await h.session.waitForIdle();
  const resumedDone = settled();
  h.setResponses([toolCalls({ name: "Agent", args: { subagent_type: "general-purpose", description: "retry", prompt: "continue", resume: record.id } }), answer("RESUME STARTED")]);
  await h.session.prompt("resume it");
  await resumedDone;
  await record.promise;
  expect(record.error).toBeUndefined();
  expect(record.status).toBe("completed");
  expect(record.result).toBe("RESUMED DONE");
  expect(keys).toEqual([KEY]);
  // Same conversation, not a fresh agent: the resumed request still carried the original task prompt.
  expect(prompts).toEqual([["work", "continue"]]);
});
