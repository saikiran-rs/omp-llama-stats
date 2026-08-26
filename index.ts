import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Unified speed stats for omp: one status line:
//
//   ⚡ Gen <rate> t/s | Last Prompt <rate> t/s [Cache <pct>% | <n> new / <c> cached]
//
//  - Gen: generation tokens/sec. Live: 1s sliding-window estimate (ported
//    from pi-token-speed@0.7.1). Final: llama.cpp's own
//    `timings.predicted_n` / `predicted_ms` summed per prompt, with a
//    wall-clock average fallback for non-llama providers
//  - Last Prompt: prompt-processing tokens/sec from llama.cpp SSE
//    progress/timings — per-request, never a rolling average
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

  constructor(private readonly windowMs: number) {}

  record(tokens: number): void {
    this.events.push({ time: Date.now(), tokens });
    if (this.windowStartIndex >= COMPACTION_THRESHOLD) this.compact();
  }

  getTps(now: number): number {
    // N tokens span N-1 complete generation intervals; the oldest in-window
    // token anchors the span, so count only tokens after it.
    const windowStart = now - this.windowMs;
    while (
      this.windowStartIndex < this.events.length &&
      this.events[this.windowStartIndex].time < windowStart
    ) {
      this.windowStartIndex++;
    }
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
  }
}

class TpsEngine {
  private _isStreaming = false;
  private _isPaused = false;
  private _tokenCount = 0;
  private _startTime = 0;
  private _endTime = 0;
  private _startPause = 0;
  private _pausedMs = 0;
  private _everStreamed = false;
  private readonly _slidingWindow = new SlidingWindow(SLIDING_WINDOW_MS);

  get isStreaming(): boolean {
    return this._isStreaming;
  }

  get tokenCount(): number {
    return this._tokenCount;
  }

  get everStreamed(): boolean {
    return this._everStreamed;
  }

  get elapsedSeconds(): number {
    if (this._startTime === 0) return 0;
    const end = this.isStreaming ? Date.now() : this._endTime;
    return Math.max(0, end - this._startTime - this._pausedMs) / 1000;
  }

  get tps(): number {
    // endTpsBehavior: "average" — overall average once streaming ends
    // (renderStatus substitutes llama.cpp's exact predicted rate when it
    // has one). Live: computed at read time so a stalled stream decays
    // toward 0 instead of pinning the last delta's value.
    if (this.isStreaming) return this._slidingWindow.getTps(Date.now());
    return this.tpsAvg;
  }

  get tpsAvg(): number {
    const seconds = this.elapsedSeconds;
    return seconds <= 0 ? 0 : this._tokenCount / seconds;
  }

  start(): void {
    if (this._isStreaming) return;
    this._everStreamed = true;
    this._tokenCount = 0;
    this._isStreaming = true;
    this._startTime = Date.now();
    this._endTime = this._startTime;
    this._slidingWindow.reset();
    this._pausedMs = 0;
    // A pause left open by the previous prompt must not leak into this one.
    this._isPaused = false;
    this._startPause = 0;
  }

  stop(): void {
    // Settle an open pause before freezing elapsed time.
    this.resume();
    this._isStreaming = false;
    this._endTime = Date.now();
    this._slidingWindow.reset();
  }

  pause(): void {
    // Ignore re-pause (parallel tool calls) and pauses outside streaming.
    if (!this._isStreaming || this._isPaused) return;
    this._isPaused = true;
    this._startPause = Date.now();
  }

  private resume(): void {
    if (!this._isPaused) return;
    this._isPaused = false;
    this._pausedMs += Date.now() - this._startPause;
  }

  /** countStrategy: "direct" — 1 token per delta event. */
  recordDelta(): void {
    if (!this._isStreaming) return;
    if (this._isPaused) this.resume();
    this.recordTokens(1);
  }

  reconcileTotal(tokens: number): void {
    if (tokens > 0) this._tokenCount = tokens;
  }
  private recordTokens(tokens: number): void {
    if (!this._isStreaming || tokens <= 0) return;
    this._tokenCount += tokens;
    this._slidingWindow.record(tokens);
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
  ((globalThis as Record<string, any>).process?.env?.OMP_LLAMA_HOST as string) ?? null;

const engine = new TpsEngine();

interface PpStats {
  /** prompt tokens/sec (llama.cpp `timings.prompt_per_second`), per-request */
  pp: number;
  /** uncached prompt tokens (`timings.prompt_n`) */
  newTokens: number;
  /** cached prompt tokens (`timings.cache_n`) */
  cached: number;
}

let ppStats: PpStats | null = null;
// Exact generation timing from llama.cpp `timings.predicted_n` /
// `predicted_ms`, accumulated across the requests of one user prompt
// (reset in before_agent_start).
let tgAccum = { n: 0, ms: 0 };
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

function formatRate(v: number): string {
  return `${v.toFixed(1).replace(/\.0$/, "")} t/s`;
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}K`;
}

function promptRate(pp: number): string {
  const text = formatRate(pp);
  return pp < SLOW_PROMPT_TPS ? `\x1b[38;2;255;68;68m${text}\x1b[0m` : text;
}

function formatPrompt(s: PpStats): string {
  const total = s.newTokens + s.cached;
  if (s.newTokens === 0 && s.cached > 0) {
    // Fully-cached prompt: nothing ran through the model, so a rate would
    // be 0 — and red. Show the hit directly.
    return `cached [${formatTokens(s.cached)}]`;
  }
  const rate = promptRate(s.pp);
  if (s.cached === 0) return rate;
  const pct = total > 0 ? ((s.cached / total) * 100).toFixed(1) : "0.0";
  return `${rate} [Cache ${pct}% | ${formatTokens(s.newTokens)} new / ${formatTokens(s.cached)} cached]`;
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

  // After the prompt ends, prefer the server-measured rate (ground truth)
  // over the wall-clock reconstruction; while streaming, the live estimate
  // is the only in-flight source.
  const tps =
    !engine.isStreaming && tgAccum.ms > 0 ? (1000 * tgAccum.n) / tgAccum.ms : engine.tps;
  const gen = engine.everStreamed ? colorHex(formatRate(tps), tpsColor(tps)) : "-- t/s";
  const prompt = ppStats ? formatPrompt(ppStats) : "-- t/s";
  uiRef.setStatus(STATUS_KEY, ` ⚡ Gen ${gen} | Last Prompt ${prompt}`);
}

// ═══════════════════════════════════════════════════════════════
// llama.cpp SSE hook (unchanged from the pi version)
// ═══════════════════════════════════════════════════════════════

// Local/private match per request so a cloud provider (or a proxy fronting
// one) never gets `return_progress` injected — OpenAI 400s on it.
function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return (
    name === "localhost" ||
    name === "::1" ||
    name.endsWith(".local") ||
    /^127\./.test(name) ||
    /^10\./.test(name) ||
    /^192\.168\./.test(name) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(name)
  );
}

function isLlamaRequest(input: RequestInfo | URL): boolean {
  const raw =
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (typeof raw !== "string" || !raw.includes("/chat/completions")) return false;

  try {
    const host = new URL(raw).host;
    return LLAMA_HOST ? host === LLAMA_HOST : isLocalHost(host);
  } catch {
    return false;
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

function capture(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleLine = (line: string) => {
    if (!line.startsWith("data: ")) return;
    const raw = line.slice(6).trim();
    if (!raw || raw === "[DONE]") return;

    try {
      const chunk = JSON.parse(raw);

      // Live prefill display
      if (chunk.prompt_progress && uiRef && hasUI) {
        const p = chunk.prompt_progress;
        const processed = p.processed ?? 0;
        const cached = p.cache ?? 0;
        const total = p.total ?? 0;
        const ms = p.time_ms ?? 0;

        const newTokens = Math.max(0, processed - cached);
        const totalNew = Math.max(0, total - cached);
        const pp = ms > 0 ? newTokens / (ms / 1000) : 0;
        const pct = totalNew > 0 ? (newTokens / totalNew) * 100 : 100;

        if (processed < total) {
          uiRef.setWorkingMessage(`Prefilling... ${pct.toFixed(0)}% · ${pp.toFixed(1)} t/s`);
        } else {
          uiRef.setWorkingMessage();
        }
      }

      // Final llama.cpp statistics
      if (chunk.timings && typeof chunk.timings.prompt_per_second === "number") {
        const t = chunk.timings;
        ppStats = {
          pp: t.prompt_per_second,
          newTokens: t.prompt_n ?? 0,
          cached: t.cache_n ?? 0,
        };
        if (t.cache_n === undefined && !warnedMissingCacheN) {
          warnedMissingCacheN = true;
          console.warn(
            "[omp-llama-stats] llama.cpp timings.cache_n missing (older build?) — cache stats will read as absent",
          );
        }
        if (typeof t.predicted_n === "number" && typeof t.predicted_ms === "number") {
          tgAccum.n += t.predicted_n;
          tgAccum.ms += t.predicted_ms;
        }
        renderStatus(true);
      }
    } catch {}
  };

  // Pull-based: the consumer drives the pace (backpressure), and cancel
  // propagates so a torn-down stream can't reject an already-settled one.
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) handleLine(line);

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
    if (!isLlamaRequest(input)) {
      return originalFetch!(input, init);
    }

    enableProgress(init);

    const response = await originalFetch!(input, init);

    if (response.ok && response.body) {
      return new Response(capture(response.body), {
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
    // New user prompt: the exact-generation accumulator starts fresh.
    tgAccum = { n: 0, ms: 0 };
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
