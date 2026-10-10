import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Server timing is authoritative. When an endpoint reports it only at the
// end, show a clearly marked live delivery estimate for the current request.
interface UiRef {
  setStatus: (key: string, text?: string) => void;
  setWorkingMessage: (text?: string) => void;
}
interface PpStats {
  pp: number | null;
  newTokens: number | null;
  cached: number | null;
}
interface RequestStats {
  epoch: number;
  target: string;
  gen: { rate: number; ms: number | null } | null;
  prompt: PpStats | null;
  hasFetchObserver: boolean;
  live: {
    firstAt: number | null;
    frames: number;
    firstTokens: number | null;
    tokens: number | null;
    cumulativeUsage: boolean;
  };
  finished: boolean;
  failed: boolean;
}

const LLAMA_HOST: string | null =
  String((globalThis as Record<string, any>).process?.env?.OMP_LLAMA_HOST ?? "")
    .trim().toLowerCase() || null;
let uiRef: UiRef | null = null;
let hasUI = false;
let ppStats: PpStats | null = null;
// The endpoint and model that produced ppStats. Prompt speed describes that
// server, so it is retained across prompts until a measurement replaces it.
let ppTarget = "";
// The last server-measured generation rate for the current endpoint, held so
// the line never blanks between responses. Cleared by the same switches that
// clear ppTarget.
let genHeld: { rate: number; target: string } | null = null;
let epoch = 0;
let promptActive = false;
let activeModel: { id?: string; baseUrl?: string } | undefined;
let requests: RequestStats[] = [];
// Modern Pi exposes session-scoped provider hooks. Match its payload to the
// fetch request, so title generation and other sessions cannot enter our stats.
let nativeHooks = false;
let nativeRequest: RequestStats | null = null;
let nativePayload: { model?: unknown; messages?: unknown } | null = null;

// Same key pi-token-speed used — pi-token-speed must stay disabled while this
// extension is active, or both would fight over the same status entry.
const STATUS_KEY = "tokenSpeed";

// omp renders one line per setStatus key, sorted by key (localeCompare), with
// no spacer between the transcript and the first status line. A blank entry
// whose key sorts before STATUS_KEY produces the top padding row.
const PAD_KEY = "00-top-pad";
// Last Prompt rate below this threshold renders red.
const SLOW_PROMPT_TPS = 15;
// ...but only once enough new tokens actually ran through the model to make
// the rate a throughput measurement. Slot lookup, cache find and first-batch
// setup cost a fixed amount of time, so a near-full cache hit divides a few
// tokens by mostly-overhead milliseconds and reports a slow server that is
// idle-fast. Below this many new tokens the number stays neutral.
const MEANINGFUL_PROMPT_TOKENS = 100;

// Original pi-token-speed color ladder (stock defaults) for the Gen rate.
const TPS_THRESHOLDS: Array<[number, string]> = [
  [45, "#44ddff"], // blazing
  [30, "#00ff88"], // fast
  [15, "#ffaa00"], // medium
  [0, "#ff4444"],  // slow
];

// ═══════════════════════════════════════════════════════════════
// Formatting
// ═══════════════════════════════════════════════════════════════

// Fixed-width slots. Both omp and pi collapse runs of ASCII spaces in status
// text, so the fill is U+2007 FIGURE SPACE: blank, exactly one digit wide,
// and left alone by their sanitizers.
const FIGURE_SPACE = " ";
const GEN_WIDTH = 5; // 999.9
const PROMPT_WIDTH = 6; // 9999.9
const PCT_WIDTH = 5; // 100.0
const TOKENS_WIDTH = 5; // 33.4K
const PLACEHOLDER = "--";

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * tokens/sec rounded half-up to 0.1 t/s. Computed as one integer division
 * (tokens and microseconds are whole numbers), so a value such as 46.65 rounds
 * to 46.7 — `(x * 10)` or `toFixed` on the float would give 46.6.
 */
function rateTenths(tokens: number, micros: number): number {
  return Math.round((1e7 * tokens) / micros) / 10;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : FIGURE_SPACE.repeat(width - text.length) + text;
}

/** Integer tenths -> "d.d" (exact; no float formatting involved). */
function tenthsText(tenths: number): string {
  return `${Math.floor(tenths / 10)}.${tenths % 10}`;
}

/** Rate with one decimal; a whole number once the decimal would overflow the slot. */
function formatRate(v: number, width: number): string {
  if (!isNum(v) || v < 0) return pad(PLACEHOLDER, width);
  const text = tenthsText(Math.round(v * 10));
  return pad(text.length <= width ? text : String(Math.round(v)), width);
}

/** Integer tenths without a trailing ".0" (2600 -> "2.6", 2000 -> "2"). */
function compactTenths(tenths: number): string {
  return tenths % 10 === 0 ? String(tenths / 10) : tenthsText(tenths);
}

/**
 * Token count: raw below 1000, then K/M with one decimal (trailing .0
 * dropped), whole K/M from 100 up so it always fits TOKENS_WIDTH. Integer
 * division only, so ties round half-up (2650 -> 2.7K, not the float 2.6K).
 */
function formatTokens(n: number): string {
  n = Math.round(n);
  if (n < 1000) return String(n);
  const kTenths = Math.round(n / 100);
  if (kTenths < 1000) return `${compactTenths(kTenths)}K`;
  const k = Math.round(n / 1000);
  if (k < 1000) return `${k}K`;
  const mTenths = Math.round(n / 100_000);
  if (mTenths < 1000) return `${compactTenths(mTenths)}M`;
  return `${Math.round(n / 1_000_000)}M`;
}

function colorHex(text: string, hex: string): string {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return text;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[0m`;
}

function tpsColor(tps: number): string {
  for (const [threshold, hex] of TPS_THRESHOLDS) {
    if (tps >= threshold) return hex;
  }
  return "";
}

/** Thresholds judge the value as displayed, so "15.0" is never red. */
function shown(v: number): number {
  return Math.round(v * 10) / 10;
}

/**
 * Rate slots. `~` marks a live delivery estimate for the response in flight and
 * blinks while it holds; `·` marks a held value from an earlier response on the
 * same endpoint, which stays steady. Both consume a digit of the slot, so the
 * row width never changes. A bare number is the server's own measurement of the
 * current response.
 */
function formatGen(g: { rate: number | null; mode: GenMode }): string {
  if (g.rate === null) return pad(PLACEHOLDER, GEN_WIDTH);
  const mark = g.mode === "estimate" ? (blinkOn ? "~" : FIGURE_SPACE) : g.mode === "held" ? "·" : "";
  const text = mark + formatRate(g.rate, GEN_WIDTH - mark.length);
  return colorHex(text, tpsColor(shown(g.rate)));
}

// Blinking is done by re-rendering, not with the ANSI blink attribute: pi
// rebuilds styles through its theme layer and omp may strip ANSI, and Terminal
// app ignores SGR 5 outright. A toggled character survives all three.
const BLINK_MS = 450;
let blinkOn = true;
let blinkTimer: ReturnType<typeof setTimeout> | null = null;
function syncBlink(mode: GenMode, showing: boolean): void {
  if (mode === "estimate" && showing) {
    blinkTimer ??= setTimeout(() => {
      blinkTimer = null;
      blinkOn = !blinkOn;
      renderStatus(true);
    }, BLINK_MS);
  } else if (blinkTimer) {
    clearTimeout(blinkTimer);
    blinkTimer = null;
    blinkOn = true;
  }
}

function formatPrompt(s: PpStats | null): string {
  const slot = (v: number | null, width: number) =>
    pad(v === null ? PLACEHOLDER : formatTokens(v), width);

  // Fully-cached prompt (nothing ran through the model) or no data: no rate.
  let rate = pad(PLACEHOLDER, PROMPT_WIDTH);
  if (s && s.pp !== null) {
    rate = formatRate(s.pp, PROMPT_WIDTH);
    // An unknown count cannot prove the sample was too small, so it stays
    // eligible: a reported rate this low is worth seeing in red either way.
    const measurable = s.newTokens === null || s.newTokens >= MEANINGFUL_PROMPT_TOKENS;
    if (measurable && shown(s.pp) < SLOW_PROMPT_TPS) rate = colorHex(rate, "#ff4444");
  }

  let pct = PLACEHOLDER;
  if (s && s.newTokens !== null && s.cached !== null && s.newTokens + s.cached > 0) {
    pct = tenthsText(Math.round((1000 * s.cached) / (s.newTokens + s.cached)));
  }

  return (
    `${rate} t/s [Cache ${pad(pct, PCT_WIDTH)}% | ` +
    `${slot(s?.newTokens ?? null, TOKENS_WIDTH)} new / ${slot(s?.cached ?? null, TOKENS_WIDTH)} cached]`
  );
}

function tokenCount(v: unknown): number | null {
  return isNum(v) && Number.isSafeInteger(v) && v >= 0 ? v : null;
}
function positive(v: unknown): number | null {
  return isNum(v) && v > 0 ? v : null;
}

/** Where a displayed generation rate came from. */
type GenMode = "live" | "estimate" | "held";

/** Server rates weighted by server decode duration, with no missing requests. */
function generationRate(): number | null {
  if (!requests.length || requests.some((r) => r.failed || r.gen === null)) return null;
  if (requests.length === 1) return requests[0].gen!.rate;
  let work = 0;
  let ms = 0;
  for (const r of requests) {
    if (r.gen!.ms === null) return null; // an unweighted average would be wrong
    work += r.gen!.rate * r.gen!.ms!;
    ms += r.gen!.ms!;
  }
  return ms > 0 ? work / ms : null;
}

/** Live refers to the current response, not earlier tool round trips. */
function displayedGeneration(): { rate: number | null; mode: GenMode } {
  const active = requests.at(-1);
  if (active && !active.finished && !active.failed) {
    if (active.gen) return { rate: active.gen.rate, mode: "live" };
    const live = active.live;
    if (live.firstAt !== null && live.frames >= 2) {
      // A half-second minimum smooths bursts from a proxy or speculative decode.
      // TTFT is excluded. Nothing is learned from earlier requests or models.
      const ms = Math.max(performance.now() - live.firstAt, 500);
      const n = live.cumulativeUsage && live.tokens !== null && live.firstTokens !== null
        ? live.tokens - live.firstTokens : live.frames - 1;
      if (n > 0) return { rate: 1000 * n / ms, mode: "estimate" };
    }
    // Waiting on this response's first measurement: hold the last real one
    // rather than blanking the line.
    return { rate: heldGeneration(), mode: "held" };
  }
  const rate = generationRate();
  if (rate !== null) return { rate, mode: "live" };
  return { rate: heldGeneration(), mode: "held" };
}

/**
 * The last server-measured rate this endpoint produced. A prompt whose
 * aggregate is unprovable (an unmeasured or failed round trip) keeps whatever
 * was last honest instead of showing nothing.
 */
function heldGeneration(): number | null {
  if (!genHeld) return null;
  const active = requests.at(-1);
  if (active && !sameTarget(genHeld.target, active.target)) return null;
  return genHeld.rate;
}
function holdGeneration(): void {
  const rate = generationRate();
  if (rate !== null) genHeld = { rate, target: requests.at(-1)?.target ?? "" };
}

const RENDER_INTERVAL_MS = 100;
let lastRender = 0;
let renderTimer: ReturnType<typeof setTimeout> | null = null;
function renderStatus(force = false): void {
  if (!uiRef || !hasUI) return;
  const now = Date.now();
  if (!force && now - lastRender < RENDER_INTERVAL_MS) {
    renderTimer ??= setTimeout(() => {
      renderTimer = null;
      renderStatus(true);
    }, RENDER_INTERVAL_MS - (now - lastRender));
    return;
  }
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = null;
  lastRender = now;
  try {
    const gen = displayedGeneration();
    uiRef.setStatus(STATUS_KEY,
      ` ⚡ Gen ${formatGen(gen)} t/s | Last Prompt ${formatPrompt(ppStats)}`);
    syncBlink(gen.mode, gen.rate !== null);
  } catch { syncBlink("live", false); }
}
function current(r: RequestStats): boolean {
  return r.epoch === epoch && requests.includes(r);
}
/** Identity of what a prompt measurement describes; "" when unknowable. */
function targetId(model: unknown, host: string | null): string {
  return host ? `${typeof model === "string" && model ? model : "?"}@${host}` : "";
}
function hostOf(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try { return new URL(baseUrl).host; } catch { return null; }
}
/** An unknown endpoint on either side cannot prove a switch happened. */
function sameTarget(a: string, b: string): boolean {
  return !a || !b || a === b;
}

/**
 * The newest request owns the Last Prompt slot. Its measurement replaces the
 * displayed one; until a measurement arrives the previous one stays visible,
 * because llama.cpp-class servers report prompt timings on the terminal chunk
 * and a blank slot would otherwise flicker for all of prefill and generation.
 * Numbers from a different server or model are not predecessors.
 */
function applyPrompt(r: RequestStats): void {
  if (requests.at(-1) !== r) return;
  if (r.prompt) {
    ppStats = r.prompt;
    ppTarget = r.target;
    return;
  }
  if (ppStats && !sameTarget(ppTarget, r.target)) {
    ppStats = null;
    ppTarget = "";
  }
}

/**
 * A model or endpoint switch invalidates the retained measurement as soon as
 * the host reports the new model, before its number can be shown as though it
 * described the new server.
 */
function retargetPrompt(): void {
  const next = targetId(activeModel?.id, hostOf(activeModel?.baseUrl));
  if ((ppStats && !sameTarget(ppTarget, next)) || (genHeld && !sameTarget(genHeld.target, next))) {
    ppStats = null;
    ppTarget = "";
    genHeld = null;
  }
}

function newRequest(target = ""): RequestStats {
  const r: RequestStats = {
    epoch, target, gen: null, prompt: null, finished: false, failed: false, hasFetchObserver: false,
    live: { firstAt: null, frames: 0, firstTokens: null, tokens: null, cumulativeUsage: false },
  };
  requests.push(r);
  renderStatus(true);
  return r;
}
function clearWorking(): void {
  try { if (hasUI) uiRef?.setWorkingMessage(); } catch {}
}
function reset(): void {
  epoch++;
  requests = [];
  nativeRequest = null;
  nativePayload = null;
  if (renderTimer) clearTimeout(renderTimer);
  renderTimer = null;
  if (blinkTimer) clearTimeout(blinkTimer);
  blinkTimer = null;
  blinkOn = true;
  clearWorking();
}
/** A new session can point at another server and model, so nothing carries over. */
function newSession(): void {
  reset();
  ppStats = null;
  ppTarget = "";
  genHeld = null;
}

function isLocalHost(hostname: string): boolean {
  const name = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    name === "localhost" ||
    name.endsWith(".localhost") ||
    name.endsWith(".local") ||
    name === "0.0.0.0" ||
    name === "::1" ||
    /^127\./.test(name) ||
    /^10\./.test(name) ||
    /^192\.168\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(name) ||
    /^169\.254\./.test(name) || // link-local
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(name) || // 100.64/10 (CGNAT, Tailscale)
    /^f[cd][0-9a-f]{2}:/.test(name) || // IPv6 unique local fc00::/7
    /^fe[89ab][0-9a-f]:/.test(name) // IPv6 link-local fe80::/10
  );
}

/** The request's host when it is a llama-host chat completion, else null. */
function llamaHost(input: RequestInfo | URL): string | null {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  if (typeof raw !== "string" || !raw.includes("/chat/completions")) return null;

  try {
    const url = new URL(raw);
    const match = LLAMA_HOST ? url.host === LLAMA_HOST : isLocalHost(url.hostname);
    return match ? url.host : null;
  } catch {
    return null;
  }
}

/** Copy the body and options: never mutate a caller's RequestInit. */
function enableProgress(payload: Record<string, any>): Record<string, any> {
  return {
    ...payload,
    return_progress: true,
    timings_per_token: true,
    stream_options: { ...payload.stream_options, include_usage: true, continuous_usage_stats: true },
  };
}
function parsePayload(body: unknown): Record<string, any> | null {
  if (typeof body !== "string") return null;
  try {
    const value = JSON.parse(body);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

function generatedFrame(chunk: any): boolean {
  // One wire frame can split into multiple Pi UI events. Count it once, and
  // exclude role-only, usage-only, finish, and empty tool-call metadata frames.
  return Array.isArray(chunk.choices) && chunk.choices.some((c: any) => {
    const d = c?.delta;
    if (!d || typeof d !== "object") return false;
    if ([d.content, d.reasoning_content, d.reasoning, d.reasoning_text]
      .some((v) => typeof v === "string" && v.length > 0)) return true;
    return Array.isArray(d.tool_calls) && d.tool_calls.some((t: any) =>
      typeof t?.function?.arguments === "string" && t.function.arguments.length > 0 ||
      typeof t?.custom?.input === "string" && t.custom.input.length > 0);
  });
}

/** Timings are cumulative per request. Replace snapshots; never add them. */
function observe(r: RequestStats, chunk: any): void {
  if (!current(r) || r.finished || !chunk || typeof chunk !== "object") return;
  if (generatedFrame(chunk)) {
    const live = r.live;
    const now = performance.now();
    live.firstAt ??= now;
    live.frames++;
    const tokens = tokenCount(chunk.usage?.completion_tokens);
    if (tokens !== null && tokens > 0) {
      if (!live.cumulativeUsage || live.tokens === null || tokens < live.tokens) {
        // Anchor a fresh counter interval if usage first appears mid-response
        // or a malformed server counter regresses. Never sum cumulative usage.
        live.firstAt = now;
        live.frames = 1;
        live.firstTokens = tokens;
      }
      live.cumulativeUsage = true;
      live.tokens = tokens;
    } else if (live.cumulativeUsage) {
      // Partial usage forwarding must not freeze the numerator while output
      // keeps arriving. Start a fresh, explicitly approximate frame interval.
      live.cumulativeUsage = false;
      live.firstTokens = null;
      live.tokens = null;
      live.firstAt = now;
      live.frames = 1;
    }
  }
  const t = chunk.timings;
  if (t && typeof t === "object") {
    if ("predicted_per_second" in t || "predicted_n" in t || "predicted_ms" in t) {
      // The server owns the n versus n-1 convention (it varies by build).
      // Copy its rate rather than trying to reconstruct that convention.
      const rate = positive(t.predicted_per_second);
      const count = tokenCount(t.predicted_n);
      r.gen = rate !== null && count !== 0
        ? { rate, ms: positive(t.predicted_ms) } : null;
    }
    if ("prompt_n" in t || "prompt_per_second" in t || "prompt_ms" in t || "cache_n" in t) {
      const n = tokenCount(t.prompt_n);
      const cache = tokenCount(t.cache_n);
      const ms = positive(t.prompt_ms);
      const rate = positive(t.prompt_per_second);
      r.prompt = {
        pp: n === 0 ? null : rate ?? (n !== null && ms !== null ? rateTenths(n, ms * 1000) : null),
        newTokens: n,
        cached: cache,
      };
    }
  }
  // Usage can establish counts, but it cannot establish decode or prefill time.
  const u = chunk.usage;
  if (u && typeof u === "object") {
    const total = tokenCount(u.prompt_tokens);
    const cache = tokenCount(u.prompt_tokens_details?.cached_tokens);
    if (total !== null && cache !== null && cache <= total) {
      r.prompt ??= { pp: null, newTokens: total - cache, cached: cache };
    }
  }
  // Prefill progress is a measurement, not only a progress bar. llama.cpp
  // reports `timings` on the terminal chunk, so without this the finished
  // prefill would stay unpublished until the whole response streamed out.
  if (chunk.prompt_progress) {
    const p = chunk.prompt_progress;
    const processed = tokenCount(p.processed);
    const cached = tokenCount(p.cache);
    const total = tokenCount(p.total);
    const ms = positive(p.time_ms);
    if (processed !== null && cached !== null && total !== null &&
        cached <= processed && processed <= total) {
      const n = processed - cached;
      if (processed < total) {
        // Live view only: an unfinished prefill is not a throughput sample.
        if (hasUI && uiRef) {
          const pct = Math.floor(100 * n / (total - cached));
          const rate = n > 0 && ms !== null ? formatRate(rateTenths(n, ms * 1000), PROMPT_WIDTH)
            : pad(PLACEHOLDER, PROMPT_WIDTH);
          try { uiRef.setWorkingMessage(`Prefilling... ${pad(String(pct), 2)}% · ${rate} t/s`); } catch {}
        }
      } else {
        // The prefill is complete, so publish it now: Last Prompt is then ready
        // before the first token. The server's own prompt rate still wins when
        // its terminal timings arrive, because it owns that timer.
        const rate = n > 0 && ms !== null ? rateTenths(n, ms * 1000) : null;
        if (!r.prompt || (r.prompt.pp === null && rate !== null)) {
          r.prompt = { pp: rate, newTokens: n, cached: cached };
        }
        if (hasUI && uiRef) { try { uiRef.setWorkingMessage(); } catch {} }
      }
    }
  }
  applyPrompt(r);
  renderStatus();
}
function finish(r: RequestStats, failed = false): void {
  if (!current(r) || r.finished) return;
  r.finished = true;
  r.failed = failed;
  if (failed) {
    r.gen = null;
    // Decode that stopped early measured nothing useful, but a prefill that
    // reported completion did: it happened, on this server, for that long. An
    // unmeasured or partial prompt is still dropped.
    if (!r.prompt || r.prompt.pp === null) r.prompt = null;
  }
  applyPrompt(r);
  if (requests.at(-1) === r) clearWorking();
  holdGeneration();
  renderStatus(true);
}

/** Parse SSE independently, forwarding the original bytes and cancellation. */
function capture(body: ReadableStream<Uint8Array>, r: RequestStats): ReadableStream<Uint8Array> {
  r.hasFetchObserver = true;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const dispatch = () => {
    const raw = data.join("\n").trim();
    data = [];
    if (!raw) return;
    if (raw === "[DONE]") { finish(r); return; }
    try { observe(r, JSON.parse(raw)); } catch {} // telemetry never breaks generation
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith("data:")) data.push(value.slice(5).replace(/^ /, ""));
  };
  const feed = (value: string, eof = false) => {
    buffer += value;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      line(buffer.slice(0, end).replace(/\r$/, ""));
      buffer = buffer.slice(end + 1);
    }
    if (eof) {
      if (buffer) line(buffer.replace(/\r$/, ""));
      buffer = "";
      dispatch();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          try { feed(decoder.decode(), true); } catch {}
          finish(r);
          controller.close();
        } else {
          try { feed(decoder.decode(value, { stream: true })); } catch {}
          controller.enqueue(value);
        }
      } catch (error) {
        finish(r, true);
        controller.error(error);
      }
    },
    cancel(reason) { finish(r, true); return reader.cancel(reason); },
  });
}

export default function (pi: ExtensionAPI) {
  const globalState = globalThis as Record<PropertyKey, unknown>;
  const key = "llama-pp-persistent/loaded";
  if (globalState[key]) return;
  globalState[key] = true;
  const originalFetch = globalThis.fetch;
  const patched = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const host = promptActive ? llamaHost(input) : null;
    if (host === null) return originalFetch(input, init);
    const request = input instanceof Request ? input : null;
    const payload = parsePayload(init?.body ?? (request ? await request.clone().text() : null));
    if (!payload?.stream || (payload.n !== undefined && payload.n !== 1)) return originalFetch(input, init);
    let r: RequestStats;
    if (nativeHooks) {
      if (!nativeRequest || !nativePayload || payload.model !== nativePayload.model ||
          JSON.stringify(payload.messages) !== JSON.stringify(nativePayload.messages)) {
        return originalFetch(input, init);
      }
      r = nativeRequest;
      if (!r.target) r.target = targetId(payload.model, host);
    } else {
      // Legacy hosts lack session-scoped provider callbacks. Restrict their
      // hook to the active model and endpoint whenever the context supplies it.
      if (activeModel?.id && payload.model !== activeModel.id) return originalFetch(input, init);
      if (activeModel?.baseUrl) {
        const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        try {
          const endpoint = new URL(activeModel.baseUrl);
          const url = new URL(raw);
          if (url.origin !== endpoint.origin || !url.pathname.startsWith(endpoint.pathname.replace(/\/$/, "") + "/")) {
            return originalFetch(input, init);
          }
        } catch { return originalFetch(input, init); }
      }
      r = newRequest(targetId(payload.model, host));
    }
    const nextInit = { ...init, body: JSON.stringify(enableProgress(payload)) };
    try {
      const response = await originalFetch(input, nextInit);
      if (response.ok && response.body && response.headers.get("content-type")?.includes("text/event-stream")) {
        return new Response(capture(response.body, r), {
          status: response.status, statusText: response.statusText, headers: new Headers(response.headers),
        });
      }
      finish(r, true);
      return response;
    } catch (error) { finish(r, true); throw error; }
  };
  globalThis.fetch = patched;

  pi.on("session_start", (_event, ctx) => {
    uiRef = ctx.ui;
    hasUI = ctx.hasUI;
    promptActive = false;
    activeModel = ctx.model;
    newSession();
    renderStatus(true);
    if (hasUI) ctx.ui.setStatus(PAD_KEY, " ");
  });
  pi.on("before_agent_start", (_event, ctx) => {
    uiRef = ctx.ui;
    hasUI = ctx.hasUI;
    activeModel = ctx.model;
    reset();
    retargetPrompt();
    promptActive = true;
    renderStatus(true);
    if (hasUI) ctx.ui.setStatus(PAD_KEY, " ");
  });
  pi.on("before_provider_request", (event) => {
    if (!promptActive) return;
    nativeHooks = true;
    const payload = event.payload;
    nativePayload = payload && typeof payload === "object" ? payload : null;
    nativeRequest = newRequest(targetId((nativePayload as { model?: unknown } | null)?.model,
      hostOf(activeModel?.baseUrl)));
    if (nativePayload && (nativePayload as { stream?: boolean }).stream && activeModel?.baseUrl &&
        llamaHost(`${activeModel.baseUrl.replace(/\/$/, "")}/chat/completions`) !== null) {
      const next = enableProgress(nativePayload);
      nativePayload = next;
      return next; // Pi's callback returns the payload itself, not { payload }.
    }
  });
  pi.on("provider_stream_event", (event) => {
    if (nativeRequest && promptActive && !nativeRequest.hasFetchObserver) {
      if (activeModel?.id && event.model !== activeModel.id) return;
      try { observe(nativeRequest, event.data); } catch {}
    }
  });
  pi.on("message_end", (event) => {
    const message = event.message;
    if (message.role === "assistant" && nativeRequest) {
      finish(nativeRequest, message.stopReason === "error" || message.stopReason === "aborted");
    }
  });
  pi.on("agent_end", (event) => {
    // omp may emit agent_end mid-prompt. Measurements are request-scoped,
    // so neither full-session usage nor toolResult usage is ever reconciled.
    const messages = event.messages ?? [];
    const last = [...messages].reverse().find((m) => m.role === "assistant");
    const continuing = (event as { willContinue?: boolean }).willContinue === true ||
      (last?.role === "assistant" && last.stopReason !== "aborted" && last.stopReason !== "error" &&
       last.content.some((c) => c.type === "toolCall"));
    if (!continuing) {
      promptActive = false;
      for (const r of requests) if (!r.finished) finish(r, true);
    }
    renderStatus(true);
  });
  pi.on("turn_end", (_event, ctx) => { if (ctx.hasUI) ctx.ui.setWorkingMessage(); });
  pi.on("session_shutdown", () => {
    promptActive = false;
    newSession();
    if (globalThis.fetch === patched) {
      globalThis.fetch = originalFetch;
      delete globalState[key];
    }
    // If a later extension still calls this wrapper, retain the guard: a
    // re-registration must not put two observers into that wrapper chain.
  });
}
