#!/usr/bin/env node
// Measurement report for the jev-compaction plugin.
//
// Joins the plugin's own telemetry (what it removed, and whether the model had to
// re-run anything) to opencode's session records (what each session actually cost,
// how many tools it ran, how long it took). Neither half answers anything alone:
// savings without outcomes, or outcomes without knowing whether the plugin ran.
//
//   node scripts/report.mjs                 # markdown to stdout
//   node scripts/report.mjs --days 14       # limit the window
//   node scripts/report.mjs --json          # raw aggregates
//   node scripts/report.mjs --exclude ses_a,ses_b
//
// Reads: ~/.local/share/opencode/jev-compaction{,-ledger.jsonl,-usage.json}
//        and the session database via `opencode db ... --format json`

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const STATE = join(homedir(), ".local", "share", "opencode")
const STATS_FILE = join(STATE, "laya-compaction.json")
const LEDGER_FILE = join(STATE, "laya-compaction-ledger.jsonl")
const USAGE_FILE = join(STATE, "laya-compaction-usage.json")

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  return index > -1 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const DAYS = Number(arg("days", "0")) || 0
const EXCLUDE = new Set(String(arg("exclude", "")).split(",").map((s) => s.trim()).filter(Boolean))
const AS_JSON = process.argv.includes("--json")

// `opencode db` truncates its output at 64KB, which a full session table exceeds, so
// resolve the database path through opencode and query it directly.
const DB = execFileSync("opencode", ["db", "path"], { encoding: "utf8" }).trim()

function query(sql) {
  const out = execFileSync("sqlite3", ["-json", DB, sql], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
  return out.trim() ? JSON.parse(out) : []
}

/** The model column is a JSON blob. */
function modelId(raw) {
  try {
    return JSON.parse(raw).id ?? "unknown"
  } catch {
    return raw ?? "unknown"
  }
}

function ledger() {
  try {
    return readFileSync(LEDGER_FILE, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

function stats() {
  try {
    return JSON.parse(readFileSync(STATS_FILE, "utf8"))
  } catch {
    return {}
  }
}

function usage() {
  try {
    return JSON.parse(readFileSync(USAGE_FILE, "utf8"))
  } catch {
    return {}
  }
}

const median = (values) => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}
const sum = (values) => values.reduce((total, value) => total + value, 0)
const money = (value) => (value === null ? "-" : `$${value.toFixed(2)}`)
const num = (value) => (value === null ? "-" : Math.round(value).toLocaleString())
const pct = (a, b) => (b > 0 ? `${((a / b) * 100).toFixed(1)}%` : "-")

// --- gather -------------------------------------------------------------------

const sessions = query(`
  select id, parent_id, model, cost,
         tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
         time_created, time_updated
  from session
`)

const toolCounts = new Map(
  query(`select session_id, count(*) as tools from part where json_extract(data,'$.type')='tool' group by session_id`)
    .map((row) => [row.session_id, Number(row.tools)]),
)

const events = ledger()
const pruneBySession = new Map()
for (const event of events) {
  if (!event.session) continue
  const current = pruneBySession.get(event.session) ?? { tokensSaved: 0, dropped: 0, truncated: 0, requests: 0, rerunDrop: 0, rerunTruncate: 0, runs: 0 }
  current.tokensSaved += event.tokensSaved ?? 0
  current.dropped += event.dropped ?? 0
  current.truncated += event.truncated ?? 0
  current.requests += event.requests ?? 0
  current.rerunDrop += event.rerunAfterDrop ?? 0
  current.rerunTruncate += event.rerunAfterTruncate ?? 0
  current.runs += 1
  pruneBySession.set(event.session, current)
}

const cutoff = DAYS > 0 ? Date.now() - DAYS * 86_400_000 : 0

const decorated = sessions
  .filter((row) => !EXCLUDE.has(row.id))
  .filter((row) => !row.parent_id)
  .filter((row) => (Number(row.time_created) || 0) >= cutoff)
  .map((row) => {
    const prune = pruneBySession.get(row.id)
    const tokens =
      (Number(row.tokens_input) || 0) + (Number(row.tokens_output) || 0) + (Number(row.tokens_cache_read) || 0)
    return {
      id: row.id,
      model: modelId(row.model),
      cost: Number(row.cost) || 0,
      tokens,
      tools: toolCounts.get(row.id) ?? 0,
      minutes: Math.max(0, ((Number(row.time_updated) || 0) - (Number(row.time_created) || 0)) / 60_000),
      created: Number(row.time_created) || 0,
      pruned: Boolean(prune),
      prune,
    }
  })

// Subagent share: the phenomenon the sidebar widget surfaces, measured directly.
const childCost = new Map()
for (const row of sessions) {
  if (!row.parent_id) continue
  childCost.set(row.parent_id, (childCost.get(row.parent_id) ?? 0) + (Number(row.cost) || 0))
}
const withChildren = decorated.filter((session) => childCost.has(session.id))
const rootCost = sum(withChildren.map((session) => session.cost))
const childrenCost = sum(withChildren.map((session) => childCost.get(session.id) ?? 0))

const cumulative = stats()
const today = usage()

// --- cohorts ------------------------------------------------------------------

function cohort(rows) {
  const costs = rows.map((row) => row.cost).filter((value) => value > 0)
  const tokens = rows.map((row) => row.tokens).filter((value) => value > 0)
  const tools = rows.map((row) => row.tools).filter((value) => value > 0)
  return {
    n: rows.length,
    costMedian: median(costs),
    costTotal: sum(costs),
    tokensMedian: median(tokens),
    toolsMedian: median(tools),
    minutesMedian: median(rows.map((row) => row.minutes)),
  }
}

const prunedRows = decorated.filter((row) => row.pruned)
const unprunedRows = decorated.filter((row) => !row.pruned)

const earliestPrune = events.length ? Math.min(...events.map((event) => Date.parse(event.at) || Infinity)) : null
const before = earliestPrune ? decorated.filter((row) => row.created < earliestPrune) : []
const after = earliestPrune ? decorated.filter((row) => row.created >= earliestPrune) : []

const aggregate = {
  window: {
    sessions: decorated.length,
    from: decorated.length ? new Date(Math.min(...decorated.map((row) => row.created))).toISOString().slice(0, 10) : null,
    to: decorated.length ? new Date(Math.max(...decorated.map((row) => row.created))).toISOString().slice(0, 10) : null,
  },
  plugin: {
    // 0.2.0 introduced these counters. An older install prunes but records none of
    // them, and a naive read of that would look like a perfect re-run rate.
    metricsAvailable: (cumulative.transformCalls ?? 0) > 0,
    runs: cumulative.runs ?? 0,
    tokensSaved: cumulative.tokensSaved ?? 0,
    dropped: cumulative.dropped ?? 0,
    truncated: cumulative.truncated ?? 0,
    rerunAfterDrop: cumulative.rerunAfterDrop ?? 0,
    rerunAfterTruncate: cumulative.rerunAfterTruncate ?? 0,
    transformCalls: cumulative.transformCalls ?? 0,
    engaged: cumulative.engaged ?? 0,
    belowThreshold: cumulative.belowThreshold ?? 0,
    capReached: cumulative.capReached ?? 0,
    overflow: cumulative.overflow ?? 0,
    noBackend: cumulative.noBackend ?? 0,
    requestsToday: today.requests ?? 0,
  },
  reasons: Object.fromEntries(
    Object.entries(cumulative)
      .filter(([key]) => key.startsWith("reason_"))
      .map(([key, value]) => [key.replace("reason_", ""), Number(value) || 0]),
  ),
  cohorts: { pruned: cohort(prunedRows), unpruned: cohort(unprunedRows) },
  beforeAfter: { before: cohort(before), after: cohort(after) },
  subagents: { rootsWithChildren: withChildren.length, rootCost, childrenCost },
}

if (AS_JSON) {
  console.log(JSON.stringify(aggregate, null, 2))
  process.exit(0)
}

// --- report -------------------------------------------------------------------

const lines = []
const push = (line = "") => lines.push(line)

push(`# laya-compaction report`)
push()
push(`Window: ${aggregate.window.from} to ${aggregate.window.to} · ${aggregate.window.sessions} root sessions${EXCLUDE.size ? ` · ${EXCLUDE.size} excluded` : ""}`)
push()

push(`## Is it doing anything?`)
push()
push(`| | |`)
push(`| --- | --- |`)
push(`| prunes that changed context | ${num(aggregate.plugin.runs)} |`)
push(`| transforms seen | ${num(aggregate.plugin.transformCalls)} |`)
push(`| dormant (below threshold) | ${num(aggregate.plugin.belowThreshold)} |`)
push(`| engaged | ${num(aggregate.plugin.engaged)} |`)
push(`| state overflow (skipped) | ${num(aggregate.plugin.overflow)} |`)
push(`| daily cap hit | ${num(aggregate.plugin.capReached)} |`)
push(`| backend unreachable | ${num(aggregate.plugin.noBackend)} |`)
push(`| requests today | ${aggregate.plugin.requestsToday} |`)
push()
if (!aggregate.plugin.metricsAvailable) {
  push(`**Counters unavailable.** The installed version predates the telemetry, so engagement and re-run numbers are not being recorded at all. Everything below them is blank for that reason, not because nothing happened. Install 0.2.0 or later to start measuring.`)
  push()
} else {
  push(`Engagement rate: **${pct(aggregate.plugin.engaged, aggregate.plugin.transformCalls)}** of transforms did something.`)
  if (aggregate.plugin.engaged === 0) push(`Nothing has been pruned yet — the plugin is dormant on this workload.`)
  push()
}

push(`## Are the decisions good?`)
push()
push(`| | |`)
push(`| --- | --- |`)
push(`| tokens saved (estimated) | ${num(aggregate.plugin.tokensSaved)} |`)
push(`| calls dropped | ${num(aggregate.plugin.dropped)} |`)
push(`| results truncated | ${num(aggregate.plugin.truncated)} |`)
push(`| **re-run after drop** | **${num(aggregate.plugin.rerunAfterDrop)}** |`)
push(`| **re-run after truncate** | **${num(aggregate.plugin.rerunAfterTruncate)}** |`)
push()
push(`Re-run rate: **${pct(aggregate.plugin.rerunAfterDrop, aggregate.plugin.dropped)}** of drops and **${pct(aggregate.plugin.rerunAfterTruncate, aggregate.plugin.truncated)}** of truncations were undone by the model.`)
push()
if (!aggregate.plugin.metricsAvailable) {
  push(`No verdict available: this install does not record re-runs, so a 0 here means "not measured", not "none happened".`)
  push()
} else if (aggregate.plugin.dropped > 0) {
  const rate = aggregate.plugin.rerunAfterDrop / aggregate.plugin.dropped
  push(rate > 0.25
    ? `A quarter or more of drops are being re-run. That is expensive: raise JEV_KEEP_THRESHOLD, or stop truncating results.`
    : rate > 0.1
      ? `Some drops come back. Worth watching, not yet alarming.`
      : `Few drops come back. The judgement is holding up so far.`)
  push()
}

if (Object.keys(aggregate.reasons).length > 0) {
  push(`## Why decisions were made`)
  push()
  for (const [reason, count] of Object.entries(aggregate.reasons).sort((a, b) => b[1] - a[1])) {
    push(`- \`${reason}\`: ${num(count)}`)
  }
  push()
  push(`\`superseded\` and \`error-resolved\` are computed exactly; \`referenced\` and \`small-result\` are exact too. Only \`model-*\` involved the model, and a model answer can only ever cause a truncation.`)
  push()
}

push(`## Pruned vs unpruned sessions`)
push()
push(`Cohorts, not causation: a session is only pruned once it is large, so the pruned cohort is longer by construction. Read the medians, not the totals.`)
push()
push(`| | pruned | unpruned |`)
push(`| --- | --- | --- |`)
push(`| sessions | ${prunedRows.length} | ${unprunedRows.length} |`)
push(`| median cost | ${money(aggregate.cohorts.pruned.costMedian)} | ${money(aggregate.cohorts.unpruned.costMedian)} |`)
push(`| total cost | ${money(aggregate.cohorts.pruned.costTotal)} | ${money(aggregate.cohorts.unpruned.costTotal)} |`)
push(`| median tokens | ${num(aggregate.cohorts.pruned.tokensMedian)} | ${num(aggregate.cohorts.unpruned.tokensMedian)} |`)
push(`| median tool calls | ${num(aggregate.cohorts.pruned.toolsMedian)} | ${num(aggregate.cohorts.unpruned.toolsMedian)} |`)
push(`| median minutes | ${num(aggregate.cohorts.pruned.minutesMedian)} | ${num(aggregate.cohorts.unpruned.minutesMedian)} |`)
push()

push(`## Before vs after the plugin was installed`)
push()
if (!earliestPrune) {
  push(`No prunes recorded yet, so there is no boundary to split on.`)
} else {
  push(`Split at the first recorded prune: **${new Date(earliestPrune).toISOString().slice(0, 16).replace("T", " ")}**`)
  push()
  push(`| | before | after |`)
  push(`| --- | --- | --- |`)
  push(`| sessions | ${before.length} | ${after.length} |`)
  push(`| median cost | ${money(aggregate.beforeAfter.before.costMedian)} | ${money(aggregate.beforeAfter.after.costMedian)} |`)
  push(`| median tokens | ${num(aggregate.beforeAfter.before.tokensMedian)} | ${num(aggregate.beforeAfter.after.tokensMedian)} |`)
  push(`| median tool calls | ${num(aggregate.beforeAfter.before.toolsMedian)} | ${num(aggregate.beforeAfter.after.toolsMedian)} |`)
  push()
  if (after.length < 10) push(`Only ${after.length} sessions after the boundary — too few to read anything into yet.`)
  push(`This is confounded: the workload changed, the models changed, and all plugins landed together. Treat it as a sanity check, not a result.`)
}
push()

push(`## The subagent blind spot`)
push()
if (withChildren.length === 0) {
  push(`No sessions with child sessions in this window.`)
} else {
  push(`${withChildren.length} sessions spawned subagents. Those children cost **${money(childrenCost)}** against **${money(rootCost)}** for their parents — **${pct(childrenCost, rootCost + childrenCost)}** of the total was invisible in the built-in sidebar before this work.`)
}
push()
push(`## Attribution`)
push()
push(`Three things were installed together, so no change here can be credited to one of them. For per-element attribution you would have to disable one at a time for a period — e.g. run a week with JEV_COMPACTION=0 and compare the same tables.`)

console.log(lines.join("\n"))
