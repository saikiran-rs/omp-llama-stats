# omp-llama-stats

A fixed-width status line for **oh-my-pi (omp)** and **pi**, showing
server-reported generation speed, prompt-processing speed, and prompt-cache
counts.

```text
 ⚡ Gen  32.5 t/s | Last Prompt  180.3 t/s [Cache  97.3% |   935 new / 33.4K cached]
```

## Accuracy

**Version 0.5 uses server measurements only.** It does not count UI delta
events as tokens, learn a multiplier from previous responses, or infer decode
speed from network arrival times. Servers batch tokens and split text,
reasoning, and tool calls differently; those methods could report 100+ t/s
for a much slower response.

- **Gen:** the server's `timings.predicted_per_second`. Live values are the
  server's cumulative measurements, updated with `timings_per_token: true`.
  The final value uses the latest snapshot for each request. Across tool
  round trips, rates are weighted by `predicted_ms`, excluding tool execution
  and prefill. Repeated timing snapshots and `[DONE]` followed by EOF are
  counted once.
- **Last Prompt:** `timings.prompt_per_second`, or the server's
  `prompt_n / prompt_ms` when the rate field is absent. It belongs to the
  latest request. Time to first token includes queueing, network delivery,
  cache lookup, and decoding; it is never labeled prompt-processing speed.
- **Cache:** `cache_n / (prompt_n + cache_n)`. When timing fields are absent,
  `usage.prompt_tokens_details.cached_tokens` and `usage.prompt_tokens` can
  still establish the exact cache/new token counts.
- **Prefill progress:** `(processed - cache) / (total - cache)` from the
  server's `prompt_progress`. Percentages are floored so incomplete work
  cannot display 100%. Its rate uses the progress timer, which can differ
  from the final prompt-processing timer.

An unavailable measurement displays **`--`**. A server without timing fields
(e.g. many vLLM deployments and hosted APIs) supplies token counts but cannot
supply exact speed through standard OpenAI usage fields. Generation is also
unknown if a prompt includes a request with missing timings, fails, or is
cancelled. A multi-request average requires every request's decode duration.

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
  "stream_options": { "include_usage": true }
}
```

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

A new prompt or session clears measurements. Request records are tagged with
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

Unknown values remain `--`, including absent cache counts. A fully cached
prompt shows a 100.0% cache hit and no processing rate. Gen colors are red
below 15, orange from 15, green from 30, and blue from 45 t/s. Prompt rates
below 15 t/s are red. Color thresholds use the displayed rounded value.

Both metrics share one status key. omp renders a separate row per status key;
a blank `00-top-pad` entry adds space above the stats row. Pi joins entries
on one row. omp may strip ANSI colors.

## Testing

```sh
bun run test
```

The end-to-end harness uses a loopback HTTP SSE server and native provider
callbacks. It covers server rate fidelity, cumulative snapshots, weighted
multi-request averages, missing/invalid measurements, cache counts, prefill
progress, cancellation, stale responses, session isolation, Request-object
bodies, response-byte preservation, and fetch teardown.

## License

MIT — see [LICENSE](./LICENSE).
