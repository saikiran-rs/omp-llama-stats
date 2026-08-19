import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Unified speed stats for omp: one plain-ASCII status line:
//
//   Gen: <rate> tok/s | Last Prompt: <rate> tok/s (cache <pct>%, <n> new / <c> cached)
//
//  - Gen: generation tokens/sec (ported from pi-token-speed@0.7.1, stock
//    defaults: direct counting, 1s sliding window, provider tokens off,
//    average on end)
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
  usage?: { output?: number };
}

interface AgentEndEvent {
  messages?: AgentEndMessage[];
}

/** The slice of the extension UI this extension drives. */
interface UiRef {
  theme?: { fg?: (kind: string, text: string) => string };
  setStatus: (key: string, text?: string) => void;
  setWorkingMessage: (text?: string) => void;
}

// ═══════════════════════════════════════════════════════════════
// TPS engine (port of pi-token-speed, defaults only)
// ═══════════════════════════════════════════════════════════════

const TOKEN_GENERATION_TOOLS: Record<string, true> = {
  edit: true,
  write: true,
};

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
    if (this.events.length === 0) return 0;

    const windowStart = now - this.windowMs;
    while (
      this.windowStartIndex < this.events.length &&
      this.events[this.windowStartIndex].time < windowStart
    ) {
      this.windowStartIndex++;
    }
    if (this.windowStartIndex >= this.events.length) return 0;

    let windowTokenCount = 0;
    for (let i = this.windowStartIndex; i < this.events.length; i++) {
      windowTokenCount += this.events[i].tokens;
    }
    if (windowTokenCount === 0) return 0;

    const rawSpan = now - this.events[this.windowStartIndex].time;
    const span = Math.max(rawSpan, MIN_SLIDING_WINDOW_MS);
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
  private _tps = 0;
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
    if (this.isStreaming) return this._tps;
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
    this._endTime = Date.now();
    this._slidingWindow.reset();
    this._tps = 0;
    this._pausedMs = 0;
  }

  stop(): void {
    this._isStreaming = false;
    this._endTime = Date.now();
    this._slidingWindow.reset();
  }

  pause(): void {
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
    this._tps = this._slidingWindow.getTps(Date.now());
  }
}

// ═══════════════════════════════════════════════════════════════
// Shared state
// ═══════════════════════════════════════════════════════════════

let originalFetch: typeof fetch | null = null;
let uiRef: UiRef | null = null;
let hasUI = false;
let llamaHost: string | null = null;

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

// Same key pi-token-speed used — pi-token-speed must stay disabled while this
// extension is active, or both would fight over the same status entry.
const STATUS_KEY = "tokenSpeed";

// omp renders one line per setStatus key, sorted by key (localeCompare), with
// no spacer between the transcript and the first status line. A blank entry
// whose key sorts before STATUS_KEY produces the top padding row.
const PAD_KEY = "00-top-pad";
// Last Prompt rate below this threshold renders red.
const SLOW_PROMPT_TPS = 15;

function formatTokens(n: number): string {
  return n < 10000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}

function promptRate(pp: number): string {
  const text = `${pp.toFixed(1)} tok/s`;
  return pp < SLOW_PROMPT_TPS ? `\x1b[38;2;255;68;68m${text}\x1b[0m` : text;
}

function formatPrompt(s: PpStats): string {
  const rate = promptRate(s.pp);
  if (s.cached === 0) return `${rate} (no cache)`;
  const total = s.newTokens + s.cached;
  const pct = total > 0 ? ((s.cached / total) * 100).toFixed(1) : "0.0";
  return `${rate} (cache ${pct}%, ${formatTokens(s.newTokens)} new / ${formatTokens(s.cached)} cached)`;
}

function renderStatus(): void {
  if (!uiRef || !hasUI) return;

  const gen = engine.everStreamed ? engine.tps.toFixed(1) : "--";
  const prompt = ppStats ? formatPrompt(ppStats) : "-- tok/s (no cache)";
  uiRef.setStatus(STATUS_KEY, ` Gen: ${gen} tok/s | Last Prompt: ${prompt}`);
}

// ═══════════════════════════════════════════════════════════════
// llama.cpp SSE hook (unchanged from the pi version)
// ═══════════════════════════════════════════════════════════════

function isLlamaRequest(input: RequestInfo | URL): boolean {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;

  if (typeof url !== "string" || !url.includes("/chat/completions")) {
    return false;
  }

  if (!llamaHost) {
    try {
      llamaHost = new URL(url).host;
    } catch {
      return false;
    }
  }

  try {
    return new URL(url).host === llamaHost;
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

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          const raw = line.slice(6);
          if (raw === "[DONE]") continue;

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

            // Final llama.cpp prompt-processing statistics
            if (
              chunk.timings &&
              typeof chunk.timings.prompt_per_second === "number"
            ) {
              const t = chunk.timings;

              ppStats = {
                pp: t.prompt_per_second,
                newTokens: t.prompt_n ?? 0,
                cached: t.cache_n ?? 0,
              };
              renderStatus();
            }
          } catch {}
        }

        controller.enqueue(value);
      }

      controller.close();
    },

    cancel(reason) {
      reader.cancel(reason);
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

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
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

  pi.on("session_start", (_event, ctx) => {
    uiRef = ctx.ui;
    hasUI = ctx.hasUI;
    if (hasUI) {
      renderStatus();
      ctx.ui.setStatus(PAD_KEY, " ");
    }
  });

  pi.on("before_agent_start", (_event, ctx) => {
    uiRef = ctx.ui;
    hasUI = ctx.hasUI;
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
      const toolCall = ev.partial?.content?.[ev.contentIndex ?? 0];
      if (toolCall?.type === "toolCall" && TOKEN_GENERATION_TOOLS[toolCall.name ?? ""]) {
        engine.recordDelta();
        renderStatus();
      }
      return;
    }

    if (ev.type === "toolcall_end") {
      const toolCall = ev.partial?.content?.[ev.contentIndex ?? 0];
      if (toolCall?.type === "toolCall" && !TOKEN_GENERATION_TOOLS[toolCall.name ?? ""]) {
        // Pause the timer for prompt-processing tools so they don't skew the average
        engine.pause();
      }
    }
  });

  pi.on("agent_end", (event: AgentEndEvent) => {
    engine.stop();

    if (Array.isArray(event.messages)) {
      const outputTokens = event.messages.reduce((acc, curr) => {
        if (curr.role === "assistant") {
          return acc + (curr.usage?.output ?? 0);
        }
        if (curr.role === "toolResult") {
          return acc + (curr.usage?.output ?? 0);
        }
        return acc;
      }, 0);

      engine.reconcileTotal(outputTokens);
    }

    renderStatus();
  });

  pi.on("turn_end", (_event, ctx) => {
    if (ctx.hasUI) {
      ctx.ui.setWorkingMessage();
    }
  });

  pi.on("session_shutdown", () => {
    engine.stop();
    if (originalFetch) {
      globalThis.fetch = originalFetch;
    }
    delete globalState[key];
  });
}
