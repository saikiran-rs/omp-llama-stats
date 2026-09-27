// E2E harness: imports the real extension, and drives it against mock
// OpenAI-compatible SSE servers on 127.0.0.1. Run with: bun test/e2e.ts
//
// Requires bun (uses Bun.serve). The extension patches globalThis.fetch at
// module load — the assertions at the end verify it restores it.
import ext from "../index.ts";

interface TestUI {
  setStatus: (key: string, text?: string) => void;
  setWorkingMessage: (text?: string) => void;
}
interface Ctx {
  ui: TestUI;
  hasUI: boolean;
}
type Handler = (event: unknown, ctx?: Ctx) => void;

const statuses: Record<string, string> = {};
const statusHistory: string[] = [];
const workingHistory: string[] = [];
let working: string | null | undefined = "sentinel";
const ctx: Ctx = {
  ui: {
    setStatus: (k: string, t?: string) => {
      statuses[k] = t ?? "";
      if (k === "tokenSpeed" && t) statusHistory.push(t);
    },
    setWorkingMessage: (t?: string) => {
      working = t;
      if (t) workingHistory.push(t);
    },
  },
  hasUI: true,
};

const handlers: Record<string, Handler> = {};
const fakePi = {
  on: (name: string, fn: Handler) => { handlers[name] = fn; },
};

const pristineFetch = globalThis.fetch;
ext(fakePi as unknown as Parameters<typeof ext>[0]);
if (globalThis.fetch === pristineFetch) throw new Error("fetch was not patched");
const ours = globalThis.fetch;

// ── mock servers ──────────────────────────────────────────────────────
// A script is raw SSE text to emit (string) and pauses in ms (number).
type Script = Array<string | number>;
const scripts = new Map<string, Script>();
const saw: unknown[] = [];
const sse = (o: unknown) => "data: " + JSON.stringify(o) + "\n\n";
const DONE = "data: [DONE]\n\n";

const serve = () =>
  Bun.serve({
    port: 0,
    fetch: async (req: Request) => {
      const script = scripts.get(new URL(req.url).pathname);
      if (!script) return new Response("nope", { status: 404 });
      saw.push(JSON.parse(await req.text()));
      const body = (async function* () {
        for (const step of script) {
          if (typeof step === "number") await Bun.sleep(step);
          else yield step;
        }
      })();
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    },
  });
// Two hosts (different ports) so per-host learned state can be told apart.
const llama = serve();
const vllm = serve();

async function post(server: { port: number }, path: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  return res.text();
}

// ── assertions ────────────────────────────────────────────────────────
let failed = 0;
function assert(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { failed++; console.log(`  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
// Expected lines are written with "_" for the U+2007 figure-space fill.
const fig = (s: string) => s.replace(/_/g, " ");
const line = () => strip(statuses.tokenSpeed);
const num = (re: RegExp) => {
  const m = re.exec(line());
  return m ? Number(m[1]) : NaN;
};
const gen = () => num(/Gen\s+([\d.]+) t\/s/);
const promptRate = () => num(/Last Prompt\s+([\d.]+) t\/s/);

const msg = (type: string) => handlers.message_update({ assistantMessageEvent: { type } });
const finalEnd = (output: number) =>
  handlers.agent_end({
    willContinue: false,
    messages: [{ role: "user" }, { role: "assistant", content: [], usage: { output } }],
  });
function newPrompt() {
  handlers.before_agent_start({}, ctx);
  msg("text_start");
}

// ── session start ─────────────────────────────────────────────────────
handlers.session_start({}, ctx);
assert("placeholder on session_start is full-width",
  line(), fig(" ⚡ Gen ___-- t/s | Last Prompt ____-- t/s [Cache ___--% | ___-- new / ___-- cached]"));

// ── llama.cpp: exact server timings ───────────────────────────────────
// Response 1 ends with [DONE] (finalize must still run once); response 2
// closes with no [DONE].
scripts.set("/v1/chat/completions", [
  sse({ prompt_progress: { processed: 100, cache: 50, total: 1050, time_ms: 25 } }),
  sse({ prompt_progress: { processed: 1046, cache: 50, total: 1050, time_ms: 500 } }),
  sse({ prompt_progress: { processed: 1050, cache: 50, total: 1050, time_ms: 510 } }),
  sse({ choices: [], usage: { prompt_tokens: 1050, completion_tokens: 421 },
    timings: { prompt_n: 1000, prompt_ms: 512.5, cache_n: 50, predicted_n: 421, predicted_ms: 9000 } }),
  DONE,
]);
scripts.set("/v1-second/chat/completions", [
  sse({ choices: [], usage: { prompt_tokens: 1050, completion_tokens: 101 },
    timings: { prompt_n: 20, prompt_ms: 40, cache_n: 1030, predicted_n: 101, predicted_ms: 1000 } }),
]);

newPrompt();
msg("text_delta");
msg("text_delta");
const text = await post(llama, "/v1/chat/completions");

assert("bytes pass through ([DONE] intact)", text.includes("[DONE]"), true);
const body0 = saw[0] as { return_progress?: unknown; stream_options?: { include_usage?: unknown } };
assert("return_progress injected into body", body0.return_progress, true);
assert("include_usage injected into body", body0.stream_options?.include_usage, true);
assert("prefill message: fixed width, % floored (99.6% shows 99%)",
  workingHistory, ["Prefilling...  5% · 2000.0 t/s", "Prefilling... 99% · 1992.0 t/s"]);
assert("working message cleared after prefill", working === undefined, true);
assert("last prompt stats (1000 / 0.5125 s = 1951.2, cache 50 / 1050 = 4.8%)",
  line().endsWith(fig("Last Prompt 1951.2 t/s [Cache __4.8% | ___1K new / ___50 cached]")), true);

// tool round-trip: args counted, execution paused; the next request lands
// while paused, so the line must show the exact rate so far, not a live
// estimate decaying over the dead time.
msg("toolcall_start");
msg("toolcall_delta");
msg("toolcall_end");
await post(llama, "/v1-second/chat/completions");
// (420 + 100) decode steps / (9 + 1) s. Counting predicted_n instead of
// predicted_n - 1 would read 52.1; finalizing response 1 twice would read 49.5.
assert("paused mid-prompt: exact settled gen (n-1 steps, each response once)",
  line(), fig(" ⚡ Gen _52.0 t/s | Last Prompt _500.0 t/s [Cache _98.1% | ___20 new / ___1K cached]"));

handlers.agent_end({
  willContinue: false,
  messages: [
    { role: "user" },
    { role: "assistant", content: [{ type: "toolCall" }], usage: { output: 421 } },
    { role: "toolResult" },
    { role: "assistant", content: [], usage: { output: 101 } },
  ],
});
assert("final line keeps the server-exact gen",
  line(), fig(" ⚡ Gen _52.0 t/s | Last Prompt _500.0 t/s [Cache _98.1% | ___20 new / ___1K cached]"));

// ── llama.cpp: repeated timings (timings_per_token) count once ────────
scripts.set("/repeat/chat/completions", [
  sse({ choices: [], timings: { prompt_n: 10, prompt_ms: 10, cache_n: 0, predicted_n: 11, predicted_ms: 100 } }),
  sse({ choices: [], timings: { prompt_n: 10, prompt_ms: 10, cache_n: 0, predicted_n: 101, predicted_ms: 2000 } }),
  DONE,
]);
newPrompt();
await post(llama, "/repeat/chat/completions");
finalEnd(101);
// last block wins: 100 / 2 s = 50.0 (summing both would read 52.4)
assert("repeated timings: last block wins; cold cache shows 0.0%",
  line(), fig(" ⚡ Gen _50.0 t/s | Last Prompt 1000.0 t/s [Cache __0.0% | ___10 new / ____0 cached]"));

// ── SSE edge cases + exact half-up rounding ───────────────────────────
// "data:" with no space, and a last line with no trailing newline / no [DONE].
scripts.set("/tail/chat/completions", [
  "data:" + JSON.stringify({ choices: [], usage: { prompt_tokens: 80, completion_tokens: 934 } }) + "\n\n",
  "data:" + JSON.stringify({ choices: [],
    timings: { prompt_n: 57, prompt_ms: 1000, cache_n: 23, predicted_n: 934, predicted_ms: 20000 } }),
]);
newPrompt();
await post(llama, "/tail/chat/completions");
finalEnd(934);
// 933 / 20 s = 46.65 -> 46.7 and 23 / 80 = 28.75% -> 28.8% (float
// toFixed gives 46.6 / 28.7)
assert("unterminated last line parsed; ties round half-up",
  line(), fig(" ⚡ Gen _46.7 t/s | Last Prompt __57.0 t/s [Cache _28.8% | ___57 new / ___23 cached]"));

scripts.set("/tokens/chat/completions", [
  sse({ choices: [], timings: { prompt_n: 2650, prompt_ms: 1000, cache_n: 1950, predicted_n: 2, predicted_ms: 10 } }),
  DONE,
]);
newPrompt();
await post(llama, "/tokens/chat/completions");
finalEnd(2);
assert("token counts round half-up (2650 -> 2.7K, 1950 -> 2K)",
  line(), fig(" ⚡ Gen 100.0 t/s | Last Prompt 2650.0 t/s [Cache _42.4% | _2.7K new / ___2K cached]"));

scripts.set("/big/chat/completions", [
  sse({ choices: [], timings: { prompt_n: 133_400, prompt_ms: 100_000, cache_n: 999_500, predicted_n: 2, predicted_ms: 10 } }),
  DONE,
]);
newPrompt();
await post(llama, "/big/chat/completions");
finalEnd(2);
assert("large counts stay inside the slot (133K, 999.5K -> 1M)",
  line().endsWith(fig("Last Prompt 1334.0 t/s [Cache _88.2% | _133K new / ___1M cached]")), true);

scripts.set("/old/chat/completions", [
  sse({ choices: [], timings: { prompt_n: 10, prompt_ms: 1000, predicted_n: 2, predicted_ms: 10 } }),
  DONE,
]);
newPrompt();
await post(llama, "/old/chat/completions");
finalEnd(2);
assert("no cache_n (older llama.cpp): cache reads unknown, not 0%",
  line().endsWith(fig("Last Prompt __10.0 t/s [Cache ___--% | ___10 new / ___-- cached]")), true);
assert("slow prompt rate (< 15 t/s) is red",
  statuses.tokenSpeed.includes("\x1b[38;2;255;68;68m"), true);

// ── engine-agnostic path: servers with NO llama.cpp `timings` ─────────
// Regression for the reported bug: vLLM reported roughly half (or less) of
// the real generation rate — tokens batched per chunk, and prefill in the
// wall-clock denominator.
scripts.set("/vllm/v1/chat/completions", [
  200, // "prefill" before the first content delta
  sse({ choices: [{ delta: { content: "abc " } }] }), 100,
  sse({ choices: [{ delta: { content: "abc " } }] }), 100,
  sse({ choices: [{ delta: { content: "abc " } }] }), 100,
  sse({ choices: [{ delta: { content: "abc " } }] }),
  // 12 completion tokens over 4 content chunks = 3 tok/chunk
  sse({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 12 } }),
  DONE,
]);
newPrompt();
const t0 = Date.now();
await post(vllm, "/vllm/v1/chat/completions");
const wallSec = (Date.now() - t0) / 1000;
finalEnd(12);
// 11 tokens over ~300 ms of decode -> ~36.7 t/s; the old wall-clock
// fallback divided by ~500 ms including the prefill.
assert("vllm: gen uses the decode interval, not wall clock", gen() > 25 && gen() < 45, true);
assert("vllm: gen beats the wall-clock average it used to report", gen() > 12 / wallSec, true);
assert("vllm: prompt rate from usage + TTFT; unreported cache split reads unknown",
  /Last Prompt\s+\d+\.\d t\/s \[Cache\s+--% \|\s+-- new \/\s+-- cached\]$/.test(line()), true);

scripts.set("/cached/v1/chat/completions", [
  200,
  sse({ choices: [{ delta: { content: "a" } }] }), 50,
  sse({ choices: [{ delta: { content: "b" } }] }), 50,
  sse({ choices: [{ delta: { content: "c" } }] }),
  sse({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 6,
    prompt_tokens_details: { cached_tokens: 900 } } }),
  DONE,
]);
newPrompt();
await post(vllm, "/cached/v1/chat/completions");
finalEnd(6);
// Only the 100 uncached tokens were processed in the >= 200 ms TTFT, so the
// rate is at most 500; counting all 1000 would read ~5000.
assert("reported cache split: rate counts only uncached tokens",
  promptRate() > 300 && promptRate() <= 500, true);
assert("reported cache split: bracket shows it",
  line().endsWith(fig("[Cache _90.0% | __100 new / __900 cached]")), true);

scripts.set("/fullcache/v1/chat/completions", [
  50,
  sse({ choices: [{ delta: { content: "a" } }] }), 20,
  sse({ choices: [{ delta: { content: "b" } }] }),
  sse({ choices: [], usage: { prompt_tokens: 26_000, completion_tokens: 3,
    prompt_tokens_details: { cached_tokens: 26_000 } } }),
  DONE,
]);
newPrompt();
await post(vllm, "/fullcache/v1/chat/completions");
finalEnd(3);
assert("fully cached prompt: no rate, 100% cached",
  line().endsWith(fig("Last Prompt ____-- t/s [Cache 100.0% | ____0 new / __26K cached]")), true);

// Tool-call argument chunks are generated tokens too. Two quick text chunks
// then 500 ms of tool-call arguments: counting only text chunks divided all
// 20 tokens by 50 ms (~400 t/s).
const toolCall = (args: string, first = false) =>
  sse({ choices: [{ delta: { tool_calls: [first
    ? { index: 0, id: "c1", type: "function", function: { name: "bash", arguments: args } }
    : { index: 0, function: { arguments: args } }] } }] });
scripts.set("/tools/v1/chat/completions", [
  100,
  sse({ choices: [{ delta: { content: "I'll" } }] }), 50,
  sse({ choices: [{ delta: { content: " run" } }] }), 100,
  toolCall("", true), 100,
  toolCall("{\"cmd\""), 100,
  toolCall(":\"ls"), 100,
  toolCall(" -la"), 100,
  toolCall("\"}"),
  sse({ choices: [], usage: { prompt_tokens: 777, completion_tokens: 21,
    prompt_tokens_details: { cached_tokens: 0 } } }),
  DONE,
]);
newPrompt();
await post(vllm, "/tools/v1/chat/completions");
finalEnd(21);
// 20 tokens over ~550 ms -> ~36.4 t/s
assert("tool-call chunks extend the decode interval (no inflation)", gen() > 25 && gen() < 45, true);

scripts.set("/toolsonly/v1/chat/completions", [
  100,
  toolCall("", true), 100,
  toolCall("{\"a\":1"), 100,
  toolCall("}"),
  sse({ choices: [], usage: { prompt_tokens: 555, completion_tokens: 9,
    prompt_tokens_details: { cached_tokens: 0 } } }),
  DONE,
]);
newPrompt();
await post(vllm, "/toolsonly/v1/chat/completions");
finalEnd(9);
// 8 tokens over ~200 ms -> ~40 t/s; previously no stat at all
assert("tool-call-only response: gen measured", gen() > 25 && gen() < 60, true);
assert("tool-call-only response: prompt stats measured",
  line().endsWith(fig("[Cache __0.0% | __555 new / ____0 cached]")), true);

// ── live estimate ─────────────────────────────────────────────────────
async function liveRun(server: { port: number }, path: string): Promise<number> {
  handlers.before_agent_start({}, ctx);
  await post(server, path); // sets this host's tokens-per-delta scale
  msg("text_start");
  for (let i = 0; i < 15; i++) {
    msg("text_delta");
    await Bun.sleep(20);
  }
  const live = gen();
  finalEnd(1);
  return live;
}
scripts.set("/quick/chat/completions", [
  sse({ choices: [], timings: { prompt_n: 10, prompt_ms: 10, cache_n: 0, predicted_n: 2, predicted_ms: 10 } }),
  DONE,
]);
scripts.set("/quick/v1/chat/completions", [
  sse({ choices: [{ delta: { content: "x" } }] }),
  sse({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 3 } }),
  DONE,
]);
// One delta every 20 ms = 50 deltas/s. The llama host sends 1 token per
// delta; the vllm host was learned at 3 above. The scale is per host, so a
// batching engine elsewhere never skews this one.
const liveLlama = await liveRun(llama, "/quick/chat/completions");
assert("live gen on a 1 tok/delta host ~50 t/s", liveLlama > 30 && liveLlama < 75, true);
const liveVllm = await liveRun(vllm, "/quick/v1/chat/completions");
assert("live gen on a 3 tok/delta host ~150 t/s", liveVllm > 100 && liveVllm < 225, true);

// A pause (tool run) shorter than the window must not dilute the first live
// reading after it: 600 ms of dead time inside the 1 s window read ~17 t/s.
handlers.before_agent_start({}, ctx);
await post(llama, "/quick/chat/completions"); // 1 tok/delta host
msg("text_start");
for (let i = 0; i < 10; i++) {
  msg("toolcall_delta");
  await Bun.sleep(20);
}
msg("toolcall_end");
await Bun.sleep(600);
for (let i = 0; i < 6; i++) {
  msg("text_delta");
  await Bun.sleep(20);
}
const afterPause = gen();
finalEnd(16);
assert("live gen after a pause excludes the pause (~50 t/s)", afterPause > 30 && afterPause < 75, true);

// Before two deltas exist there is no rate yet: show "--", not a red 0.
newPrompt();
await Bun.sleep(150); // let the throttled render flush
assert("no fake 0 before the first interval", line().startsWith(fig(" ⚡ Gen ___-- t/s")), true);
finalEnd(0);

// An aborted run ends with a tool call and never gets its final agent_end;
// the next prompt must start a fresh measurement, not inherit its clock.
handlers.before_agent_start({}, ctx);
msg("text_start");
msg("text_delta");
await Bun.sleep(300);
msg("text_delta");
msg("toolcall_start");
msg("toolcall_delta");
msg("toolcall_end");
handlers.agent_end({
  messages: [{ role: "user" }, { role: "assistant", content: [{ type: "toolCall" }], usage: { output: 5 } }],
});
newPrompt();
for (let i = 0; i < 5; i++) {
  msg("text_delta");
  await Bun.sleep(40);
}
finalEnd(20);
// 20 tokens / ~0.2 s -> ~100 t/s; inheriting the 0.3 s would read ~40
// 19 tokens after the first / ~0.16 s -> ~119 t/s; inheriting the aborted
// run's 0.3 s of deltas would read ~41
assert("aborted run does not leak into the next prompt", gen() > 70 && gen() < 150, true);

// Providers the hook cannot see (no usage/timings reach us) fall back to the
// engine's own average: tokens after the first delta over first -> last
// delta. agent_end latency is not generation time.
handlers.before_agent_start({}, ctx);
await post(llama, "/quick/chat/completions"); // 1 tok/delta, then no more fetches
handlers.before_agent_start({}, ctx); // clear the timings that request left
msg("text_start");
for (let i = 0; i < 11; i++) {
  if (i) await Bun.sleep(20);
  msg("text_delta");
}
await Bun.sleep(300);
finalEnd(11);
// 10 tokens / ~0.2 s -> ~50 t/s; ending the clock at agent_end read ~22
assert("fallback average: first-to-last delta, n-1", gen() > 35 && gen() < 65, true);

// A pause that closes before the first delta is outside the interval.
handlers.before_agent_start({}, ctx);
msg("text_start");
msg("toolcall_start");
msg("toolcall_end");
await Bun.sleep(200);
for (let i = 0; i < 11; i++) {
  if (i) await Bun.sleep(20);
  msg("text_delta");
}
finalEnd(11);
assert("fallback average: a pause before the first delta is not subtracted",
  gen() > 35 && gen() < 65, true);

// ...and a few milliseconds of deltas are not a rate.
handlers.before_agent_start({}, ctx);
msg("text_start");
msg("text_delta");
await Bun.sleep(3);
msg("text_delta");
finalEnd(2);
await Bun.sleep(150);
assert("fallback average: no spike from a 3 ms span", line().startsWith(fig(" ⚡ Gen ___-- t/s")), true);

// ── fixed width ───────────────────────────────────────────────────────
// Measured the way omp and pi display it: their status sanitizers strip ANSI,
// collapse runs of ASCII spaces and trim — so the fill must survive that.
const hostView = (s: string) => strip(s).replace(/ +/g, " ").trim();
const widths = new Set(statusHistory.map((s) => [...hostView(s)].length));
assert(`every rendered line has the same width (${statusHistory.length} renders)`, widths.size, 1);
const workWidths = new Set(workingHistory.map((s) => [...hostView(s)].length));
assert("prefill messages have the same width", workWidths.size, 1);

// ── fetch teardown: clobber protection, then clean restore ────────────
const other = (input: RequestInfo | URL, init?: RequestInit) => ours(input, init);
globalThis.fetch = other; // simulate a later extension wrapping ours
handlers.session_shutdown();
assert("shutdown does not clobber a later wrapper", globalThis.fetch, other);

globalThis.fetch = ours;
handlers.session_shutdown();
assert("shutdown restores original fetch when ours is on top", globalThis.fetch, pristineFetch);

llama.stop(true);
vllm.stop(true);
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
