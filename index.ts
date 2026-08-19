import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Unified speed stats for omp: one status line combining
//  - TPS: generation tokens/sec (ported from pi-token-speed@0.7.1, stock defaults:
//    direct counting, 1s sliding window, provider tokens off, average on end)
//  - PP:  prompt-processing tokens/sec from llama.cpp SSE progress/timings
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

const TPS_THRESHOLDS: Array<[number, string]> = [
  [45, "#44ddff"], // blazing
  [30, "#00ff88"], // fast
  [15, "#ffaa00"], // medium
  [0, "#ff4444"],  // slow
];

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
let ppStats: string | null = null; // e.g. "452 t/s · 1200n · 800c-40.0%"

// Same key pi-token-speed used — pi-token-speed must stay disabled while this
// extension is active, or both would fight over the same status entry.
const STATUS_KEY = "tokenSpeed";

// omp renders one line per setStatus key, sorted by key (localeCompare), with
// no spacer between the transcript and the first status line. A blank entry
// whose key sorts before STATUS_KEY produces the top padding row.
const PAD_KEY = "00-top-pad";

function dim(text: string): string {
  try {
    return uiRef?.theme?.fg?.("dim", text) ?? `\x1b[90m${text}\x1b[0m`;
  } catch {
    return `\x1b[90m${text}\x1b[0m`;
  }
}

function colorHex(text: string, hex: string): string {
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

function renderStatus(): void {
  if (!uiRef || !hasUI) return;

  let text: string;
  if (!engine.everStreamed) {
    text = `${dim("⚡ TPS:")} --`;
  } else {
    const tps = engine.tps;
    const measurement = `${tps.toFixed(1)} tok/s`;
    text = `${dim("⚡ TPS:")} ${colorHex(measurement, tpsColor(tps))}`;
  }

  if (ppStats) {
    text += `  ·  ${dim("PP:")} ${ppStats}`;
  }

  uiRef.setStatus(STATUS_KEY, text);
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

            // Final llama.cpp PP statistics
            if (
              chunk.timings &&
              typeof chunk.timings.prompt_per_second === "number"
            ) {
              const t = chunk.timings;

              const newTokens = t.prompt_n ?? 0;
              const cached = t.cache_n ?? 0;
              const totalPrompt = newTokens + cached;

              const cachePct = totalPrompt > 0 ? (cached / totalPrompt) * 100 : 0;

              ppStats = `${Math.floor(t.prompt_per_second)} t/s · ${newTokens}n · ${cached}c-${cachePct.toFixed(1)}%`;
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
      ctx.ui.setStatus(STATUS_KEY, `${dim("⚡ TPS:")} --`);
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
