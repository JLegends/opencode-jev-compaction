# opencode-jev-compaction

Two [opencode](https://opencode.ai) plugins that replace lossy compaction with
decisions: ask a fast model which tool calls and results are still needed, drop
or truncate the ones that aren't, and leave every user and assistant message
verbatim.

- **`./server`** — the pruner. Runs before every model request, and adds a note
  to the compaction prompt so shortened results aren't mistaken for failures.
- **`./tui`** — a sidebar widget showing how much context the pruner has removed.

Strategy adapted from [fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT). See [NOTICE](./NOTICE).

## Why

When a context window fills, the usual answer is to summarize old turns. A
summary is lossy: a file path, an exact error, or a constraint can vanish even
when it matters later. This never rewrites anything. It only removes what a
model says is no longer needed, and everything kept stays byte-for-byte.

opencode already has a pruner, but its decision is purely recency and size — it
keeps a fixed window of recent tool output and erases the rest. This one decides
by relevance.

## Install

```sh
opencode plugin opencode-jev-compaction --global
```

That detects both the `./server` and `./tui` entrypoints and writes each to the
right config (`opencode.json` for the server plugin, `tui.json` for the widget).
Restart opencode afterwards.

From a checkout instead:

```sh
opencode plugin github:JLegends/opencode-jev-compaction --global
```

## Configure

The key comes from the environment, or from the macOS Keychain if you point it at
one:

```sh
export TYPESAFE_API_KEY=...            # or:
export JEV_KEYCHAIN_SERVICE=...        # keychain service name
export JEV_KEYCHAIN_ACCOUNT=...        # keychain account name
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | API key. Required unless the keychain is configured. |
| `JEV_KEYCHAIN_SERVICE` / `JEV_KEYCHAIN_ACCOUNT` | — | Read the key from the macOS Keychain instead of the environment. |
| `JEV_COMPACTION` | on | `0` disables everything. |
| `JEV_COMPACTION_THRESHOLD` | `60000` | Estimated tokens before it engages. Below this it does nothing and costs nothing. |
| `JEV_KEEP_THRESHOLD` | `0.35` | Minimum probability for a call or result to be kept. Lower keeps more; a call below it is deleted outright, which is irreversible, so this is deliberately conservative. |
| `JEV_PRESERVE_RECENT` | `6` | Newest messages never touched. Values below `1` are clamped to `1`; setting it to `0` drops the results the model is actively using and causes re-run loops. |
| `JEV_MAX_STATE_TOKENS` | `25000` | Ceiling for the state sent to Jev. |
| `JEV_MAX_REQUEST_TOKENS` | `30000` | Ceiling for state plus one batch of questions. |
| `JEV_TRUNCATE_HEAD` | `300` | Characters of a dropped result kept before its note. |
| `JEV_SMALL_RESULT_CHARS` | `600` | Results at or below this size are shown to Jev in full instead of as a note. |
| `JEV_TIMEOUT_MS` | `20000` | Per-request timeout. Failures are skipped silently. |
| `JEV_DAILY_REQUEST_CAP` | `200` | Hard ceiling on Jev requests per day. |
| `JEV_MODEL` | `jev-latest` | Model name. |
| `JEV_BASE_URL` | System One endpoint | Override the endpoint. |
| `JEV_DEBUG` | off | `1` appends a trace to `~/.local/share/opencode/jev-compaction.log`. |

## Cost

Jev is priced per input token with free output. At the default 25k state ceiling
and the 200-request daily cap, worst-case spend is about **$0.21/day**, and it
cannot exceed that. It also removes input tokens from every subsequent request,
which is the point.

Set `JEV_DAILY_REQUEST_CAP` lower if you want a tighter bound.

## Metrics

Savings alone do not tell you whether the decisions are good, so the plugin records
the cost of being wrong too. All of it lives in `~/.local/share/opencode/`:

| File | What it is |
| --- | --- |
| `jev-compaction.json` | Running totals. `tokensSaved` uses the same calibrated estimator as the threshold, not a characters-per-token guess. |
| `jev-compaction-ledger.jsonl` | One line per run that changed something, for analysis over time. |
| `jev-compaction-usage.json` | Requests made today, against the daily ceiling. |
| `jev-compaction.log` | Per-decision trace, only when `JEV_DEBUG=1`. |

The totals include:

- `runs`, `tokensSaved`, `callsSeen`, `dropped`, `truncated`
- **`rerunAfterDrop`** and **`rerunAfterTruncate`** — the metrics that matter. A
  re-run is detected when the model issues the same tool call, with the same input,
  under a new id, after we removed or shortened the original. That is a decision the
  model had to pay to undo.
- `transformCalls`, `engaged`, `belowThreshold`, `capReached`, `overflow`, `noKey` —
  so you can tell "working well" apart from "never ran".

How to read it: if `rerunAfterDrop` climbs alongside `dropped`, the keep threshold is
too high or the questions are being asked about content Jev cannot see. If `dropped`
stays near zero and `belowThreshold` dominates, the trigger is higher than your
sessions ever reach and the plugin is dormant — raise nothing, lower
`JEV_COMPACTION_THRESHOLD` if you want it to actually act.

Each ledger line carries `tokensBefore`, `tokensAfter`, `tokensSaved`, `dropped`,
`truncated`, `requests`, `stage`, the re-run counts, and the `session`, so savings and
mistakes can be attributed rather than averaged over everything.

## How it works

1. Every finished `tool` part is a candidate, except those in the first message
   or the newest `JEV_PRESERVE_RECENT` messages, which are pinned.
2. The whole conversation is sent as state, oldest first, with tool outputs
   replaced by a short note (`ok, 4213 chars (omitted)`). Tool inputs and all
   text are included. The state is shrunk in stages until it fits
   `JEV_MAX_STATE_TOKENS`: inputs truncated to 1000, then 200, then 60
   characters; long texts abridged head and tail; old messages collapsed;
   old calls reduced to one line each. If it still doesn't fit, the run is
   skipped.
3. Jev answers two graded questions per call: should the **call** stay, and
   should the **result** stay verbatim. Questions are split into as many
   requests as needed so state plus questions fits `JEV_MAX_REQUEST_TOKENS`, and
   those requests run concurrently.
4. `keepResult >= threshold` keeps both. Otherwise `keepCall >= threshold` keeps
   the call and truncates the result to its first `JEV_TRUNCATE_HEAD`
   characters. Otherwise the call and its result go.
5. Decisions are cached per call for the life of the process and are monotonic:
   once dropped, always dropped.

Nothing here throws. A missing key, a timeout, a malformed answer, or a history
too large to fit leaves the messages exactly as they were, so a Jev outage can
slow nothing down and break nothing.

## Requirements

- opencode `>= 1.18.31`
- A TypeSafe API key with access to Jev

## Not affiliated

Not built by, endorsed by, or affiliated with the opencode team or TypeSafe.
"opencode", "Jev", and "TypeSafe" are used only to describe what this plugs into.

## License

MIT. The compaction strategy is adapted from
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT) —
see [NOTICE](./NOTICE).
