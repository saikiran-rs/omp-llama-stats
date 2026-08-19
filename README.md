# omp-llama-stats

One status line for local-model speed stats in **oh-my-pi (omp)** (also works in
**pi**): generation throughput (TPS) and prompt-processing speed (PP) from
llama.cpp-family servers (LM Studio, llama.cpp server, ...).

```
...last assistant response line

⚡ TPS: 129.1 tok/s  ·  PP: 72 t/s · 134n · 0c-0.0%
~ (main*) ... lmstudio/big
```

- **TPS** — generation tokens/sec, live (1s sliding window) and final (overall average).
- **PP** — prompt-processing tokens/sec from llama.cpp's SSE progress data, with
  new-token (`n`) and cache-hit (`c-P%`) counts.
- **Prefill progress** — while the server processes the prompt, the working
  message shows `Prefilling... 42% · 180.3 t/s`.
- **Top padding** — a blank line between the transcript and the status row
  (omp-specific; see below).

TPS works against any provider. PP appears only for endpoints that support
llama.cpp's `return_progress` / `timings` fields (LM Studio and the llama.cpp
server do; hosted APIs don't — the line then shows TPS only).

## Install

omp (from git, no npm account needed):

```
omp plugin install github:saikiran-rs/omp-llama-stats
```

pi:

```
pi install github:saikiran-rs/omp-llama-stats
```

Then **restart the session** (extension modules are loaded at startup).

Uninstall:

```
omp plugin uninstall omp-llama-stats
```

## Requirements

- omp (any recent build) or pi. The extension imports
  `@earendil-works/pi-coding-agent` types only; omp's pi-compat layer rewrites
  the specifier onto its bundled host copy, so no dependency install is needed.
- For PP: an OpenAI-compatible endpoint that accepts
  `return_progress: true` (LM Studio `http://<host>:1234/v1`,
  llama.cpp `llama-server`). The endpoint host is auto-detected from the first
  `/chat/completions` request and pinned.

## How it works (the parts worth reusing)

Single file: `index.ts` (~530 lines, no runtime dependencies).

### 1. TPS — generation speed

Ported from [`pi-token-speed`](https://www.npmjs.com/package/pi-token-speed)
(0.7.1) at its stock defaults — the `/tps` settings menu is intentionally not
ported. The engine:

- listens to `message_update` events: `text_start`/`thinking_start`/
  `toolcall_start` start a stream; `text_delta`/`thinking_delta` record 1 token
  each (`direct` count strategy); tool-call deltas count only for
  `edit`/`write` (the token-generating tools); other tool calls `pause()` the
  timer so tool execution time doesn't skew the average;
- TPS while streaming = tokens in the last 1000 ms (sliding window, span
  clamped to 100 ms minimum to avoid burst spikes);
- `agent_end` reconciles the total against provider-reported `usage.output`
  and switches the display to the overall average.

Colors: red < 15 ≤ orange < 30 ≤ green < 45 ≤ blue tok/s (truecolor ANSI).

### 2. PP — prompt processing via a global fetch hook

The only clean seam for reading the raw SSE stream is `globalThis.fetch`
(extensions run in-process, unsandboxed). The hook:

1. matches requests to `<auto-detected host>/chat/completions`;
2. rewrites the JSON body: `return_progress: true` +
   `stream_options.include_usage: true` (streaming requests only);
3. wraps the response body in a tee'd `ReadableStream` that parses SSE lines:
   - `chunk.prompt_progress` → live prefill % + t/s in the working message;
   - `chunk.timings.prompt_per_second` (+ `prompt_n`, `cache_n`) → the final PP
     stat, held until the next response;
4. restores `globalThis.fetch` on `session_shutdown`; a `globalThis` guard key
   prevents double-patching when the process hosts multiple sessions.

### 3. Single line (why this exists)

**omp renders one footer row per `setStatus` key** (pi joins all statuses on
one line). A TPS plugin and a PP plugin therefore land on two rows in omp.
The fix: one extension, one status key — `tokenSpeed` — writing
`⚡ TPS: <x> tok/s  ·  PP: <y> t/s · <n>n · <c>c-<p>%`.

If you also have `pi-token-speed` installed, **disable it**
(`omp plugin disable pi-token-speed`) or the two will fight over the same key.

### 4. Top padding

omp has no spacer between the transcript and the first status row. The
status-line component maps each status key to its own row, **sorted by key
(localeCompare)** — so a second, blank status entry whose key sorts first
(`00-top-pad`) renders as a blank line above the TPS row. Re-asserted on
`session_start` and `before_agent_start` because session switches clear hook
statuses. In pi (where statuses are joined on one line) this entry is an
invisible no-op.

## Customizing

Everything is a module-level constant in `index.ts`:

| Constant | Meaning |
| --- | --- |
| `SLIDING_WINDOW_MS` | TPS smoothing window (default 1000) |
| `TPS_THRESHOLDS` | `[tok/s, hex]` color ladder |
| `TOKEN_GENERATION_TOOLS` | tool names counted as generation (`edit`, `write`) |
| `STATUS_KEY` / `PAD_KEY` | status keys (rename if another extension collides) |

## Notes / caveats

- The fetch hook is process-wide: every session in the omp process routes
  llama-host `/chat/completions` requests through it. Non-llama traffic is
  untouched.
- PP stats are reported by the *server*; `cache-P%` is prompt-cache hit ratio,
  not KV-cache memory.
- The extension renders nothing until `session_start`; a placeholder
  `⚡ TPS: --` appears on session start.

## License

MIT — see [LICENSE](./LICENSE).
