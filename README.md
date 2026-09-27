# omp-llama-stats

One fixed-width status line for local-model speed stats in **oh-my-pi (omp)**
(also works in **pi**): generation throughput and last-prompt processing speed
from **any OpenAI-compatible server** — llama.cpp / LM Studio, vLLM, SGLang,
TGI, and hosted APIs. llama.cpp's exact server-side timings are used when the
server reports them; everything else is measured from the stream itself.

```
...last assistant response line

 ⚡ Gen 129.1 t/s | Last Prompt ··72.0 t/s [Cache ··0.0% | ··935 new / ····0 cached]
~ (main*) ... lmstudio/big
```

- **Gen** — generation tokens/sec, live (1s sliding window) and final. Final
  prefers llama.cpp's measured decode timing, then a stream-derived decode
  rate that works on any engine (see *Engine-agnostic rates* below).
- **Last Prompt** — prompt-processing tokens/sec from llama.cpp's SSE progress
  data, with new-token and cache-hit counts.
- **Prefill progress** — while the server processes the prompt, the working
  message shows `Prefilling... 42% · ·180.3 t/s`.
- **Fixed width** — every number sits in a fixed-width slot, so the line
  never grows or shrinks as values go from 1 to 10 to 100 digits (`·` in
  this README marks the invisible fill; see *Status line format*).
- **Top padding** — a blank line between the transcript and the status row
  (omp-specific; see below).

Gen works against any provider. Last Prompt uses llama.cpp's `timings` when
present, and otherwise falls back to tokens processed / TTFT for any server
that returns a usage block.

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

One line, always the same length:

```
 ⚡ Gen {gen} t/s | Last Prompt {pp} t/s [Cache {pct}% | {new} new / {cached} cached]
```

Rules:

- Every value is right-aligned in a fixed-width slot: `gen` 5 chars
  (`999.9`), `pp` 6 (`9999.9`), `pct` 5 (`100.0`), `new` / `cached` 5
  (`33.4K`). A rate too large for its slot drops the decimal instead
  (`1234`); only a Gen above 99999 t/s could widen the line.
- The fill is U+2007 FIGURE SPACE: blank and exactly one digit wide. It has
  to be — omp's and pi's status sanitizers collapse runs of ASCII spaces and
  trim, which would undo ordinary space padding. On copy-paste the fill
  comes through as U+2007 characters.
- Rates: always 1 decimal (302.0), rounded half-up. Cache percent: exactly
  1 decimal, half-up.
- All rounding is done on integers (token counts, microseconds), so ties
  are exact: 933 tokens / 20 s = 46.65 shows 46.7, and 23 of 80 cached =
  28.75% shows 28.8% (float `toFixed` gives 46.6 and 28.7).
- `Last Prompt` is per-request, never a rolling average.
- Token counts: raw integer below 1000; then one decimal + `K`, trailing
  `.0` dropped (2600 becomes 2.6K, 2650 becomes 2.7K, 33398 becomes 33.4K);
  whole `K` from 100K (133K), then `M` (999500 becomes 1M).
- `Cache` pct = cached / (new + cached).
- Cold start (no cached tokens): `Cache 0.0%`, cached `0`.
- Fully-cached prompt (nothing processed): the rate reads `--` — no tokens
  ran through the model, so there is no rate to show.
- A value the server does not report reads `--`, never a guessed 0: engines
  that do not return `prompt_tokens_details.cached_tokens` show
  `Cache --% | -- new / -- cached`, and llama.cpp builds without
  `timings.cache_n` show `-- cached`.
- Before the first data arrives, every slot reads `--`.
- The line starts with a single leading space (omp trims it).
- Color is the only non-plain part:
  - `Gen` rate: original pi-token-speed ladder — red < 15 ≤ orange < 30 ≤
    green < 45 ≤ blue t/s (truecolor), judged on the displayed value, so
    `15.0` is never red.
  - `Last Prompt` rate: red (`#ff4444`) below 15 t/s, otherwise no color.
  - omp's status-line sanitizer strips ANSI, so in omp the line renders
    plain; colors show in pi.

Examples (`·` marks the U+2007 fill; it renders blank):

```
 ⚡ Gen ·68.4 t/s | Last Prompt ·302.0 t/s [Cache ·97.3% | ··935 new / 33.4K cached]
 ⚡ Gen 112.7 t/s | Last Prompt 1840.7 t/s [Cache ··1.8% | 33.4K new / ··599 cached]
 ⚡ Gen ·94.2 t/s | Last Prompt ·871.5 t/s [Cache ··0.0% | 12.1K new / ····0 cached]
 ⚡ Gen ·12.3 t/s | Last Prompt ····-- t/s [Cache 100.0% | ····0 new / ··26K cached]
 ⚡ Gen ·50.0 t/s | Last Prompt 2431.9 t/s [Cache ···--% | ···-- new / ···-- cached]
 ⚡ Gen ···-- t/s | Last Prompt ····-- t/s [Cache ···--% | ···-- new / ···-- cached]
```

## Requirements

- omp (any recent build) or pi. The extension imports
  `@earendil-works/pi-coding-agent` types only; omp's pi-compat layer rewrites
  the specifier onto its bundled host copy, so no dependency install is needed.
- `bun` in `$PATH` at install time (the omp installer uses it to fetch the
  git source). Not needed at runtime — the extension is dependency-free.
- For PP: an OpenAI-compatible endpoint that accepts
  `return_progress: true` (LM Studio `http://<host>:1234/v1`,
  llama.cpp `llama-server`). Only local/private hosts (localhost,
  *.localhost, *.local, 0.0.0.0, 127.*, 10.*, 192.168.*, 172.16-31.*,
  169.254.*, 100.64-127.* (CGNAT / Tailscale), ::1, fc00::/7, fe80::/10)
  are treated as llama.cpp — cloud providers never get `return_progress`
  injected (OpenAI 400s on it).
  Set `OMP_LLAMA_HOST=host:port` to pin an explicit host.

## How it works (the parts worth reusing)

Single file: `index.ts` (no runtime dependencies).

### 1. Gen — generation speed

Ported from [`pi-token-speed`](https://www.npmjs.com/package/pi-token-speed)
(0.7.1), diverged where estimation mattered — the `/tps` settings menu is
intentionally not ported. The engine:

- listens to `message_update` events: `text_start`/`thinking_start`/
  `toolcall_start` start a stream; `text_delta`/`thinking_delta`/
  `toolcall_delta` each record one delta's worth of tokens (1 on llama.cpp,
  the host's learned tokens-per-delta elsewhere) — tool-call argument tokens
  are counted because `usage.output` includes them; every `toolcall_end`
  `pause()`s the timer, so the excluded time is exactly the dead gap (tool
  execution + next prefill);
- live TPS while streaming = tokens in the last 1000 ms (sliding window,
  span clamped to 100 ms minimum to avoid burst spikes), computed at read
  time so a stalled stream decays instead of pinning. Until two deltas
  exist there is no interval to measure, so the slot shows the settled
  value (or `--`) instead of a red `0`; the window restarts after a pause,
  so tool time never dilutes the first reading after it;
- while paused (tool running, next request prefilling) the line shows the
  settled rate of the prompt's completed requests so far;
- **final** Gen prefers llama.cpp's own measurement:
  `(timings.predicted_n - 1) / predicted_ms`, accumulated across the
  prompt's requests — server-side, immune to pause bookkeeping and network
  jitter. `- 1` because the first token is free (it comes from the last
  prompt batch's logits), so `predicted_ms` spans `predicted_n - 1` decode
  steps; llama.cpp's own `predicted_per_second` divides the same way.
  Dividing `predicted_n` overstated short replies (10 tokens: +11%).
  The last fallback is the engine's own average: the tokens after the first
  delta over first-delta -> last-delta time minus tool pauses (the same n-1
  rule; `agent_end` latency is not generation time), shown only once it
  spans 100 ms so a few deltas cannot spike it;
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
   - `chunk.prompt_progress` → live prefill % (floored, so `100%` only means
     done) + t/s in the working message, both in fixed-width slots;
   - `chunk.timings.prompt_n` / `prompt_ms` (+ `cache_n`) → the final Last
     Prompt stat, held until the next response; missing `cache_n` (older
     llama.cpp) warns once and reads as unknown (`--`);
   - `chunk.timings.predicted_n` / `predicted_ms` → accumulated into the
     exact final Gen rate. The last `timings` block of a response wins, so
     a server that repeats it (`timings_per_token`) is counted once;
   - content, reasoning **and tool-call** deltas → the decode interval for
     engines without `timings` (tool-call argument tokens are in
     `usage.completion_tokens`, so their chunks belong in the interval);
   - each response is finalized exactly once (`[DONE]` followed by the
     connection close used to count it twice), a last line without a
     trailing newline is still parsed, and `data:` without a space is
     accepted;
   - an error in the stats code is swallowed — it never breaks the stream
     the agent is reading;
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
statuses. In pi (where statuses are joined on one line with a space) this
entry sanitizes to empty, and the join leaves one leading space before the
line.

## Customizing

Everything is a module-level constant in `index.ts`:

| Constant | Meaning |
| --- | --- |
| `SLIDING_WINDOW_MS` | TPS smoothing window (default 1000) |
| `TPS_THRESHOLDS` | `[t/s, hex]` color ladder for the Gen rate |
| `STATUS_KEY` / `PAD_KEY` | status keys (rename if another extension collides) |

Env: `OMP_LLAMA_HOST` (e.g. `127.0.0.1:8080`) pins the llama.cpp host;
without it, local/private hosts match per request.

## Engine-agnostic rates (the vLLM fix)

Reported bug: **vLLM showed roughly half (or less) of the real generation
rate**, while llama.cpp read correctly. Measured against a live vLLM 0.28
(Qwen3.8-27B, TP4) there were **two independent causes**, both from assuming
llama.cpp's stream shape:

| | real decode | old live (1 tok/delta) | old final (wall clock) |
|---|---:|---:|---:|
| short prompt | 59.4 | 28.3 | 57.8 |
| 10K-token prompt | 50.0 | 20.2 | **5.6** |

1. **Engines batch tokens into SSE chunks.** llama.cpp emits one token per
   chunk, so "count 1 token per delta" was right there. vLLM packs **2.1-2.5
   tokens per chunk** (measured), so the live rate read ~1/2 to ~1/3 of real.
   Fixed by learning the ratio from the previous response's
   `usage.completion_tokens / delta events` (one per text, reasoning and
   tool-call entry, the way the host emits them) and scaling the live
   counter. The ratio is kept **per host**, so a batching engine on one
   port never skews a llama.cpp server on another.
2. **The non-llama fallback divided by wall clock, which includes prefill.**
   At a 10K prompt, TTFT is ~33 s against ~4 s of decode, so the reported rate
   collapsed to 5.6 t/s. Fixed by timing the **decode interval only** — first
   content delta to last content delta — and dividing
   `usage.completion_tokens - 1` by it. (`n-1`: the interval spans one fewer
   inter-token gap than there are tokens.) Tool-call argument chunks are
   part of that interval: counting only text chunks divided a tool call's
   argument tokens by the few milliseconds of text before it (a 20-token
   call after 2 quick text chunks read ~400 t/s instead of ~36).

Precedence for the settled Gen rate, best source first:

1. `(timings.predicted_n - 1) / predicted_ms` — llama.cpp's own decode
   timing, exact and server-side;
2. **stream-derived decode rate** — any OpenAI-compatible engine, excludes
   prefill;
3. the engine's delta-interval average — only for providers the fetch hook
   does not see (no usage block reaches it).

Verified end-to-end against the live server: ground truth 48.7 t/s, patched
extension 48.7 t/s (0.0% error), old behaviour 24.1 t/s.

`Last Prompt` on a server without `timings` is tokens processed / TTFT.
When the server reports `prompt_tokens_details.cached_tokens` (e.g. vLLM
with `--enable-prompt-tokens-details`), only the uncached tokens count —
the same numerator as llama.cpp's `prompt_n` — and the bracket shows the
split. Without that report the whole `prompt_tokens` counts: an
**effective** rate that an unreported prefix-cache hit inflates (a cached
14K prompt reads ~3900 t/s), and the bracket reads `--` because the split
is unknown. Treat that case as time-to-first-token throughput.

## Notes / caveats

- The fetch hook is process-wide: every session in the omp process routes
  llama-host `/chat/completions` requests through it — including subagents
  and any streamed side request (e.g. title generation) to the same local
  server, whose timings land in the same line. Non-llama traffic is
  untouched.
- Last Prompt stats are reported by the *server*; `cache`% is prompt-cache hit
  ratio, not KV-cache memory.
- Live prefill %/t/s and the final `Last Prompt` rate use different
  denominators (live includes cache lookup; final is llama.cpp's
  `t_prompt_processing`), so live reads slightly lower than final.
- The live Gen rate is an estimate (the only in-flight source); the
  post-prompt Gen is the server's own measured rate when llama.cpp reports
  `predicted_n` / `predicted_ms`, else the stream-derived decode rate.
- The live tokens-per-delta scale is learned from the **previous** response
  on the same host, so the very first response to a batching engine
  estimates live Gen at 1 token/delta. The settled value does not use it.
- For providers the hook cannot see (cloud APIs) the settled Gen is
  `usage.output` over the client-side delta interval, which includes network
  delivery jitter and estimates the first chunk's size from the learned
  tokens-per-delta — an estimate, not a server measurement.
- The extension renders nothing until `session_start`; the all-`--`
  placeholder line appears on session start.

## Testing

`bun run test` (or `bun test/e2e.ts`) — runs the e2e harness
(`test/e2e.ts`). Plain `bun test` looks for `*.test.ts` files and runs
nothing. The harness imports the real extension and drives it against mock
OpenAI-compatible SSE servers on 127.0.0.1: llama.cpp timings, vLLM-style
batched chunks, tool calls, cache splits, SSE edge cases, exact rounding,
live-estimate scaling, fixed line width through the hosts'
space-collapsing sanitizer, and fetch teardown. Requires bun.

## License

MIT — see [LICENSE](./LICENSE).
