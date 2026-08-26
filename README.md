# omp-llama-stats

One plain-ASCII status line for local-model speed stats in **oh-my-pi (omp)**
(also works in **pi**): generation throughput and last-prompt processing speed
from llama.cpp-family servers (LM Studio, llama.cpp server, ...).

```
...last assistant response line

 ⚡ Gen 129.1 t/s | Last Prompt 72 t/s
~ (main*) ... lmstudio/big
```

- **Gen** — generation tokens/sec, live (1s sliding window) and final
  (llama.cpp's measured predicted rate; wall-clock average fallback).
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

One line (⚡ + plain text) that survives copy-paste into logs and
issue trackers:

```
 ⚡ Gen {gen} t/s | Last Prompt {pp} t/s [Cache {pct}% | {new} new / {cached} cached]
 ⚡ Gen {gen} t/s | Last Prompt cached [{cached}]        (fully-cached prompt)
```

Rules:

- Rates (`gen`, `pp`): 1 decimal, trailing `.0` dropped (302.0 becomes 302);
  cache percent: exactly 1 decimal.
- `Last Prompt` is per-request, never a rolling average.
- Token counts: raw integer below 1000; 1000 and above abbreviated with one
  decimal + capital `K`, trailing `.0` dropped (2600 becomes 2.6K, 33398
  becomes 33.4K).
- `Cache` pct = cached / (new + cached), rounded to 1 decimal.
- Cold start (no cached tokens): the cache bracket is omitted — bare rate.
- Fully-cached prompt (nothing to process): no rate — `cached [N]`.
- Before the first data arrives: ` ⚡ Gen -- t/s | Last Prompt -- t/s`.
- The line starts with a single leading space.
- Color is the only non-plain part, and it is dropped on copy:
  - `Gen` rate: original pi-token-speed ladder — red < 15 ≤ orange < 30 ≤
    green < 45 ≤ blue t/s (truecolor).
  - `Last Prompt` rate: red (`#ff4444`) below 15 t/s, otherwise no color.
  - omp's status-line sanitizer strips ANSI and trims the line, so in omp
    the line renders plain (leading space and colors show in pi).

Examples:

```
 ⚡ Gen 68.4 t/s | Last Prompt 302 t/s [Cache 97.3% | 935 new / 33.4K cached]
 ⚡ Gen 112.7 t/s | Last Prompt 1840.7 t/s [Cache 1.8% | 33.4K new / 599 cached]
 ⚡ Gen 94.2 t/s | Last Prompt 871.5 t/s
 ⚡ Gen 12.3 t/s | Last Prompt cached [26K]
```

## Requirements

- omp (any recent build) or pi. The extension imports
  `@earendil-works/pi-coding-agent` types only; omp's pi-compat layer rewrites
  the specifier onto its bundled host copy, so no dependency install is needed.
- `bun` in `$PATH` at install time (the omp installer uses it to fetch the
  git source). Not needed at runtime — the extension is dependency-free.
- For PP: an OpenAI-compatible endpoint that accepts
  `return_progress: true` (LM Studio `http://<host>:1234/v1`,
  llama.cpp `llama-server`). Only local/private hosts (localhost, 127.*,
  10.*, 192.168.*, 172.16-31.*, *.local, ::1) are treated as llama.cpp —
  cloud providers never get `return_progress` injected (OpenAI 400s on it).
  Set `OMP_LLAMA_HOST=host:port` to pin an explicit host.

## How it works (the parts worth reusing)

Single file: `index.ts` (no runtime dependencies).

### 1. Gen — generation speed

Ported from [`pi-token-speed`](https://www.npmjs.com/package/pi-token-speed)
(0.7.1), diverged where estimation mattered — the `/tps` settings menu is
intentionally not ported. The engine:

- listens to `message_update` events: `text_start`/`thinking_start`/
  `toolcall_start` start a stream; `text_delta`/`thinking_delta`/
  `toolcall_delta` each record 1 token (`direct` count strategy) — tool-call
  argument tokens are counted because `usage.output` includes them; every
  `toolcall_end` `pause()`s the timer, so the excluded time is exactly the
  dead gap (tool execution + next prefill);
- live TPS while streaming = tokens in the last 1000 ms (sliding window,
  span clamped to 100 ms minimum to avoid burst spikes), computed at read
  time so a stalled stream decays instead of pinning;
- **final** Gen prefers llama.cpp's own measurement: `timings.predicted_n` /
  `predicted_ms` (server-side sampling-loop timing) accumulated across the
  prompt's requests — exact, immune to pause bookkeeping and network jitter.
  Wall-clock average is the fallback for non-llama providers;
- `agent_end` reconciles the total against provider-reported `usage.output`
  and switches the display to the final value. omp fires `agent_end`
  after **every assistant-message settle** with the full session as
  `messages` (pi fires it once per prompt), so the reconcile runs only on a
  true prompt end — last assistant message has no tool calls, no
  continuation scheduled — and sums only the messages after the last user
  message. Without that guard a whole-session token total divides by the
  last message's time (the 2080 tok/s bug);
- Colors: the Gen rate uses the original pi-token-speed ladder —
  red < 15 ≤ orange < 30 ≤ green < 45 ≤ blue t/s (truecolor ANSI; stripped
  by omp's sanitizer, visible in pi).

### 2. Last Prompt — prompt processing via a global fetch hook

The only clean seam for reading the raw SSE stream is `globalThis.fetch`
(extensions run in-process, unsandboxed). The hook:

1. matches `/chat/completions` requests to local/private hosts per request
   (`OMP_LLAMA_HOST` pins one host) — cloud providers are never touched;
2. rewrites the JSON body: `return_progress: true` +
   `stream_options.include_usage: true` (streaming requests only);
3. wraps the response body in a pull-based `ReadableStream` (consumer-paced,
   cancel propagates) that parses SSE lines:
   - `chunk.prompt_progress` → live prefill % + t/s in the working message;
   - `chunk.timings.prompt_per_second` (+ `prompt_n`, `cache_n`) → the final
     Last Prompt stat, held until the next response; missing `cache_n`
     (older llama.cpp) warns once and reads as no cache;
   - `chunk.timings.predicted_n` / `predicted_ms` → accumulated into the
     exact final Gen rate;
4. restores `globalThis.fetch` on `session_shutdown` — only if our wrapper
   is still on top, so a later extension's wrapper survives; a `globalThis`
   guard key prevents double-patching when the process hosts multiple
   sessions.

### 3. Single line (why this exists)

**omp renders one footer row per `setStatus` key** (pi joins all statuses on
one line). A TPS plugin and a PP plugin therefore land on two rows in omp.
The fix: one extension, one status key — `tokenSpeed` — writing
` ⚡ Gen <x> t/s | Last Prompt <y> t/s [Cache <p>% | <n> new / <c> cached]`.

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
| `TPS_THRESHOLDS` | `[t/s, hex]` color ladder for the Gen rate |
| `STATUS_KEY` / `PAD_KEY` | status keys (rename if another extension collides) |

Env: `OMP_LLAMA_HOST` (e.g. `127.0.0.1:8080`) pins the llama.cpp host;
without it, local/private hosts match per request.

## Notes / caveats

- The fetch hook is process-wide: every session in the omp process routes
  llama-host `/chat/completions` requests through it. Non-llama traffic is
  untouched.
- Last Prompt stats are reported by the *server*; `cache`% is prompt-cache hit
  ratio, not KV-cache memory.
- Live prefill %/t/s and the final `Last Prompt` rate use different
  denominators (live includes cache lookup; final is llama.cpp's
  `t_prompt_processing`), so live reads slightly lower than final.
- The live Gen rate is an estimate (the only in-flight source); the
  post-prompt Gen is the server's own measured rate when llama.cpp reports
  `predicted_n` / `predicted_ms`.
- The extension renders nothing until `session_start`; a placeholder
  ` ⚡ Gen -- t/s | Last Prompt -- t/s` appears on session start.

## License

MIT — see [LICENSE](./LICENSE).
