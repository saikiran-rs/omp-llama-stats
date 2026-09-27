import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Unified speed stats for omp: one status line:
//
//   ⚡ Gen <rate> t/s | Last Prompt <rate> t/s [Cache <pct>% | <n> new / <c> cached]
//
//  - Gen: generation tokens/sec. Live: 1s sliding-window estimate (ported
//    from pi-token-speed@0.7.1). Final: llama.cpp's own decode timing
//    (`timings.predicted_n - 1` / `predicted_ms`) summed per prompt, else the
//    stream-derived decode interval, else a wall-clock average
//  - Last Prompt: prompt-processing tokens/sec from llama.cpp SSE
//    progress/timings — per-request, never a rolling average
//
// Every value sits in a fixed-width slot so the line never changes length.
//
// omp renders one footer line per setStatus key, so both metrics must share
// a single key to appear on one line.

// ═══════════════════════════════════════════════════════════════
// Event payload shapes (subset used, mirrors pi-token-speed EventManager)
// ═══════════════════════════════════════════════════════════════

interface ToolCallContent {
  type?: string;
  name?: string;
}

interface AssistantMessageEventPayload {
  type: string;
  delta?: string;
  partial?: {
    content?: ToolCallContent[];
    usage?: { output?: number };
  };
  contentIndex?: number;
}

interface MessageUpdateEvent {
  assistantMessageEvent?: AssistantMessageEventPayload;
}

interface AgentEndMessage {
  role: string;
  content?: ToolCallContent[];
  usage?: { output?: number };
}

interface AgentEndEvent {
  messages?: AgentEndMessage[];
  willContinue?: boolean;
}

/** The slice of the extension UI this extension drives. */
interface UiRef {
  theme?: { fg?: (kind: string, text: string) => string };
  setStatus: (key: string, text?: string) => void;
  setWorkingMessage: (text?: string) => void;
}

// ═══════════════════════════════════════════════════════════════
// TPS engine (port of pi-token-speed; divergences noted in the README)
// ═══════════════════════════════════════════════════════════════

const SLIDING_WINDOW_MS = 1000;
const MIN_SLIDING_WINDOW_MS = 100;
const COMPACTION_THRESHOLD = 5000;

class SlidingWindow {
  private readonly events: { time: number; tokens: number }[] = [];
  private windowStartIndex = 0;
  // Deltas recorded since the last reset (compaction does not lower it).
  private recorded = 0;

  constructor(private readonly windowMs: number) {}

  record(tokens: number): void {
    this.events.push({ time: Date.now(), tokens });
    this.recorded++;
    if (this.windowStartIndex >= COMPACTION_THRESHOLD) this.compact();
  }

  /** Live rate, or null until two deltas exist to span an interval. */
  getTps(now: number): number | null {
    if (this.recorded < 2) return null;

    // N tokens span N-1 complete generation intervals; the oldest in-window
    // token anchors the span, so count only tokens after it.
    const windowStart = now - this.windowMs;
    while (
      this.windowStartIndex < this.events.length &&
      this.events[this.windowStartIndex].time < windowStart
    ) {
      this.windowStartIndex++;
    }
    // A stalled stream decays to 0 instead of pinning the last value.
    if (this.events.length - this.windowStartIndex < 2) return 0;

    let windowTokenCount = 0;
    for (let i = this.windowStartIndex + 1; i < this.events.length; i++) {
      windowTokenCount += this.events[i].tokens;
    }
    if (windowTokenCount === 0) return 0;

    const span = Math.max(now - this.events[this.windowStartIndex].time, MIN_SLIDING_WINDOW_MS);
    return (1000 * windowTokenCount) / span;
  }

  private compact(): void {
    if (this.windowStartIndex === 0) return;
    this.events.splice(0, this.windowStartIndex);
    this.windowStartIndex = 0;
  }

  reset(): void {
    this.events.length = 0;
    this.windowStartIndex = 0;
    this.recorded = 0;
  }
}

class TpsEngine {
  private _isStreaming = false;
  private _isPaused = false;
  private _tokenCount = 0;
  private _firstDeltaAt = 0;
  private _firstDeltaTokens = 0;
  private _lastDeltaAt = 0;
  private _startPause = 0;
  private _pausedMs = 0;
  private _tokenScale = 1;
  private readonly _slidingWindow = new SlidingWindow(SLIDING_WINDOW_MS);

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  /** Tokens are flowing: streaming and not paused for a tool. */
  get isLive(): boolean {
    return this._isStreaming && !this._isPaused;
  }

  /**
   * Sliding-window rate while tokens are flowing. Null when not live (tool
   * execution / next prefill is not generation) or before two deltas exist —
   * never a fake 0 at the start of a stream. Computed at read time, so a
   * stalled stream decays toward 0 instead of pinning.
   */
  get liveTps(): number | null {
    if (!this.isLive) return null;
    return this._slidingWindow.getTps(Date.now());
  }

  /**
   * Average decode rate over the streamed deltas: the tokens after the first
   * delta over first-delta -> last-delta time, minus the pauses between them
   * (the same n-1 interval rule as the server-side paths). Null until the
   * interval spans MIN_SLIDING_WINDOW_MS, so a few deltas can't spike it.
   */
  get tpsAvg(): number | null {
    const ms = this._lastDeltaAt - this._firstDeltaAt - this._pausedMs;
    const tokens = this._tokenCount - this._firstDeltaTokens;
    return this._firstDeltaAt > 0 && ms >= MIN_SLIDING_WINDOW_MS && tokens > 0
      ? (1000 * tokens) / ms
      : null;
  }

  start(): void {
    if (this._isStreaming) return;
    this._isStreaming = true;
    this._tokenCount = 0;
    this._firstDeltaAt = 0;
    this._firstDeltaTokens = 0;
    this._lastDeltaAt = 0;
    this._slidingWindow.reset();
    this._pausedMs = 0;
    // A pause left open by the previous prompt must not leak into this one.
    this._isPaused = false;
    this._startPause = 0;
  }

  stop(): void {
    // An open pause began after the last delta: outside the measured
    // interval, so it is dropped, not subtracted.
    this._isPaused = false;
    this._isStreaming = false;
    this._slidingWindow.reset();
  }

  pause(): void {
    // Ignore re-pause (parallel tool calls) and pauses outside streaming.
    if (!this._isStreaming || this._isPaused) return;
    this._isPaused = true;
    this._startPause = Date.now();
  }

  /**
   * One delta event. NOT one token: engines batch a variable number of tokens
   * into each SSE chunk (llama.cpp sends 1, vLLM measured at 2.1-2.5), so a
   * "1 token per delta" count reads low by exactly that factor on any engine
   * that batches. `tokenScale` is the ratio learned from the previous
   * completed response on this endpoint; it defaults to 1, which is the old
   * behaviour and is correct for llama.cpp.
   */
  recordDelta(): void {
    if (!this._isStreaming) return;
    const now = Date.now();
    if (this._isPaused) {
      this._isPaused = false;
      // A pause ended by a delta lies between two deltas: exclude it.
      if (this._firstDeltaAt > 0) this._pausedMs += now - this._startPause;
      // The window must not span the pause either, or the first live reading
      // after it would divide fresh tokens by the dead time.
      this._slidingWindow.reset();
    }
    const tokens = this._tokenScale;
    if (this._firstDeltaAt === 0) {
      this._firstDeltaAt = now;
      this._firstDeltaTokens = tokens;
    }
    this._lastDeltaAt = now;
    this._tokenCount += tokens;
    this._slidingWindow.record(tokens);
  }

  /** Tokens per streamed delta, learned from a completed response. */
  setTokenScale(scale: number): void {
    if (Number.isFinite(scale) && scale > 0) this._tokenScale = scale;
  }

  reconcileTotal(tokens: number): void {
    if (tokens > 0) this._tokenCount = tokens;
  }
}

// ═══════════════════════════════════════════════════════════════
// Shared state
// ═══════════════════════════════════════════════════════════════

let originalFetch: typeof fetch | null = null;
let uiRef: UiRef | null = null;
let hasUI = false;
// Explicit pin for the llama.cpp host (e.g. "127.0.0.1:8080") when proxying;
// without it, only local/private hosts are treated as llama.cpp.
const LLAMA_HOST: string | null =
  String((globalThis as Record<string, any>).process?.env?.OMP_LLAMA_HOST ?? "")
    .trim()
    .toLowerCase() || null;

const engine = new TpsEngine();

interface PpStats {
  /** prompt tokens/sec, per-request; null when nothing was processed */
  pp: number | null;
  /** uncached prompt tokens (`timings.prompt_n`); null when unknown */
  newTokens: number | null;
  /** cached prompt tokens (`timings.cache_n`); null when the server does not say */
  cached: number | null;
}

let ppStats: PpStats | null = null;
// Exact generation timing from llama.cpp `timings.predicted_n` /
// `predicted_ms`, accumulated across the requests of one user prompt
// (reset in before_agent_start): decode steps and microseconds.
let tgAccum = { n: 0, us: 0 };
// Engine-agnostic generation timing, derived from the SSE stream itself for
// servers that report no `timings` block (vLLM, SGLang, TGI, hosted APIs...).
// tokens come from `usage.completion_tokens`; the interval is first-content
// delta -> last-content delta, so PREFILL/TTFT is excluded. Without this the
// only fallback was tokens/wall-clock, which at a 10K prompt measured 5.6 t/s
// against a real 50.0 because TTFT dominated the denominator.
let genericTg = { tokens: 0, us: 0 };
// Tokens per streamed delta event, learned per host from its last completed
// response and fed to the live estimate. 1 = llama.cpp; vLLM measured 2.1-2.5.
const tokensPerDelta = new Map<string, number>();
// Warn once per process when a llama.cpp build predates `timings.cache_n`.
let warnedMissingCacheN = false;

// Same key pi-token-speed used — pi-token-speed must stay disabled while this
// extension is active, or both would fight over the same status entry.
const STATUS_KEY = "tokenSpeed";

// omp renders one line per setStatus key, sorted by key (localeCompare), with
// no spacer between the transcript and the first status line. A blank entry
// whose key sorts before STATUS_KEY produces the top padding row.
const PAD_KEY = "00-top-pad";
// Last Prompt rate below this threshold renders red.
const SLOW_PROMPT_TPS = 15;

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

function formatGen(tps: number | null): string {
  if (tps === null) return pad(PLACEHOLDER, GEN_WIDTH);
  return colorHex(formatRate(tps, GEN_WIDTH), tpsColor(shown(tps)));
}

function formatPrompt(s: PpStats | null): string {
  const slot = (v: number | null, width: number) =>
    pad(v === null ? PLACEHOLDER : formatTokens(v), width);

  // Fully-cached prompt (nothing ran through the model) or no data: no rate.
  let rate = pad(PLACEHOLDER, PROMPT_WIDTH);
  if (s && s.pp !== null) {
    rate = formatRate(s.pp, PROMPT_WIDTH);
    if (shown(s.pp) < SLOW_PROMPT_TPS) rate = colorHex(rate, "#ff4444");
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

/** Settled Gen for the current prompt from server-side or stream timing. */
function settledTps(): number | null {
  if (tgAccum.n > 0 && tgAccum.us > 0) return rateTenths(tgAccum.n, tgAccum.us);
  if (genericTg.tokens > 0 && genericTg.us > 0) return rateTenths(genericTg.tokens, genericTg.us);
  return null;
}

const RENDER_INTERVAL_MS = 100;
let lastRender = 0;
let renderTimer: ReturnType<typeof setTimeout> | null = null;

function renderStatus(force = false): void {
  if (!uiRef || !hasUI) return;

  // Throttle per-token repaints; a trailing flush keeps the final value fresh.
  const now = Date.now();
  if (!force && now - lastRender < RENDER_INTERVAL_MS) {
    renderTimer ??= setTimeout(() => {
      renderTimer = null;
      renderStatus(true);
    }, RENDER_INTERVAL_MS - (now - lastRender));
    return;
  }

  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
  lastRender = now;

  // While tokens flow, the live estimate is the only in-flight source (the
  // prompt's settled rate so far stands in until it has two deltas).
  // Otherwise (paused between requests, or the prompt is over) the settled
  // rate, best source first:
  //   1. llama.cpp's own decode timing (exact, server-side)
  //   2. stream-derived decode interval + usage tokens (any OpenAI-compatible
  //      engine; excludes prefill, so it is not the old wall-clock average)
  //   3. the engine's delta-interval average, reconciled to usage at prompt
  //      end (a provider the fetch hook does not see)
  const tps = engine.isLive
    ? engine.liveTps ?? settledTps()
    : settledTps() ?? engine.tpsAvg;
  uiRef.setStatus(STATUS_KEY, ` ⚡ Gen ${formatGen(tps)} t/s | Last Prompt ${formatPrompt(ppStats)}`);
}

// ═══════════════════════════════════════════════════════════════
// llama.cpp SSE hook
// ═══════════════════════════════════════════════════════════════

// Local/private match per request so a cloud provider (or a proxy fronting
// one) never gets `return_progress` injected — OpenAI 400s on it.
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

function enableProgress(init?: RequestInit): void {
  try {
    if (!init?.body || typeof init.body !== "string") return;

    const body = JSON.parse(init.body);

    if (body.stream) {
      body.return_progress = true;
      body.stream_options ??= {};
      body.stream_options.include_usage = true;
    }

    init.body = JSON.stringify(body);
  } catch {}
}

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" ? v.length > 0 : Array.isArray(v) && v.length > 0;
}

interface LlamaTimings {
  prompt_n?: number;
  prompt_ms?: number;
  prompt_per_second?: number;
  cache_n?: number;
  predicted_n?: number;
  predicted_ms?: number;
}

/** Last Prompt stats from a llama.cpp `timings` block, or null if it has none. */
function llamaPrompt(t: LlamaTimings): PpStats | null {
  if (!isNum(t.prompt_n)) return null;
  if (!isNum(t.cache_n) && !warnedMissingCacheN) {
    warnedMissingCacheN = true;
    console.warn(
      "[omp-llama-stats] llama.cpp timings.cache_n missing (older build?) — cache stats will read as unknown",
    );
  }
  let pp: number | null = null;
  if (t.prompt_n > 0) {
    // prompt_n / prompt_ms is exactly llama.cpp's prompt_per_second, but from
    // integers (prompt_ms is whole microseconds / 1000), so rounding is exact.
    if (isNum(t.prompt_ms) && t.prompt_ms > 0) pp = rateTenths(t.prompt_n, Math.round(t.prompt_ms * 1000));
    else if (isNum(t.prompt_per_second)) pp = t.prompt_per_second;
  }
  return { pp, newTokens: t.prompt_n, cached: isNum(t.cache_n) ? t.cache_n : null };
}

function capture(
  body: ReadableStream<Uint8Array>,
  requestStart: number,
  host: string,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  // Engine-agnostic per-response accounting. Every OpenAI-compatible server
  // gives us content deltas and (with stream_options.include_usage) a final
  // usage block, so these work without any server-specific fields.
  let firstContentAt = 0;
  let lastContentAt = 0;
  let deltaEvents = 0;
  let timings: LlamaTimings | null = null;
  let usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null = null;
  let finalized = false;

  // Called once when the stream ends ([DONE], or close without one). The
  // last `timings` block wins, so a server that repeats it (e.g. with
  // timings_per_token) is still counted exactly once.
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    const u = usage;
    const completion = u && isNum(u.completion_tokens) ? u.completion_tokens : 0;

    // Gen. llama.cpp: the first token is free — it comes from the last prompt
    // batch's logits — so predicted_ms spans predicted_n - 1 decode steps
    // (llama.cpp's own predicted_per_second divides the same way).
    if (timings && isNum(timings.predicted_n) && isNum(timings.predicted_ms)) {
      if (timings.predicted_n > 1 && timings.predicted_ms > 0) {
        tgAccum.n += timings.predicted_n - 1;
        tgAccum.us += Math.round(timings.predicted_ms * 1000);
      }
    } else if (completion > 1 && lastContentAt > firstContentAt) {
      // Same n-1 rule: the interval runs from the first content delta to the
      // last, one fewer gap than there are tokens.
      genericTg.tokens += completion - 1;
      genericTg.us += (lastContentAt - firstContentAt) * 1000;
    }

    if (deltaEvents > 0 && completion > 0) {
      tokensPerDelta.set(host, completion / deltaEvents);
    }

    // Last Prompt. llama.cpp's exact numbers win; otherwise tokens processed
    // over TTFT. Only uncached tokens count when the server reports the cache
    // split; without it the whole prompt counts, an EFFECTIVE rate that an
    // unreported prefix-cache hit inflates.
    const llama = timings ? llamaPrompt(timings) : null;
    if (llama) {
      ppStats = llama;
    } else if (u && isNum(u.prompt_tokens) && u.prompt_tokens > 0 && firstContentAt > requestStart) {
      const reported = u.prompt_tokens_details?.cached_tokens;
      const cached = isNum(reported) ? reported : null;
      const newTokens = cached === null ? null : Math.max(0, u.prompt_tokens - cached);
      const processed = newTokens ?? u.prompt_tokens;
      ppStats = {
        pp: processed > 0 ? rateTenths(processed, (firstContentAt - requestStart) * 1000) : null,
        newTokens,
        cached,
      };
    }
    renderStatus(true);
  };

  const handleLine = (line: string) => {
    // SSE field "data:" with an optional space; trim() also drops a CR.
    if (!line.startsWith("data:")) return;
    const raw = line.slice(5).trim();
    if (!raw) return;
    if (raw === "[DONE]") {
      finalize();
      return;
    }

    try {
      const chunk = JSON.parse(raw);

      // Generated content marks the decode interval: text, reasoning and
      // tool-call arguments alike (usage.completion_tokens counts all three).
      // Counted the way the host turns a chunk into delta events — one per
      // text, one per reasoning, one per tool-call entry — so the learned
      // tokens-per-delta matches what recordDelta() sees.
      const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
      for (const c of choices) {
        const d = c?.delta;
        if (!d || typeof d !== "object") continue;
        let events = 0;
        if (nonEmpty(d.content)) events++;
        if (nonEmpty(d.reasoning_content) || nonEmpty(d.reasoning) || nonEmpty(d.reasoning_text)) events++;
        if (Array.isArray(d.tool_calls)) events += d.tool_calls.length;
        if (events > 0) {
          const now = Date.now();
          if (firstContentAt === 0) firstContentAt = now;
          lastContentAt = now;
          deltaEvents += events;
        }
      }
      if (chunk.usage && typeof chunk.usage === "object") usage = chunk.usage;
      if (chunk.timings && typeof chunk.timings === "object") timings = chunk.timings;

      // Live prefill display
      if (chunk.prompt_progress && uiRef && hasUI) {
        const p = chunk.prompt_progress;
        const processed = isNum(p.processed) ? p.processed : 0;
        const cached = isNum(p.cache) ? p.cache : 0;
        const total = isNum(p.total) ? p.total : 0;
        const ms = isNum(p.time_ms) ? p.time_ms : 0;

        const newTokens = Math.max(0, processed - cached);
        const totalNew = Math.max(0, total - cached);

        if (processed < total) {
          // Floor, so 100% only ever means done.
          const pct = totalNew > 0 ? Math.floor((100 * newTokens) / totalNew) : 0;
          const rate =
            newTokens > 0 && ms > 0
              ? formatRate(rateTenths(newTokens, Math.round(ms * 1000)), PROMPT_WIDTH)
              : pad(PLACEHOLDER, PROMPT_WIDTH);
          uiRef.setWorkingMessage(`Prefilling... ${pad(String(pct), 2)}% · ${rate} t/s`);
        } else {
          uiRef.setWorkingMessage();
        }
      }
    } catch {}
  };

  // Stats must never break the stream the agent is reading.
  const observe = (fn: () => void) => {
    try {
      fn();
    } catch {}
  };

  // Pull-based: the consumer drives the pace (backpressure), and cancel
  // propagates so a torn-down stream can't reject an already-settled one.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        observe(() => {
          // A last line without a trailing newline is still a line.
          buffer += decoder.decode();
          if (buffer) handleLine(buffer);
          buffer = "";
          // Some servers close without a [DONE] sentinel.
          finalize();
        });
        controller.close();
        return;
      }

      observe(() => {
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });

      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

// ═══════════════════════════════════════════════════════════════
// Extension
// ═══════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  const globalState = globalThis as Record<PropertyKey, unknown>;
  const key = "llama-pp-persistent/loaded";

  if (globalState[key]) return;
  globalState[key] = true;

  originalFetch = globalThis.fetch;

  const patched = async (input: RequestInfo | URL, init?: RequestInit) => {
    const host = llamaHost(input);
    if (host === null) {
      return originalFetch!(input, init);
    }

    enableProgress(init);
    // Tokens per delta differ per engine: use this host's learned ratio.
    engine.setTokenScale(tokensPerDelta.get(host) ?? 1);

    const requestStart = Date.now();
    const response = await originalFetch!(input, init);

    if (response.ok && response.body) {
      return new Response(capture(response.body, requestStart, host), {
        status: response.status,
        statusText: response.statusText,
        headers: new Headers(response.headers),
      });
    }

    return response;
  };
  globalThis.fetch = patched;

  pi.on("session_start", (_event, ctx) => {
    uiRef = ctx.ui;
    hasUI = ctx.hasUI;
    if (hasUI) {
      renderStatus(true);
      ctx.ui.setStatus(PAD_KEY, " ");
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    uiRef = ctx.ui;
    hasUI = ctx.hasUI;
    // New user prompt: every accumulator starts fresh. A run that ended
    // mid-tool-call (e.g. aborted) never saw its final agent_end, so the
    // engine may still be running — it must not carry into this prompt.
    tgAccum = { n: 0, us: 0 };
    genericTg = { tokens: 0, us: 0 };
    if (engine.isStreaming) engine.stop();
    if (hasUI) {
      ctx.ui.setStatus(PAD_KEY, " ");
    }
  });

  // Streaming lifecycle (ported from pi-token-speed EventManager)
  pi.on("message_update", (event: MessageUpdateEvent) => {
    const ev = event.assistantMessageEvent;
    if (!ev) return;

    if (
      ev.type === "text_start" ||
      ev.type === "thinking_start" ||
      ev.type === "toolcall_start"
    ) {
      engine.start();
      renderStatus();
      return;
    }

    if (ev.type === "text_delta" || ev.type === "thinking_delta") {
      engine.recordDelta();
      renderStatus();
      return;
    }

    if (ev.type === "toolcall_delta") {
      // Count all tool-call argument tokens: usage.output includes them, so
      // the counted total and the clock must agree on what was generated.
      engine.recordDelta();
      renderStatus();
      return;
    }

    if (ev.type === "toolcall_end") {
      // Pause covers exactly the dead time — tool execution + next prefill,
      // from the last tool-call token to the next message's first token.
      engine.pause();
    }
  });

  pi.on("agent_end", (event: AgentEndEvent) => {
    const messages = Array.isArray(event.messages) ? event.messages : [];

    // omp fires agent_end after every assistant-message settle, passing the
    // FULL session as `messages` — pi fires it once per prompt with the
    // prompt's messages. A settle whose last assistant message still has tool
    // calls, or that scheduled a continuation, is mid-prompt: keep the engine
    // running so the final average spans the whole prompt, and skip the
    // reconcile (which would otherwise divide a whole-session token total by
    // the last message's time).
    let midPrompt = event.willContinue === true;
    if (!midPrompt) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].role !== "assistant") continue;
        midPrompt = messages[i].content?.some((c) => c.type === "toolCall") ?? false;
        break;
      }
    }
    if (midPrompt) return;

    engine.stop();

    // Authoritative total for THIS prompt: usage of the messages after the
    // last user message. In pi that is the original plugin's sum unchanged;
    // in omp it excludes prior prompts that live in the session state.
    let start = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        start = i + 1;
        break;
      }
    }
    let outputTokens = 0;
    for (let i = start; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "assistant" || m.role === "toolResult") {
        outputTokens += m.usage?.output ?? 0;
      }
    }
    engine.reconcileTotal(outputTokens);

    renderStatus(true);
  });

  pi.on("turn_end", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage();
    }
  });

  pi.on("session_shutdown", () => {
    engine.stop();
    if (renderTimer) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    // Only restore if our wrapper is still on top — never clobber a wrapper
    // installed by another extension after us.
    if (originalFetch && globalThis.fetch === patched) globalThis.fetch = originalFetch;
    delete globalState[key];
  });
}
