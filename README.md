# omp-llama-stats

A fixed-width status line for **oh-my-pi (omp)** and **pi**, showing
server-reported generation speed, prompt-processing speed, and prompt-cache
counts.

```text
 ⚡ Gen  32.5 t/s | Last Prompt  180.3 t/s [Cache  97.3% |   935 new / 33.4K cached]
```

## Accuracy

**Server timing is authoritative.** The final value comes from the server;
when the server omits live timing, a live delivery estimate is prefixed with
`~` (for example, `Gen ~32.1 t/s`). Version 0.5.1 restores this live display
for proxies that send `timings` only in the final chunk, version 0.5.2
keeps the last prompt measurement visible while the next one is still being
computed, version 0.5.3 stops coloring a nearly cached prompt red, and version
0.5.4 publishes it as soon as prefill finishes instead of waiting for the end
of the response, and version 0.6.0 stops generation speed blanking between
requests and prompts. Version 0.7.0 makes that marker a steady `~` that means
only "decoding now" and disappears without moving the digits when the response
settles. None of them ever learns a multiplier from a previous response or
counts Pi UI events as tokens.

- **Gen:** the server's `timings.predicted_per_second`. When nothing has been
  measured yet on this endpoint it shows `--`; afterwards it never blanks, see
  **Display** for the three markers. Live values are the
  server's cumulative measurements, updated with `timings_per_token: true`.
  When those fields are unavailable during streaming, the live estimate uses
  the current response's cumulative completion-token counter if supplied;
  otherwise it counts nonempty generated SSE frames once, including reasoning
  and tool-call arguments. This is approximate because frames can batch tokens
  and network delivery can arrive in bursts. Empty role/metadata frames do not
  count. The clock starts at the first generated frame, excluding TTFT, with a
  500 ms minimum denominator to smooth bursts. It is a current-response average,
  not an instantaneous server decode rate. The final value uses the latest
  server snapshot for each request. Across tool
  round trips, rates are weighted by `predicted_ms`, excluding tool execution
  and prefill. Repeated timing snapshots and `[DONE]` followed by EOF are
  counted once.
- **Last Prompt:** `timings.prompt_per_second`, or the server's
  `prompt_n / prompt_ms` when the rate field is absent. It is the most recent
  measurement made by the current model and endpoint, so it stays on screen
  while the next request is prefilling and generating — servers that report
  timings only on the terminal chunk would otherwise blank it for the whole of
  every response. A measurement is never inherited by a different model or
  server, and a new session starts blank. Time to first token includes
  queueing, network delivery, cache lookup, and decoding; it is never labeled
  prompt-processing speed. It is only called slow once at least 100 new tokens
  ran through the model: slot lookup, cache find and first-batch setup cost a
  fixed amount of time, so a 99%-cached turn divides a handful of tokens by
  mostly-overhead milliseconds and reports a low rate for a server that is
  otherwise fast. The red warning therefore keys on the size of the sample
  rather than the cache percentage, which would also hide a large prefill that
  genuinely stalled. The value is published the moment `prompt_progress` reports
  the prefill complete, so it is on screen while the model is still answering;
  the server's terminal `timings` figure then replaces it, because the server
  owns that timer.
- **Cache:** `cache_n / (prompt_n + cache_n)`. When timing fields are absent,
  `usage.prompt_tokens_details.cached_tokens` and `usage.prompt_tokens` can
  still establish the exact cache/new token counts.
- **Prefill progress:** `(processed - cache) / (total - cache)` from the
  server's `prompt_progress`. Percentages are floored so incomplete work
  cannot display 100%. Its rate uses the progress timer, which can differ
  from the final prompt-processing timer, so an unfinished progress frame is
  never published as a measurement — only the frame that reports the prefill
  complete.

One marker says whether the generation number is still moving:

| Shows | Meaning |
| --- | --- |
| `Gen ~34.9 t/s` | a response is **decoding now**, so the number is provisional — the server's measurement of this answer, a live delivery estimate, or briefly a held rate while the current response has measured nothing |
| `Gen 34.9 t/s` | settled: nothing is decoding, and this is the last rate the endpoint's measured responses produced |

The marker replaces a digit slot and toggles only between `~` and a figure
space, so the digits never shift and the row never jumps as decoding starts and
stops. It does not blink: an always-visible status line flickering is noise, and
pi rebuilds styles through its theme layer while omp may strip ANSI, so an
attribute-based blink could silently stop signalling at all.

Only a session's first response can show `--` for Gen, and only until something
is measured: after that the line holds the last real rate instead of blanking
between tool round trips, at the start of a new prompt, and after an aborted or
unmeasured request. A model or endpoint switch and a new session clear the held
rate, so a number is never inherited by a different server. While streaming, the
current response's rate is shown even if an earlier tool round trip lacked
timing. The final value is `--` only when nothing has ever been measured here: a
server without timing fields (e.g. many vLLM deployments and hosted APIs)
supplies token counts but cannot
supply exact speed through standard OpenAI usage fields. Generation is also
unknown if a prompt includes a request with missing timings, fails, or is
cancelled, so its aggregate is not reported; the held rate stays visible. A
multi-request average requires every request's decode duration. A
request that fails after its prefill completed keeps that prompt measurement,
because the work really happened; only an unfinished one is discarded.

The server defines its rate: llama.cpp builds differ in whether the decode
numerator is `predicted_n` or `predicted_n - 1`. The extension copies the
reported rate rather than assuming either convention. It cannot independently
prove a server's internal timing accuracy. Values are rounded for display:
rates and cache percentages to one decimal, large counts abbreviated as K/M.

## Install

```sh
# oh-my-pi
omp plugin install github:saikiran-rs/omp-llama-stats

# pi
pi install github:saikiran-rs/omp-llama-stats
```

The omp installer requires `bun` in your PATH. Runtime has no dependencies.
Restart the session after installation, or use `/reload` in Pi to reload
extensions after an update.

Update Pi's installed copy:

```sh
pi update git:github.com/saikiran-rs/omp-llama-stats
```

If `pi-token-speed` is installed, disable it: both extensions write the same
`tokenSpeed` status key.

## Server support

llama.cpp-compatible local endpoints receive these options on streaming chat
completion requests:

```json
{
  "return_progress": true,
  "timings_per_token": true,
  "stream_options": { "include_usage": true, "continuous_usage_stats": true }
}
```

`continuous_usage_stats` requests per-chunk cumulative token counts from
backends that support it. A proxy may ignore that option and send usage/timings
only at the end; live Gen then remains an explicitly marked estimate.

The request must target `/chat/completions`. The options are applied to
local/private hosts: localhost, *.localhost, *.local, 127.*, 10.*, 192.168.*,
172.16–31.*, link-local addresses, CGNAT/Tailscale addresses, and private IPv6.
A private address alone does not establish backend compatibility: its server
or proxy must accept these llama.cpp options and forward timing fields.

To select an explicit host instead:

```sh
OMP_LLAMA_HOST=host:port pi
```

Cloud requests do not receive llama.cpp-specific options. Modern Pi's native
provider events can read timing fields from any provider that supplies them.

## Session and request isolation

Modern Pi's `before_provider_request` and `provider_stream_event` hooks scope
measurements to the current session. The fetch observer matches the main
request's model and messages; title generation and other payloads do not enter
its totals. Native events also work when the provider uses a custom transport.
Both observers update the same request record, so observing a response through
both paths cannot double-count it.

Older Pi/omp hosts use a fetch fallback, restricted to the active model and
endpoint when supplied by the host. Such hosts cannot distinguish a side
request using that same model and endpoint; use a host with native provider
hooks when running concurrent requests in the same process.

A new prompt clears the *live* generation aggregate; a new session clears
every measurement. Both metrics then keep showing the last value their endpoint
measured, marked `~` while a response is decoding, until a newer one replaces
it. Each measurement carries the model and endpoint that produced it, so
switching either hides the old number before a frame can be mistaken for the new
server's. Request records are tagged with
a generation number, so late responses from an earlier prompt cannot overwrite
current statistics. Full-session `usage.output` and tool-result usage never
enter the speed calculation.

The fetch observer forwards original response bytes and cancellation. It
supports split SSE reads, multiline `data:` fields, CRLF, optional spaces,
and a final event without a newline. Stats/UI failures do not alter model
output. Shutdown restores the original fetch only when its wrapper is still
on top.

## Display

Every numeric field has a fixed-width slot, padded with U+2007 FIGURE SPACE
(which survives the hosts' ASCII-space sanitizers): Gen 5 characters, prompt
rate 6, cache percentage 5, and token counts 5. Large rates drop their decimal
when needed; extreme values can exceed the slot. Token counts below 1000
are integers; larger counts use K/M abbreviations.

Unknown values remain `--`, including absent cache counts. The generation marker
consumes a digit of its slot, so `Gen ~34.9` occupies exactly the width of
`Gen 34.9` and the row cannot reflow as decoding starts and stops. A fully cached
prompt shows a 100.0% cache hit and no processing rate. Gen colors are red
below 15, orange from 15, green from 30, and blue from 45 t/s. Prompt rates
below 15 t/s are red once at least 100 new tokens were processed; see
**Last Prompt**. Color thresholds use the displayed rounded value.

Both metrics share one status key. omp renders a separate row per status key;
a blank `00-top-pad` entry adds space above the stats row. Pi joins entries
on one row. omp may strip ANSI colors.

## Testing

```sh
bun run test
```

The end-to-end harness uses a loopback HTTP SSE server and native provider
callbacks. It covers positive live Gen with end-only timing, estimate markers,
one-count-per-frame behavior, server rate fidelity, cumulative snapshots, weighted
multi-request averages, missing/invalid measurements, cache counts, prefill
progress, cancellation, stale responses, session isolation, Request-object
bodies, a Last Prompt value that survives the requests and prompts it is
waiting to be replaced by, model and server switches, the slow-prompt color
gate, a prompt measurement published at the end of prefill and refined by the
terminal timings, the decoding marker and the held generation rate,
response-byte preservation, and fetch teardown.

## License

MIT — see [LICENSE](./LICENSE).
