# omp-llama-stats

One plain-ASCII status line for local-model speed stats in **oh-my-pi (omp)**
(also works in **pi**): generation throughput and last-prompt processing speed
from llama.cpp-family servers (LM Studio, llama.cpp server, ...).

```
...last assistant response line

 Gen: 129.1 tok/s | Last Prompt: 72.0 tok/s (no cache)
~ (main*) ... lmstudio/big
```

- **Gen** — generation tokens/sec, live (1s sliding window) and final (overall average).
- **Last Prompt** — prompt-processing tokens/sec from llama.cpp's SSE progress
  data, with new-token and cache-hit counts.
- **Prefill progress** — while the server processes the prompt, the working
  message shows `Prefilling... 42% · 180.3 t/s`.
- **Top padding** — a blank line between the transcript and the status row
  (omp-specific; see below).

Gen works against any provider. Last Prompt appears only for endpoints that
support llama.cpp's `return_progress` / `timings` fields (LM Studio and the
llama.cpp server do; hosted APIs don't — it then shows `--`).

## Install

omp (from git, no npm account needed):

```
omp plugin install github:saikiran-rs/omp-llama-stats
```

The installer shells out to `bun` to resolve the git source, so it must be in
`$PATH` (error: `Executable not found in $PATH: "bun"` otherwise). If
missing:

```
curl -fsSL https://bun.sh/install | bash   # installs to ~/.bun/bin
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

## Status line format

One line, plain ASCII (no emoji) so it survives copy-paste into logs and
issue trackers:

```
 Gen: {gen} tok/s | Last Prompt: {pp} tok/s (cache {pct}%, {new} new / {cached} cached)
```

Rules:

- Rates (`gen`, `pp`) and cache percent: exactly 1 decimal place.
- `Last Prompt` is per-request, never a rolling average.
- Token counts: raw integer below 10000; 10000 and above abbreviated with one
  decimal + lowercase `k` (33398 becomes 33.4k).
- `cache` pct = cached / (new + cached), rounded to 1 decimal.
- Cold start (no cached tokens): the parenthetical becomes `(no cache)`.
- Before the first data arrives: ` Gen: -- tok/s | Last Prompt: -- tok/s (no cache)`.
- The line starts with a single leading space.
- Color is the only non-plain part, and it is dropped on copy:
  - `Gen` rate: original pi-token-speed ladder — red < 15 ≤ orange < 30 ≤
    green < 45 ≤ blue tok/s (truecolor).
  - `Last Prompt` rate: red (`#ff4444`) below 15 tok/s, otherwise no color.
  - omp's status-line sanitizer strips ANSI and trims the line, so in omp
    the line renders plain (leading space and colors show in pi).

Examples:

```
 Gen: 68.4 tok/s | Last Prompt: 302.0 tok/s (cache 97.3%, 935 new / 33.4k cached)
 Gen: 112.7 tok/s | Last Prompt: 1840.7 tok/s (cache 1.8%, 33.4k new / 599 cached)
 Gen: 94.2 tok/s | Last Prompt: 871.5 tok/s (no cache)
```

## Requirements

- omp (any recent build) or pi. The extension imports
  `@earendil-works/pi-coding-agent` types only; omp's pi-compat layer rewrites
  the specifier onto its bundled host copy, so no dependency install is needed.
- `bun` in `$PATH` at install time (the omp installer uses it to fetch the
  git source). Not needed at runtime — the extension is dependency-free.
- For PP: an OpenAI-compatible endpoint that accepts
  `return_progress: true` (LM Studio `http://<host>:1234/v1`,
  llama.cpp `llama-server`). The endpoint host is auto-detected from the first
  `/chat/completions` request and pinned.

## How it works (the parts worth reusing)

Single file: `index.ts` (no runtime dependencies).

### 1. Gen — generation speed

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
  and switches the display to the overall average. omp fires `agent_end`
  after **every assistant-message settle** with the full session as
  `messages` (pi fires it once per prompt), so the reconcile runs only on a
  true prompt end — last assistant message has no tool calls, no
  continuation scheduled — and sums only the messages after the last user
  message. Without that guard a whole-session token total divides by the
  last message's time (the 2080 tok/s bug);
- Colors: the Gen rate uses the original pi-token-speed ladder —
  red < 15 ≤ orange < 30 ≤ green < 45 ≤ blue tok/s (truecolor ANSI; stripped
  by omp's sanitizer, visible in pi).

### 2. Last Prompt — prompt processing via a global fetch hook

The only clean seam for reading the raw SSE stream is `globalThis.fetch`
(extensions run in-process, unsandboxed). The hook:

1. matches requests to `<auto-detected host>/chat/completions`;
2. rewrites the JSON body: `return_progress: true` +
   `stream_options.include_usage: true` (streaming requests only);
3. wraps the response body in a tee'd `ReadableStream` that parses SSE lines:
   - `chunk.prompt_progress` → live prefill % + t/s in the working message;
   - `chunk.timings.prompt_per_second` (+ `prompt_n`, `cache_n`) → the final
     Last Prompt stat, held until the next response;
4. restores `globalThis.fetch` on `session_shutdown`; a `globalThis` guard key
   prevents double-patching when the process hosts multiple sessions.

### 3. Single line (why this exists)

**omp renders one footer row per `setStatus` key** (pi joins all statuses on
one line). A TPS plugin and a PP plugin therefore land on two rows in omp.
The fix: one extension, one status key — `tokenSpeed` — writing
` Gen: <x> tok/s | Last Prompt: <y> tok/s (cache <p>%, <n> new / <c> cached)`.

If you also have `pi-token-speed` installed, **disable it**
(`omp plugin disable pi-token-speed`) or the two will fight over the same key.

### 4. Top padding

omp has no spacer between the transcript and the first status row. The
status-line component maps each status key to its own row, **sorted by key
(localeCompare)** — so a second, blank status entry whose key sorts first
(`00-top-pad`) renders a blank line above the status row. Re-asserted on
`session_start` and `before_agent_start` because session switches clear hook
statuses. In pi (where statuses are joined on one line) this entry is an
invisible no-op.

## Customizing

Everything is a module-level constant in `index.ts`:

| Constant | Meaning |
| --- | --- |
| `SLIDING_WINDOW_MS` | TPS smoothing window (default 1000) |
| `TPS_THRESHOLDS` | `[tok/s, hex]` color ladder for the Gen rate |
| `TOKEN_GENERATION_TOOLS` | tool names counted as generation (`edit`, `write`) |
| `STATUS_KEY` / `PAD_KEY` | status keys (rename if another extension collides) |

## Notes / caveats

- The fetch hook is process-wide: every session in the omp process routes
  llama-host `/chat/completions` requests through it. Non-llama traffic is
  untouched.
- Last Prompt stats are reported by the *server*; `cache`% is prompt-cache hit
  ratio, not KV-cache memory.
- The extension renders nothing until `session_start`; a placeholder
  ` Gen: -- tok/s | Last Prompt: -- tok/s (no cache)` appears on session start.

## License

MIT — see [LICENSE](./LICENSE).
