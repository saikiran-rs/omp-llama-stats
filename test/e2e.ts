// Exercise the real extension against an HTTP SSE server and Pi's native
// provider callbacks. Run with bun run test.
import ext from "../index.ts";

const statuses: Record<string, string> = {};
const workingHistory: Array<string | undefined> = [];
let working: string | undefined;
let workingThrows = false;
const ctx = {
  hasUI: true,
  ui: {
    setStatus(k: string, v?: string) { statuses[k] = v ?? ""; },
    setWorkingMessage(v?: string) {
      if (workingThrows) throw new Error("UI unavailable");
      working = v;
      workingHistory.push(v);
    },
  },
};
const handlers: Record<string, (e: any, ctx?: any) => any> = {};
const pristineFetch = globalThis.fetch;
ext({ on: (e: string, fn: any) => { handlers[e] = fn; } } as any);
const ours = globalThis.fetch;

const scripts = new Map<string, string[]>();
const bodies: any[] = [];
let cancelled = false;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    bodies.push(JSON.parse(await req.text()));
    if (path === "/error/chat/completions") return new Response("error", { status: 500 });
    const script = scripts.get(path);
    if (!script) return new Response("no route", { status: 404 });
    return new Response(new ReadableStream({
      start(controller) {
        for (const data of script) controller.enqueue(new TextEncoder().encode(data));
        if (path !== "/cancel/chat/completions") controller.close();
      },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "text/event-stream" } });
  },
});
const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
const sse = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const DONE = "data: [DONE]\n\n";
const timing = (rate: number, ms: number, extra: any = {}) => ({
  timings: { predicted_n: 101, predicted_ms: ms, predicted_per_second: rate,
    prompt_n: 100, prompt_ms: 1000, prompt_per_second: 100, cache_n: 0, ...extra },
});
const body = { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] };
function begin(context = ctx) { handlers.before_agent_start({}, context); }
function end(output = 0) {
  handlers.agent_end({ messages: [{ role: "user" }, { role: "assistant", content: [], usage: { output } }] });
}
async function post(path: string, payload = body) {
  const response = await fetch(url(path), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
  });
  return response.text();
}
function native(payload: any = body) { handlers.before_provider_request({ payload }); }
function provider(data: any) { handlers.provider_stream_event({ model: "m", data }); }
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const line = () => strip(statuses.tokenSpeed);
const number = (pattern: RegExp) => {
  const match = pattern.exec(line());
  return match ? Number(match[1]) : null;
};
const gen = () => number(/Gen\s+([\d.]+) t\/s/);
const pp = () => number(/Last Prompt\s+([\d.]+) t\/s/);
let passed = 0;
function assert(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}\nExpected: ${JSON.stringify(expected)}\nActual: ${JSON.stringify(actual)}`);
  }
  passed++;
  console.log(`PASS ${label}`);
}

try {
  handlers.session_start({}, ctx);
  const placeholder = line();
  assert("session starts with unknown rates and counts", gen() === null && pp() === null && /-- cached/.test(line()), true);

  scripts.set("/repeat/chat/completions", [
    sse(timing(100, 100)), sse(timing(25, 4000)), DONE,
  ]);
  begin();
  const bytes = await post("/repeat/chat/completions");
  assert("response bytes pass through unchanged", bytes, scripts.get("/repeat/chat/completions")!.join(""));
  assert("latest cumulative timing replaces earlier snapshots", gen(), 25);
  assert("requests ask for per-token server timings", bodies.at(-1).timings_per_token, true);
  assert("requests ask for server prompt progress", bodies.at(-1).return_progress, true);
  assert("requests preserve usage reporting", bodies.at(-1).stream_options.include_usage, true);
  // A UI event may split a token, batch many tokens, or carry tool arguments.
  for (let i = 0; i < 200; i++) handlers.message_update?.({ assistantMessageEvent: { type: "toolcall_delta" } });
  end(100000);
  assert("UI delta count and whole-session usage never inflate Gen", gen(), 25);

  scripts.set("/second/chat/completions", [sse(timing(40, 1000)), DONE]);
  begin();
  await post("/repeat/chat/completions");
  await post("/second/chat/completions");
  end();
  assert("multi-request Gen weights server decode durations; finalizes once", gen(), 28);

  scripts.set("/old-convention/chat/completions", [sse(timing(25, 4000, { predicted_n: 100 })), DONE]);
  begin(); await post("/old-convention/chat/completions"); end();
  assert("server rate is authoritative across n and n-1 conventions", gen(), 25);

  scripts.set("/usage/chat/completions", [
    sse({ choices: [{ delta: { content: "a", reasoning_content: "b", tool_calls: [{ function: { arguments: "{}" } }] } }] }),
    sse({ usage: { prompt_tokens: 1000, completion_tokens: 10000, prompt_tokens_details: { cached_tokens: 900 } } }), DONE,
  ]);
  begin(); await post("/usage/chat/completions"); end(10000);
  assert("batched text/reasoning/tool chunks never imply a speed", gen(), null);
  assert("TTFT is never labeled prompt-processing speed", pp(), null);
  assert("usage still establishes exact cache counts", /Cache\s+90.0% \|\s+100 new \/\s+900 cached/.test(line()), true);
  begin(); await post("/repeat/chat/completions"); await post("/usage/chat/completions"); end();
  assert("missing timing for one request makes aggregate Gen unknown", gen(), null);

  scripts.set("/missing/chat/completions", [sse({ choices: [{ delta: { content: "x" } }] }), DONE]);
  begin(); await post("/missing/chat/completions"); end();
  assert("a response with no stats cannot retain earlier prompt data", line(), placeholder);

  scripts.set("/cache/chat/completions", [sse(timing(46.65, 20000, { prompt_n: 57, cache_n: 23, prompt_per_second: 57 })), DONE]);
  begin(); await post("/cache/chat/completions"); end();
  assert("rates and cache percentage round half-up", gen() === 46.7 && /Cache\s+28.8%/.test(line()), true);
  scripts.set("/no-cache/chat/completions", [sse({ timings: { predicted_per_second: 30, predicted_ms: 1000, prompt_n: 10, prompt_ms: 1000 } }), DONE]);
  begin(); await post("/no-cache/chat/completions"); end();
  assert("absent cache_n is unknown, not zero", /Cache\s+--% \|\s+10 new \/\s+-- cached/.test(line()), true);
  assert("prompt count/time is a server-measured fallback", pp(), 10);
  scripts.set("/fullcache/chat/completions", [sse(timing(30, 1000, { prompt_n: 0, cache_n: 26000, prompt_per_second: 0 })), DONE]);
  begin(); await post("/fullcache/chat/completions"); end();
  assert("fully cached prompts have no prefill rate", pp() === null && /Cache 100.0% \|\s+0 new \/\s+26K cached/.test(line()), true);
  scripts.set("/invalid/chat/completions", [
    sse({ timings: { predicted_per_second: -100, predicted_ms: -1, prompt_n: -20, cache_n: -10, prompt_per_second: -1 } }),
    sse({ usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 900 } } }), DONE,
  ]);
  begin(); await post("/invalid/chat/completions"); end();
  assert("invalid rates and impossible cache splits stay unknown", line(), placeholder);
  scripts.set("/no-rate/chat/completions", [sse({ timings: { predicted_n: 101, predicted_ms: 1000 } }), DONE]);
  begin(); await post("/no-rate/chat/completions"); end();
  assert("missing server generation rate is not reconstructed by a guessed convention", gen(), null);

  scripts.set("/progress/chat/completions", [
    sse({ prompt_progress: { processed: 100, cache: 50, total: 1050, time_ms: 25 } }),
    sse({ prompt_progress: { processed: 1046, cache: 50, total: 1050, time_ms: 500 } }),
    sse({ prompt_progress: { processed: 1050, cache: 50, total: 1050, time_ms: 510 } }), DONE,
  ]);
  begin(); workingHistory.length = 0; await post("/progress/chat/completions"); end();
  assert("prefill percentage excludes cached tokens and cannot round up to 100", workingHistory.filter(Boolean),
    ["Prefilling...  5% · 2000.0 t/s", "Prefilling... 99% · 1992.0 t/s"]);
  assert("prefill working message clears at completion", working, undefined);

  const pretty = JSON.stringify(timing(33.3, 1000), null, 2).split("\n").map((s) => `data:${s}\r\n`).join("") + "\r\n";
  const splitAt = Math.floor(pretty.length / 2);
  scripts.set("/multiline/chat/completions", [pretty.slice(0, splitAt), pretty.slice(splitAt), "data:[DONE]\r\n\r\n"]);
  begin(); await post("/multiline/chat/completions"); end();
  assert("SSE supports multiline data, split reads, CRLF and optional spaces", gen(), 33.3);
  scripts.set("/tail/chat/completions", [sse(timing(30, 1000)).trimEnd()]);
  begin(); await post("/tail/chat/completions"); end();
  assert("EOF flushes an unterminated SSE event", gen(), 30);

  begin();
  const init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, stream_options: { custom: true } }) };
  const saved = JSON.stringify(init);
  await (await fetch(new URL(url("/tail/chat/completions")), init)).text(); end();
  assert("fetch leaves RequestInit unchanged", JSON.stringify(init), saved);
  assert("existing stream_options survive", bodies.at(-1).stream_options.custom, true);
  begin();
  const request = new Request(url("/tail/chat/completions"), init);
  await (await fetch(request)).text(); end();
  assert("Request-object bodies are observed and progress-enabled", gen() === 30 && bodies.at(-1).timings_per_token === true, true);

  begin(); await post("/error/chat/completions"); end();
  assert("HTTP failure cannot show previous stats", line(), placeholder);
  begin();
  const abort = new AbortController();
  const res = await fetch(url("/cancel/chat/completions"), { ...init, signal: abort.signal });
  await res.body!.cancel(); end();
  assert("consumer cancellation clears partial stats", gen(), null);

  // Capture starts in one prompt; completion after a new prompt must be ignored.
  begin();
  const late = await fetch(url("/repeat/chat/completions"), init);
  begin(); await post("/second/chat/completions");
  await late.text(); end();
  assert("late completion cannot contaminate a new prompt", gen(), 40);
  handlers.session_start({}, ctx);
  assert("session switches reset measurements", line(), placeholder);
  const beforeIdle = bodies.length;
  await post("/repeat/chat/completions");
  assert("idle/background requests leave the session stats untouched", line(), placeholder);
  assert("idle requests receive no llama-specific options", bodies[beforeIdle].timings_per_token, undefined);

  // Modern Pi: native callbacks work even when its transport bypasses fetch.
  begin(); native();
  provider(timing(25, 4000));
  await Bun.sleep(110); // one trailing status flush
  assert("native server timings drive the live rate", gen(), 25);
  provider(timing(30, 5000));
  handlers.message_end({ message: { role: "assistant", stopReason: "stop" } }); end(90000);
  assert("native cumulative snapshots replace instead of accumulating", gen(), 30);

  begin(); native();
  await post("/repeat/chat/completions");
  provider(timing(25, 4000)); // same data through the native observer
  handlers.message_end({ message: { role: "assistant", stopReason: "toolUse" } });
  native(); await post("/second/chat/completions");
  handlers.message_end({ message: { role: "assistant", stopReason: "stop" } }); end();
  assert("native and fetch observation cannot double-count a request", gen(), 28);
  begin(); native();
  await post("/repeat/chat/completions");
  await post("/second/chat/completions", { ...body, messages: [{ role: "user", content: "Generate a title" }] });
  handlers.message_end({ message: { role: "assistant", stopReason: "stop" } }); end();
  assert("side requests with different payloads never enter native-session stats", gen(), 25);

  begin(); native(); provider(timing(25, 4000));
  handlers.message_end({ message: { role: "assistant", stopReason: "aborted" } }); end();
  assert("aborted native requests invalidate their partial timings", gen(), null);
  begin(); native();
  provider(timing(30, 1000));
  handlers.message_end({ message: { role: "assistant", stopReason: "stop" } });
  native(); provider({ timings: { predicted_per_second: 40, predicted_n: 4 } });
  handlers.message_end({ message: { role: "assistant", stopReason: "stop" } }); end();
  assert("multiple requests need durations for a weighted rate", gen(), null);

  // A stats/UI failure must never corrupt the model's bytes.
  begin(); native(); workingThrows = true;
  scripts.set("/ui/chat/completions", [sse({ prompt_progress: { processed: 0, cache: 0, total: 10, time_ms: 0 } }), DONE]);
  const uiBytes = await post("/ui/chat/completions");
  workingThrows = false;
  assert("UI exceptions do not alter streamed bytes", uiBytes, scripts.get("/ui/chat/completions")!.join(""));
  end();

  const widths = [placeholder, line()].map((s) => s.length);
  assert("placeholder and measured rows keep the fixed-width slots", widths[0], widths[1]);
  const other = (input: RequestInfo | URL, init?: RequestInit) => ours(input, init);
  globalThis.fetch = other;
  handlers.session_shutdown();
  assert("shutdown never clobbers a later fetch wrapper", globalThis.fetch === other, true);
  globalThis.fetch = ours;
  handlers.session_shutdown();
  assert("shutdown restores the original fetch when on top", globalThis.fetch === pristineFetch, true);
  console.log(`ALL ${passed} CHECKS PASS`);
} finally {
  globalThis.fetch = pristineFetch;
  server.stop(true);
}
