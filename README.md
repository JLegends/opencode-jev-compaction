# opencode-jev-compaction

Two [opencode](https://opencode.ai) plugins that shrink context by **deleting what is
provably stale and truncating what is probably done with** — never by summarizing.

- **`./server`** — the pruner, a server plugin that runs before every model request.
- **`./tui`** — a sidebar widget showing how much context it removed.

Runs entirely locally by default. No API key, no per-request cost.

## Why this looks the way it does

v0.1 asked a hosted model a **judgement** per tool call ("should this still be in the
history?"). That failed in a specific, instructive way: it deleted a short file of hard
constraints, and the scores were mushy. Two independent measurements agreed on the cause —
with a `noul`-style primitive (calibrated P(true)), **factual questions are reliable and
judgement questions are not** (0.996 on an explicit fact versus 0.003–0.28 on judgements).

It was also expensive. A 25k-token state resent on every request, roughly 1,000 times a
day, cost about **$1/day** — against a saving measured at $0.0001 on a model whose cached
input is $0.003/M. The economics were upside down.

v0.3 asks **only facts**, computes the ones it can exactly, and treats the model as a
narrow refinement rather than the decision-maker.

## How it decides

| reason | how | action |
| --- | --- | --- |
| `referenced` | the target string (path, command) appears in later **prose** — exact search | keep |
| `superseded` | a later call with the same tool and target — exact | **drop** |
| `error-resolved` | this call errored, a later call to the same target succeeded — exact | **drop** |
| `small-result` | under `SMALL_RESULT_CHARS`, not worth touching | keep |
| `model-unreferenced` | large, unmentioned, not superseded; local model says nothing quotes it | truncate |
| `model-referenced` | as above, but the model says something does | keep |
| `inconclusive` | the question could not be answered (no backend, timeout, low confidence) | truncate |

**Deletion requires deterministic evidence.** A model answer can only ever cause a
*truncation*, which keeps a bounded head plus a `[laya-compaction truncated …; re-run the
tool if needed]` note, so the model can recover by re-running. Nothing is ever deleted on a
probabilistic answer.

## Install

```sh
opencode plugin opencode-jev-compaction --global
```

Then run the local backend:

```sh
# once
uv venv -p 3.12 ~/laya-server/.venv
uv pip install -p ~/laya-server/.venv laya-mlx

# run (first start downloads a few hundred MB of weights)
~/laya-server/.venv/bin/python ~/opencode-jev-compaction/scripts/laya-server.py
```

`laya-server.py` is a thin transport: Laya already returns the Jev response shape, so it
exists only so the plugin can speak HTTP to a local process. It binds `127.0.0.1:8000` and
serializes inference (MLX is not reliably reentrant).

To keep it running across logins, wrap that command in a launchd agent or run it under
`tmux`. Startup takes a few seconds plus the one-time download.

## Configure

| Variable | Default | Purpose |
| --- | --- | --- |
| `LAYA_BASE_URL` | `http://127.0.0.1:8000/v1/systemone` | Backend endpoint. A hosted Jev endpoint works too. |
| `LAYA_COMPACTION` | on | `0` disables everything. |
| `LAYA_COMPACTION_THRESHOLD` | `60000` | Estimated context tokens before it engages. |
| `LAYA_PRESERVE_RECENT` | `6` | Newest messages never touched, minimum 1. |
| `LAYA_SMALL_RESULT_CHARS` | `600` | Results this size or smaller are left alone. |
| `LAYA_TRUNCATE_HEAD` | `300` | Characters kept when a result is truncated. |
| `LAYA_EXCERPT_CHARS` / `LAYA_AFTER_CHARS` | `400` / `1000` | What the model sees. Keep these small: Laya's sequence budget is 512 tokens. |
| `LAYA_REFERENCED_HIGH` | `0.7` | Probability of "quotes" needed to keep. |
| `LAYA_TIMEOUT_MS` / `LAYA_CONCURRENCY` | `8000` / `4` | Per-question timeout, parallel questions. |
| `LAYA_MAX_QUESTIONS` | `40` | Cap on model questions per prune. |
| `LAYA_DAILY_REQUEST_CAP` | `400` | Requests per day, per process. |
| `LAYA_DEBUG` | off | `1` appends a trace to `~/.local/share/opencode/laya-compaction.log`. |

## Degraded mode

If the backend is unreachable, times out, or answers below `LAYA_REFERENCED_HIGH`, the
`model-*` rows simply do not apply: the deterministic reasons still fire and every residual
becomes `inconclusive` → truncate. The plugin is fully functional without any model, and
`LAYA_COMPACTION=0` turns it off entirely.

## Metrics and reporting

`~/.local/share/opencode/laya-compaction.json` (totals), `-ledger.jsonl` (one line per run
that changed something, with the reason breakdown and re-run counts), `-usage.json`.

```sh
npm run report
```

Reports engagement, the reason breakdown, whether decisions are good (re-run rate),
pruned vs unpruned sessions, before/after the install boundary, and the subagent cost share
measured directly. It refuses to print a quality verdict when the installed version does
not record re-runs, so a `0` cannot be misread as "nothing was undone".

## Measured caveats

Recorded here because they are the reason the design is conservative:

- **`noul` cannot answer a statement about text.** Against this same local model, a
  statement and its own negation both scored ~0.95. As a two-option `choice` with explicit
  criteria, the same cases separate cleanly (0.75–0.99 on a real quote, 0.80–0.91 on
  unrelated text). That is why the code uses `choice` and says not to change it back.
- **The model sees only about 1000 characters of what came after** — Laya's sequence budget
  is 512 tokens. Remote references are found by the exact string search, not by the model.
- **Accuracy is model- and task-specific.** Independent comparison found the hosted Jev
  model ahead of open-weight Laya on ambiguous inputs (78% vs 57% on 40 tickets), and
  confidently wrong on a multi-intent case. That is a small sample: treat it as directional.
- **Correlation, not causation, in the cohort tables.** A session is only pruned once it is
  large, so the pruned cohort is longer by construction.

## Not affiliated

Not built by, endorsed by, or affiliated with the opencode team, TypeSafe, or Convai
Innovations. Names are used only to describe what this plugs into.

## License

MIT. The original strategy was adapted from
[fast-jev-compaction](https://github.com/tamaratran/fast-jev-compaction) (MIT) — see
[NOTICE](./NOTICE). v0.3 diverges from it substantially: the decision core is now
deterministic, and the model is an optional local refinement.
