// jev-compaction v0.3 — opencode server plugin, deterministic-first.
//
// HISTORY, because it explains the shape of this file:
// v0.1 asked Jev a judgement per tool call ("should this stay? knowing it was made
// still matters"). That produced mushy, drop-happy scores and once deleted a short file
// of hard constraints. Two independent findings agreed on why: with a `noul` primitive
// (calibrated P(true)), factual questions are reliable and judgement questions are not
// — measured elsewhere at 0.996 on an explicit fact versus 0.003-0.28 on judgements.
//
// So v0.3 asks only facts, and computes what it can exactly:
//
//   superseded       a later call reads/writes the same target  -> computed here
//   errorResolved    this call errored, a later call succeeded  -> computed here
//   referenced       a later message or tool input mentions the target string
//                                                              -> computed here
//   contentReferenced a later message quotes a value from the result body
//                                                              -> the one question left
//                                                                 for the model
//
// Deletion requires DETERMINISTIC evidence (superseded or error-resolved). The model can
// only ever justify a truncation, which keeps a head plus a "re-run if needed" note and
// is therefore recoverable. Nothing is ever dropped on a probabilistic answer.
//
// Payload: the old design resent a 25k-token state on every request, which cost about
// $1/day against a hosted model. A fact question needs only the target, a bounded
// excerpt of the result, and the messages that came after — a few KB.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { basename, join } from "node:path"

const ENDPOINT = process.env.LAYA_BASE_URL ?? process.env.JEV_BASE_URL ?? "http://127.0.0.1:8000/v1/systemone"
const MODEL = process.env.LAYA_MODEL ?? process.env.JEV_MODEL ?? "laya"
const API_KEY = process.env.LAYA_API_KEY ?? process.env.TYPESAFE_API_KEY ?? ""

function num(value: string | undefined, fallback: number, min = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

const ENABLED = process.env.LAYA_COMPACTION !== "0" && process.env.JEV_COMPACTION !== "0"
const THRESHOLD_TOKENS = num(process.env.LAYA_COMPACTION_THRESHOLD, 60_000, 1)
const PRESERVE_RECENT = Math.max(1, Math.floor(num(process.env.LAYA_PRESERVE_RECENT, 6, 1)))
const SMALL_RESULT_CHARS = Math.floor(num(process.env.LAYA_SMALL_RESULT_CHARS, 600))
const TRUNCATE_HEAD = Math.floor(num(process.env.LAYA_TRUNCATE_HEAD, 300))
const EXCERPT_CHARS = Math.floor(num(process.env.LAYA_EXCERPT_CHARS, 400))
/** Laya's sequence budget is 512 tokens; the model sees only this much of what came after. */
const AFTER_CHARS = Math.floor(num(process.env.LAYA_AFTER_CHARS, 1000))
const REFERENCED_HIGH = num(process.env.LAYA_REFERENCED_HIGH, 0.7)
const REFERENCED_LOW = num(process.env.LAYA_REFERENCED_LOW, 0.3)
const TIMEOUT_MS = num(process.env.LAYA_TIMEOUT_MS, 8_000, 1)
const DAILY_REQUEST_CAP = Math.floor(num(process.env.LAYA_DAILY_REQUEST_CAP, 400))
const MAX_QUESTIONS = Math.floor(num(process.env.LAYA_MAX_QUESTIONS, 40))
const CONCURRENCY = Math.floor(num(process.env.LAYA_CONCURRENCY, 4, 1))

const STATE_DIR = join(homedir(), ".local", "share", "opencode")
const STATS_FILE = join(STATE_DIR, "laya-compaction.json")
const LEDGER_FILE = join(STATE_DIR, "laya-compaction-ledger.jsonl")
const CAP_FILE = join(STATE_DIR, "laya-compaction-usage.json")
const DEBUG_FILE = join(STATE_DIR, "laya-compaction.log")

const DECISION_FACT =
  "Coding agent context pruning. `target` is what a tool call touched, `result_head` is the " +
  "beginning of its output, and `after` is everything that came later in the conversation. " +
  "Questions are answerable by inspection of `after`; answer only from what is present there."

const TOKEN_PIECES = /[A-Za-z]+|\d+|[^\sA-Za-z\d]/g
function estimateTokens(text: string): number {
  let tokens = 0
  for (const [piece] of text.matchAll(TOKEN_PIECES)) {
    const first = piece.charCodeAt(0)
    if (first >= 48 && first <= 57) tokens += piece.length / 2
    else if ((first >= 65 && first <= 90) || (first >= 97 && first <= 122)) tokens += 1 + Math.floor((piece.length - 1) / 6)
    else tokens += 0.9
  }
  return Math.ceil(tokens)
}

function trace(line: string, extra?: unknown) {
  if (process.env.LAYA_DEBUG !== "1" && process.env.JEV_DEBUG !== "1") return
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(DEBUG_FILE, `${new Date().toISOString()} ${line}${extra === undefined ? "" : " " + JSON.stringify(extra)}\n`, { mode: 0o600 })
  } catch {}
}

// --- spend ceiling -------------------------------------------------------------

const counters = { transformCalls: 0, engaged: 0, belowThreshold: 0, capReached: 0, noBackend: 0 }
let lastFlush = 0
let counted: { day: string; requests: number } | undefined

const today = () => new Date().toISOString().slice(0, 10)

function readUsage() {
  try {
    const raw = JSON.parse(readFileSync(CAP_FILE, "utf8"))
    if (raw && raw.day === today()) return { day: raw.day, requests: Number(raw.requests) || 0 }
  } catch {}
  return { day: today(), requests: 0 }
}

function dayUsage() {
  if (!counted || counted.day !== today()) counted = readUsage()
  return counted
}

function writeUsage(current: { day: string; requests: number }) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(CAP_FILE, JSON.stringify(current, null, 2), { mode: 0o600 })
  } catch {}
}

function updateStats(mutate: (stats: any) => void) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    let stats: any = {}
    try {
      stats = JSON.parse(readFileSync(STATS_FILE, "utf8"))
    } catch {}
    mutate(stats)
    stats.updated = new Date().toISOString()
    writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2), { mode: 0o600 })
  } catch {}
}

function flushCounters(force = false) {
  const now = Date.now()
  if (!force && now - lastFlush < 60_000) return
  if (counters.transformCalls === 0 && counters.engaged === 0) return
  lastFlush = now
  const snapshot = { ...counters }
  for (const key of Object.keys(counters) as Array<keyof typeof counters>) counters[key] = 0
  updateStats((stats) => {
    for (const [key, value] of Object.entries(snapshot)) stats[key] = (Number(stats[key]) || 0) + value
  })
}

function appendLedger(entry: Record<string, unknown>) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(LEDGER_FILE, JSON.stringify(entry) + "\n", { mode: 0o600 })
  } catch {}
}

// --- backend -------------------------------------------------------------------

/**
 * One residual question: does anything after this call depend on its output?
 *
 * Deliberately a `choice` rather than a `noul`. Measured against this same local model:
 * a `noul` statement and its own negation both scored ~0.95, so it agreed with the shape
 * of the question rather than reading it. As a two-option choice with explicit criteria
 * the same cases separate cleanly (quotes 0.75-0.99 on a real quote, does-not 0.80-0.91
 * on unrelated text). Do not "simplify" this back to a boolean statement.
 */
async function askChoice(
  state: object,
  name: string,
  instructions: string,
  criteria: Record<string, string>,
): Promise<{ choice?: string; probabilities?: Record<string, number> }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { "content-type": "application/json" }
    if (API_KEY) headers.authorization = `Bearer ${API_KEY}`
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: MODEL, state, questions: { [name]: { type: "choice", instructions, criteria } } }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`backend ${response.status}`)
    const parsed = JSON.parse(await response.text())
    const answer = parsed?.answers?.[name]
    if (!answer || typeof answer !== "object") throw new Error("no answer in response")
    return { choice: answer.choice, probabilities: answer.probabilities }
  } finally {
    clearTimeout(timer)
  }
}

// --- opencode parts ------------------------------------------------------------

type Part = { id?: string; type?: string; tool?: string; callID?: string; state?: any; text?: string; [key: string]: any }
type Message = { info?: any; parts?: Part[]; [key: string]: any }

type Candidate = {
  callID: string
  tool: string
  input: Record<string, unknown>
  output: string
  isError: boolean
  messageIndex: number
  part: Part
  targets: string[]
  key: string
}

const TARGET_KEYS = /^(file_?path|filepath|path|file|filename|dir|directory|command|cmd|pattern|url|uri|query|name|target)$/i

function isFinished(part: Part): boolean {
  if (part?.type !== "tool") return false
  return part.state?.status === "completed" || part.state?.status === "error"
}

function outputOf(part: Part): { text: string; isError: boolean } {
  if (part.state?.status === "completed") return { text: String(part.state.output ?? ""), isError: false }
  return { text: String(part.state?.error ?? ""), isError: true }
}

function textOf(message: Message): string {
  return (message.parts ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim()
}

/** Strings that identify what a call touched, for later-mention checks. */
function targetsOf(input: Record<string, unknown>): string[] {
  const found = new Set<string>()
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value !== "string") continue
    if (!TARGET_KEYS.test(key)) continue
    const raw = value.trim()
    if (raw.length < 3) continue
    found.add(raw)
    if (raw.includes("/")) {
      const base = basename(raw)
      if (base.length >= 3) found.add(base)
    }
  }
  return [...found].slice(0, 4)
}

/** Comparable identity for supersession: same tool, same target. */
function identityOf(tool: string, targets: string[]): string {
  const normalized = targets.map((t) => t.toLowerCase().replace(/\s+/g, " ").trim()).sort().join("|")
  return `${tool}::${normalized}`
}

function isPinned(index: number, total: number): boolean {
  return index === 0 || index >= total - PRESERVE_RECENT
}

function candidatesOf(messages: Message[]): Candidate[] {
  const list: Candidate[] = []
  messages.forEach((message, messageIndex) => {
    for (const part of message.parts ?? []) {
      if (!isFinished(part)) continue
      const { text, isError } = outputOf(part)
      const input = (part.state?.input as Record<string, unknown>) ?? {}
      const targets = targetsOf(input)
      list.push({
        callID: String(part.callID ?? part.id ?? `p${list.length + 1}`),
        tool: String(part.tool ?? "tool"),
        input,
        output: text,
        isError,
        messageIndex,
        part,
        targets,
        key: identityOf(String(part.tool ?? "tool"), targets.length ? targets : [JSON.stringify(input)]),
      })
    }
  })
  return list
}

/**
 * Everything after a position. `prose` is message text only: that is what the deterministic
 * mention check uses, because a later call to the same target is supersession, not a
 * reference, and counting its input as a mention would mask exactly that. `full` adds the
 * later tool calls and is what the model sees.
 */
function contextAfter(messages: Message[], index: number): { prose: string; full: string } {
  const prose: string[] = []
  const toolLines: string[] = []
  for (let i = index + 1; i < messages.length && prose.length + toolLines.length < 40; i++) {
    const text = textOf(messages[i]!)
    if (text) prose.push(text.slice(0, 600))
    for (const part of messages[i]?.parts ?? []) {
      if (part?.type !== "tool") continue
      toolLines.push(`called ${part.tool} with ${JSON.stringify(part.state?.input ?? {}).slice(0, 200)}`)
    }
  }
  return { prose: prose.join("\n"), full: [...prose, ...toolLines].join("\n") }
}

// --- policy --------------------------------------------------------------------

type Action = "keep" | "truncate" | "drop"
type Reason =
  | "referenced"
  | "superseded"
  | "error-resolved"
  | "small-result"
  | "model-referenced"
  | "model-unreferenced"
  | "inconclusive"

function truncatedOutput(text: string, isError: boolean): string {
  if (text.length <= TRUNCATE_HEAD + 120) return text
  const head = TRUNCATE_HEAD > 0 ? `${text.slice(0, TRUNCATE_HEAD)}\n` : ""
  return `${head}[laya-compaction truncated ${text.length - TRUNCATE_HEAD} chars of this tool result${isError ? " (error)" : ""}; re-run the tool if needed]`
}

function decide(candidate: Candidate, later: Candidate[], prose: string): { action: Action; reason: Reason } {
  // 1. Something later names the target. Kept, no model needed.
  const mentioned = candidate.targets.some((target) => prose.toLowerCase().includes(target.toLowerCase()))
  if (mentioned) return { action: "keep", reason: "referenced" }

  // 2. A later call with the same identity: this one is stale, and the answer is deterministic.
  const sameKey = later.filter((other) => other.key === candidate.key)
  if (sameKey.length > 0) {
    return candidate.isError && sameKey.some((other) => !other.isError)
      ? { action: "drop", reason: "error-resolved" }
      : { action: "drop", reason: "superseded" }
  }

  // 3. Short results are not worth touching, and this is the class v0.1 wrongly deleted.
  if (candidate.output.length <= SMALL_RESULT_CHARS) return { action: "keep", reason: "small-result" }

  // 4. Nothing deterministic either way. The model may only justify a truncation.
  return { action: "truncate", reason: "inconclusive" }
}

// --- telemetry -----------------------------------------------------------------

const sessions = new Map<string, { dropped: Map<string, string>; truncated: Map<string, string> }>()

function memoryFor(sessionID: string) {
  let entry = sessions.get(sessionID)
  if (!entry) {
    if (sessions.size > 200) sessions.clear()
    entry = { dropped: new Map(), truncated: new Map() }
    sessions.set(sessionID, entry)
  }
  return entry
}

function signatureOf(candidate: Candidate): string {
  let input = ""
  try {
    input = JSON.stringify(candidate.input)
  } catch {
    input = "[unserializable]"
  }
  return `${candidate.tool}\u0000${input}`
}

// --- the pruner ----------------------------------------------------------------

async function prune(messages: Message[], reason: string): Promise<void> {
  if (!ENABLED) return
  try {
    counters.transformCalls += 1
    if (!Array.isArray(messages) || messages.length === 0) return

    const all = candidatesOf(messages)
    if (all.length === 0) {
      flushCounters()
      return
    }

    const estimated = estimateTokens(JSON.stringify(messages))
    if (estimated < THRESHOLD_TOKENS) {
      counters.belowThreshold += 1
      flushCounters()
      return
    }

    const started = Date.now()
    const sessionID = String(messages[0]?.info?.sessionID ?? "unknown")
    const memory = memoryFor(sessionID)
    const tokensBefore = messages.reduce((total, message) => total + estimateTokens(JSON.stringify(message)), 0)

    const candidates = all.filter((candidate) => !isPinned(candidate.messageIndex, messages.length))
    const before = candidates.map((candidate) => {
      const later = all.filter((other) => other.messageIndex > candidate.messageIndex)
      const context = contextAfter(messages, candidate.messageIndex)
      return { candidate, later, prose: context.prose, full: context.full }
    })

    // Count a call re-issued under a new id after we removed or shortened the original.
    let rerunAfterDrop = 0
    let rerunAfterTruncate = 0
    for (const candidate of all) {
      const sig = signatureOf(candidate)
      const dropped = memory.dropped.get(sig)
      if (dropped && dropped !== candidate.callID) {
        rerunAfterDrop += 1
        memory.dropped.delete(sig)
      }
      const truncated = memory.truncated.get(sig)
      if (truncated && truncated !== candidate.callID) {
        rerunAfterTruncate += 1
        memory.truncated.delete(sig)
      }
    }

    const decisions = before.map(({ candidate, later, prose, full }) => ({
      candidate,
      full,
      ...decide(candidate, later, prose),
    }))

    // Only the inconclusive, large-result cases go to the model, one small request each.
    const uncertain = decisions.filter((entry) => entry.reason === "inconclusive").slice(0, MAX_QUESTIONS)
    let asked = 0
    let backendReachable = true

    if (uncertain.length > 0) {
      const allowed = Math.max(0, DAILY_REQUEST_CAP - dayUsage().requests)
      const batch = uncertain.slice(0, allowed)
      if (batch.length > 0) {
        dayUsage().requests += batch.length
        writeUsage(dayUsage())
        const queue = [...batch]
        const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
          while (queue.length > 0) {
            const entry = queue.shift()
            if (!entry) break
            const name = `content_${entry.candidate.callID}`
            try {
              const answer = await askChoice(
                {
                  context: DECISION_FACT,
                  target: entry.candidate.targets[0] ?? "",
                  result_head: entry.candidate.output.slice(0, EXCERPT_CHARS),
                  after: entry.full.slice(0, AFTER_CHARS),
                },
                name,
                "Do the later messages quote or use any value that came from the earlier tool output?",
                {
                  quotes: "a later message states a value that came from the earlier output",
                  "does-not": "no later message uses any value from the earlier output",
                },
              )
              asked += 1
              const quoted = Number(answer.probabilities?.quotes ?? 0)
              entry.reason = quoted >= REFERENCED_HIGH ? "model-referenced" : "model-unreferenced"
              entry.action = quoted >= REFERENCED_HIGH ? "keep" : "truncate"
              entry.model = { choice: answer.choice, quotes: quoted }
            } catch (error) {
              backendReachable = false
              trace("fact question failed", { id: entry.candidate.callID, error: String((error as Error)?.message ?? error) })
            }
          }
        })
        await Promise.all(workers)
      } else {
        counters.capReached += 1
      }
    }

    if (!backendReachable && asked === 0 && uncertain.length > 0) counters.noBackend += 1

    // Apply. Deletion only ever came from a deterministic reason; the model cannot cause one.
    const drop = new Set<Part>()
    const reasonCounts: Record<string, number> = {}
    let dropped = 0
    let truncated = 0

    for (const entry of decisions) {
      const { candidate, action, reason: why } = entry
      reasonCounts[why] = (reasonCounts[why] ?? 0) + 1
      if (action === "keep") continue
      if (action === "drop") {
        drop.add(candidate.part)
        memory.dropped.set(signatureOf(candidate), candidate.callID)
        dropped += 1
        continue
      }
      const next = truncatedOutput(candidate.output, candidate.isError)
      if (next === candidate.output) continue
      if (candidate.part.state?.status === "completed") candidate.part.state.output = next
      else if (candidate.part.state?.status === "error") candidate.part.state.error = next
      memory.truncated.set(signatureOf(candidate), candidate.callID)
      truncated += 1
    }

    if (drop.size > 0) {
      for (const message of messages) {
        if (!message.parts || !message.parts.some((part) => drop.has(part))) continue
        message.parts = message.parts.filter((part) => !drop.has(part))
      }
    }

    const kept = messages.filter((message) => (message.parts ?? []).length > 0)
    messages.length = 0
    messages.push(...kept)

    const tokensAfter = messages.reduce((total, message) => total + estimateTokens(JSON.stringify(message)), 0)
    const tokensSaved = Math.max(0, tokensBefore - tokensAfter)
    const ms = Date.now() - started

    counters.engaged += 1
    updateStats((stats) => {
      stats.runs = (Number(stats.runs) || 0) + 1
      stats.tokensSaved = (Number(stats.tokensSaved) || 0) + tokensSaved
      stats.callsSeen = (Number(stats.callsSeen) || 0) + all.length
      stats.dropped = (Number(stats.dropped) || 0) + dropped
      stats.truncated = (Number(stats.truncated) || 0) + truncated
      stats.asked = (Number(stats.asked) || 0) + asked
      stats.rerunAfterDrop = (Number(stats.rerunAfterDrop) || 0) + rerunAfterDrop
      stats.rerunAfterTruncate = (Number(stats.rerunAfterTruncate) || 0) + rerunAfterTruncate
      for (const [key, value] of Object.entries(reasonCounts)) stats[`reason_${key}`] = (Number(stats[`reason_${key}`]) || 0) + value
      stats.last = { tokensBefore, tokensAfter, tokensSaved, calls: all.length, dropped, truncated, asked, ms, rerunAfterDrop, rerunAfterTruncate, reasons: reasonCounts }
    })
    flushCounters(counters.engaged > 0)

    if (dropped > 0 || truncated > 0 || rerunAfterDrop > 0 || rerunAfterTruncate > 0) {
      appendLedger({
        at: new Date().toISOString(),
        session: sessionID,
        reason,
        tokensBefore,
        tokensAfter,
        tokensSaved,
        calls: all.length,
        dropped,
        truncated,
        asked,
        rerunAfterDrop,
        rerunAfterTruncate,
        reasons: reasonCounts,
        ms,
      })
    }
    trace("pruned", { reason, session: sessionID, dropped, truncated, asked, tokensSaved, rerunAfterDrop, rerunAfterTruncate, reasons: reasonCounts })
  } catch (error) {
    trace("prune failed (messages untouched)", { error: String((error as Error)?.message ?? error) })
  }
}

async function server() {
  return {
    "experimental.chat.messages.transform": async (_input: unknown, output: { messages: Message[] }) => {
      await prune(output.messages, "step")
    },
    "experimental.session.compacting": async (_input: unknown, output: { context: string[]; prompt?: string }) => {
      output.context.push(
        "Tool results marked `[laya-compaction truncated …]` were shortened deliberately: the call is still " +
          "historically accurate but the body was dropped as no longer needed. Do not treat them as tool failures.",
      )
    },
  }
}

export default { id: "laya-compaction", server }
