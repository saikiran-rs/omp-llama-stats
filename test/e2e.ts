// E2E harness: imports the real extension, and drives it against a mock
// llama.cpp SSE server on 127.0.0.1. Run with: bun test/e2e.ts
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
let working: string | null | undefined = "sentinel";
const ctx: Ctx = {
  ui: {
    setStatus: (k: string, t?: string) => { statuses[k] = t ?? ""; },
    setWorkingMessage: (t?: string) => { working = t; },
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

const saw: unknown[] = [];
const server = Bun.serve({
  port: 0,
  fetch: async (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname === "/vllm/v1/chat/completions") {
      // vLLM-shaped stream: NO `timings` block, tokens BATCHED into chunks
      // (measured 2.1-2.5 tok/chunk on a live vLLM 0.28), usage at the end.
      saw.push(JSON.parse(await req.text()));
      const body = (async function* () {
        // 200 ms of "prefill" before the first content delta
        await Bun.sleep(200);
        for (let i = 0; i < 4; i++) {
          yield "data: " + JSON.stringify({ choices: [{ delta: { content: "abc " } }] }) + "\n\n";
          await Bun.sleep(100);
        }
        // 12 completion tokens over 4 content chunks = 3 tok/chunk
        yield "data: " + JSON.stringify({ usage: { prompt_tokens: 500, completion_tokens: 12 } }) + "\n\n";
        yield "data: [DONE]\n\n";
      })();
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (url.pathname !== "/v1/chat/completions") return new Response("nope", { status: 404 });
    saw.push(JSON.parse(await req.text()));
    const chunks = [
      { prompt_progress: { processed: 100, cache: 50, total: 200, time_ms: 25 } },
      { prompt_progress: { processed: 200, cache: 50, total: 200, time_ms: 100 } },
      { usage: { prompt_tokens: 200, completion_tokens: 10 } },
      { timings: { prompt_per_second: 434.0, prompt_n: 150, cache_n: 50, predicted_n: 420, predicted_ms: 9000 } },
    ];
    const body = (async function* () {
      for (const c of chunks) yield "data: " + JSON.stringify(c) + "\n\n";
      yield "data: [DONE]\n\n";
    })();
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  },
});

let failed = 0;
function assert(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) { failed++; console.log(`  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`); }
}
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

// ── session + prompt lifecycle ────────────────────────────────────────
handlers.session_start({}, ctx);
assert("e2e: placeholder on session_start", strip(statuses.tokenSpeed), " ⚡ Gen -- t/s | Last Prompt -- t/s");

handlers.before_agent_start({}, ctx);
handlers.message_update({ assistantMessageEvent: { type: "text_start" } });
handlers.message_update({ assistantMessageEvent: { type: "text_delta" } });
handlers.message_update({ assistantMessageEvent: { type: "text_delta" } });

const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
});
const text = await res.text();

assert("e2e: bytes pass through ([DONE] intact)", text.includes("[DONE]"), true);
const body0 = saw[0] as { return_progress?: unknown; stream_options?: { include_usage?: unknown } };
assert("e2e: return_progress injected into body", body0.return_progress, true);
assert("e2e: include_usage injected into body", body0.stream_options?.include_usage, true);
assert("e2e: working message cleared after prefill", working === undefined, true);

const live = strip(statuses.tokenSpeed);
assert("e2e: live line shows last-prompt stats",
  live.startsWith(" ⚡ Gen ") && live.endsWith("Last Prompt 434 t/s [Cache 25.0% | 150 new / 50 cached]"),
  true);

// tool round-trip: args counted, execution paused
handlers.message_update({ assistantMessageEvent: { type: "toolcall_start" } });
handlers.message_update({
  assistantMessageEvent: { type: "toolcall_delta", partial: { content: [{ type: "toolCall", name: "bash" }] }, contentIndex: 0 },
});
handlers.message_update({
  assistantMessageEvent: { type: "toolcall_end", partial: { content: [{ type: "toolCall", name: "bash" }] }, contentIndex: 0 },
});

handlers.agent_end({
  willContinue: false,
  messages: [
    { role: "user" },
    { role: "assistant", content: [], usage: { output: 10 } },
  ],
});
assert("e2e: final line uses server-exact gen (420 tok / 9 s = 46.7)",
  strip(statuses.tokenSpeed),
  " ⚡ Gen 46.7 t/s | Last Prompt 434 t/s [Cache 25.0% | 150 new / 50 cached]");

// ── engine-agnostic path: a server with NO llama.cpp `timings` ───────
// Regression for the reported bug: vLLM reported roughly half (or less) of
// the real generation rate. Two causes, both covered here.
handlers.before_agent_start({}, ctx);
handlers.message_update({ assistantMessageEvent: { type: "text_start" } });

const t0 = Date.now();
const res2 = await fetch(`http://127.0.0.1:${server.port}/vllm/v1/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "m", stream: true, messages: [{ role: "user", content: "hi" }] }),
});
await res2.text();
const wallSec = (Date.now() - t0) / 1000;

handlers.agent_end({
  willContinue: false,
  messages: [{ role: "user" }, { role: "assistant", content: [], usage: { output: 12 } }],
});

const vllmLine = strip(statuses.tokenSpeed);
const genMatch = /Gen ([\d.]+) t\/s/.exec(vllmLine);
const genRate = genMatch ? Number(genMatch[1]) : 0;
// Decode interval is ~300 ms (3 gaps x 100 ms) for 12 tokens -> ~36 t/s.
// The old wall-clock fallback divided by ~600 ms (incl. the 200 ms prefill),
// which is the bug: it would read ~20 t/s or lower.
assert("e2e/vllm: gen uses the decode interval, not wall clock",
  genRate > 25 && genRate < 60, true);
assert("e2e/vllm: gen beats the wall-clock average it used to report",
  genRate > 12 / wallSec, true);
assert("e2e/vllm: prompt rate derived from usage + TTFT (no timings)",
  /Last Prompt [\d.]+ t\/s/.test(vllmLine), true);

// ── fetch teardown: clobber protection, then clean restore ────────────
const other = (input: RequestInfo | URL, init?: RequestInit) => ours(input, init);
globalThis.fetch = other; // simulate a later extension wrapping ours
handlers.session_shutdown();
assert("e2e: shutdown does not clobber a later wrapper", globalThis.fetch, other);

globalThis.fetch = ours;
handlers.session_shutdown();
assert("e2e: shutdown restores original fetch when ours is on top", globalThis.fetch, pristineFetch);

server.stop(true);
console.log(failed === 0 ? "ALL PASS" : `${failed} FAILURES`);
process.exit(failed === 0 ? 0 : 1);
