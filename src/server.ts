// jev-compaction — an opencode server plugin.
//
// Strategy adapted from https://github.com/tamaratran/fast-jev-compaction (MIT):
// never summarize on compaction. Instead ask a fast model, per tool call, whether the
// call and whether its full output still need to be in context. Drop the ones that
// don't, truncate the ones where only the fact of the call matters, and leave every
// user and assistant message verbatim. See NOTICE for the attribution.
//
// Adapted to opencode's model: a `tool` part carries both the call (state.input) and
// its result (state.output) together, so there is no orphaned-result case to guard
// against the way the original has to.
//
// Safety: this runs before every model request. It never throws — any failure leaves
// the messages exactly as they were.
//
//   TYPESAFE_API_KEY              API key (required unless the keychain is configured)
//   JEV_KEYCHAIN_SERVICE          macOS keychain service to read the key from
//   JEV_KEYCHAIN_ACCOUNT          macOS keychain account to read the key from
//   JEV_COMPACTION=0              disable entirely
//   JEV_COMPACTION_THRESHOLD      estimated tokens before it engages (default 60000)
//   JEV_KEEP_THRESHOLD            minimum keep probability (default 0.35)
//   JEV_PRESERVE_RECENT           newest messages never touched (default 6, minimum 1)
//   JEV_MAX_STATE_TOKENS          ceiling for the state sent to Jev (default 25000)
//   JEV_MAX_REQUEST_TOKENS        ceiling for state plus questions (default 30000)
//   JEV_TRUNCATE_HEAD             chars of a dropped result retained (default 300)
//   JEV_SMALL_RESULT_CHARS        results this size or smaller are shown to Jev in full (default 600)
//   JEV_TIMEOUT_MS                per-request timeout (default 20000)
//   JEV_DAILY_REQUEST_CAP         hard ceiling on Jev requests per day (default 200)
//   JEV_MODEL                     model name (default "jev-latest")
//   JEV_BASE_URL                  endpoint (default the System One endpoint)
//   JEV_DEBUG=1                   append a trace to the debug log

import { spawnSync } from "node:child_process"
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const ENDPOINT = process.env.JEV_BASE_URL ?? "https://api.typesafe.ai/v1/systemone"
const MODEL = process.env.JEV_MODEL ?? "jev-latest"

/** Parse a numeric setting, falling back rather than letting NaN disable a guard. */
function num(value: string | undefined, fallback: number, min = 0): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= min ? parsed : fallback
}

const ENABLED = process.env.JEV_COMPACTION !== "0"
const THRESHOLD_TOKENS = num(process.env.JEV_COMPACTION_THRESHOLD, 60_000, 1)
const MAX_STATE_TOKENS = num(process.env.JEV_MAX_STATE_TOKENS, 25_000, 1)
const MAX_REQUEST_TOKENS = num(process.env.JEV_MAX_REQUEST_TOKENS, 30_000, 1)
const KEEP_THRESHOLD = num(process.env.JEV_KEEP_THRESHOLD, 0.35)
const PRESERVE_RECENT = Math.max(1, Math.floor(num(process.env.JEV_PRESERVE_RECENT, 6, 1)))
const TRUNCATE_HEAD = Math.floor(num(process.env.JEV_TRUNCATE_HEAD, 300))
const SMALL_RESULT_CHARS = Math.floor(num(process.env.JEV_SMALL_RESULT_CHARS, 600))
const TIMEOUT_MS = num(process.env.JEV_TIMEOUT_MS, 20_000, 1)
const DAILY_REQUEST_CAP = Math.floor(num(process.env.JEV_DAILY_REQUEST_CAP, 200))

const STATE_DIR = join(homedir(), ".local", "share", "opencode")
const STATS_FILE = join(STATE_DIR, "jev-compaction.json")
const CAP_FILE = join(STATE_DIR, "jev-compaction-usage.json")
const DEBUG_FILE = join(STATE_DIR, "jev-compaction.log")

const STATE_CONTEXT =
  "A coding assistant conversation is being compacted to free context. `history` is the whole " +
  "conversation so far, oldest first; tool outputs are replaced by a short `result` note and long " +
  "texts may be abridged. Each question asks whether one tool call, or the full output of that " +
  "call, still needs to stay in the history verbatim. Whatever is not kept is deleted permanently, " +
  "but the assistant can always re-run a tool or re-read a file."

// Plugin modules are loaded once per server process, so this state persists across
// the many transform calls a single session makes. Decisions are monotonic per call:
// once dropped, always dropped.
const decided = new Map<string, Action>()
let cachedKey: string | undefined
let counted: { day: string; requests: number } | undefined

function trace(line: string, extra?: unknown) {
  if (process.env.JEV_DEBUG !== "1") return
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    appendFileSync(
      DEBUG_FILE,
      `${new Date().toISOString()} ${line}${extra === undefined ? "" : " " + JSON.stringify(extra)}\n`,
      { mode: 0o600 },
    )
  } catch {}
}

// --- token estimate -----------------------------------------------------------
// A word costs ~1 token per 6 letters, a digit half a token, any other symbol 0.9.
// Lands slightly above the counts Jev reports, which is the safe direction.

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

// --- key ----------------------------------------------------------------------

function apiKey(): string {
  if (cachedKey !== undefined) return cachedKey
  const env = process.env.TYPESAFE_API_KEY
  if (env && env.trim()) {
    cachedKey = env.trim()
    return cachedKey
  }
  const service = process.env.JEV_KEYCHAIN_SERVICE
  const account = process.env.JEV_KEYCHAIN_ACCOUNT
  if (service && account) {
    // Array args, no shell: env-derived values cannot be interpolated into a command.
    // Timeout so a locked keychain cannot block the pre-request path indefinitely.
    const result = spawnSync(
      "security",
      ["find-generic-password", "-s", service, "-a", account, "-w"],
      { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] },
    )
    cachedKey = result.status === 0 ? (result.stdout ?? "").trim() : ""
    trace("key resolved", { source: "keychain", found: cachedKey.length > 0 })
    return cachedKey
  }
  cachedKey = ""
  return cachedKey
}

// --- spend ceiling -------------------------------------------------------------

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function readUsage(): { day: string; requests: number } {
  try {
    const raw = JSON.parse(readFileSync(CAP_FILE, "utf8"))
    if (raw && raw.day === today()) return { day: raw.day, requests: Number(raw.requests) || 0 }
  } catch {}
  return { day: today(), requests: 0 }
}

/** Process-local counter so concurrent batches cannot lose increments. */
function dayUsage(): { day: string; requests: number } {
  if (!counted || counted.day !== today()) counted = readUsage()
  return counted
}

function writeUsage(current: { day: string; requests: number }) {
  try {
    mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 })
    writeFileSync(CAP_FILE, JSON.stringify(current, null, 2), { mode: 0o600 })
  } catch {}
}

// --- asking -------------------------------------------------------------------

type Question = { type: "noul"; instructions: string }
type Answers = Record<string, { noul?: unknown }>

async function ask(state: object, questions: Record<string, Question>): Promise<Answers> {
  const key = apiKey()
  if (!key) throw new Error("no Jev key configured (TYPESAFE_API_KEY or JEV_KEYCHAIN_SERVICE/JEV_KEYCHAIN_ACCOUNT)")

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, state, questions }),
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`jev request failed (${response.status})`)
    const parsed = JSON.parse(await response.text())
    if (!parsed || typeof parsed !== "object" || !("answers" in parsed) || !parsed.answers) {
      throw new Error("jev response missing answers")
    }
    trace("jev usage", {
      input: parsed.usage?.input_tokens,
      output: parsed.usage?.output_tokens,
      answers: Object.keys(parsed.answers ?? {}).length,
    })
    return parsed.answers as Answers
  } finally {
    clearTimeout(timer)
  }
}

function noul(answers: Answers, name: string): number {
  const value = answers?.[name]?.noul
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`invalid jev answer for ${name}`)
  return value
}

// --- opencode part handling ---------------------------------------------------

type Part = { id?: string; type?: string; tool?: string; callID?: string; state?: any; text?: string; [key: string]: any }
type Message = { info?: any; parts?: Part[]; [key: string]: any }
type Call = {
  id: string
  callID: string
  tool: string
  input: Record<string, unknown>
  output: string
  isError: boolean
  messageIndex: number
  /** The part itself, held by reference: dropping one part must not shift the others. */
  part: Part
  pinned: boolean
}

function isFinishedToolPart(part: Part): boolean {
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

function isPinned(index: number, total: number): boolean {
  return index === 0 || index >= total - PRESERVE_RECENT
}

function collectCalls(messages: Message[]): Call[] {
  const calls: Call[] = []
  messages.forEach((message, messageIndex) => {
    for (const part of message.parts ?? []) {
      if (!isFinishedToolPart(part)) continue
      const { text, isError } = outputOf(part)
      calls.push({
        id: `t${calls.length + 1}`,
        callID: String(part.callID ?? part.id ?? `p${calls.length + 1}`),
        tool: String(part.tool ?? "tool"),
        input: (part.state?.input as Record<string, unknown>) ?? {},
        output: text,
        isError,
        messageIndex,
        part,
        pinned: isPinned(messageIndex, messages.length),
      })
    }
  })
  return calls
}

// --- state fitting ------------------------------------------------------------

const INPUT_CHARS = [1000, 200, 60] as const
const TEXT_HEAD = 400
const TEXT_TAIL = 150

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 1))}…`
}

function abridge(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 40) return text
  return `${text.slice(0, head)}\n[… ${text.length - head - tail} chars omitted …]\n${text.slice(-tail)}`
}

function inputText(input: Record<string, unknown>, limit: number): string {
  try {
    return truncate(JSON.stringify(input), limit)
  } catch {
    return "[unserializable input]"
  }
}

function resultNote(call: Call): string {
  // Small results are sent in full. Replacing every result with a note hides the
  // evidence Jev needs: it cannot tell a throwaway file listing from a short file
  // of hard constraints, so it reasonably guesses "cheap to re-read" and drops
  // both. Showing what a small result actually says is what lets it tell them apart.
  if (call.output.length <= SMALL_RESULT_CHARS) return call.output
  return `${call.isError ? "error" : "ok"}, ${call.output.length} chars (omitted)`
}

function compactCall(call: Call): string {
  const input = Object.entries(call.input)
    .map(([key, value]) => {
      const text = typeof value === "string" ? value : inputText({ [key]: value }, 200)
      return `${key}=${text.replace(/\s+/g, " ")}`
    })
    .join(" ")
  return `${call.id} ${call.tool} ${truncate(input, INPUT_CHARS[2])} → ${call.isError ? "error" : "ok"} ${call.output.length}ch`
}

type Entry = { i: number; role: string; text: string; tool_calls?: Array<Record<string, string>> | string[] }

function buildHistory(messages: Message[], calls: Call[], inputChars: number): Entry[] {
  const byMessage = new Map<number, Call[]>()
  for (const call of calls) {
    const list = byMessage.get(call.messageIndex) ?? []
    list.push(call)
    byMessage.set(call.messageIndex, list)
  }
  const entries: Entry[] = []
  messages.forEach((message, index) => {
    const toolCalls = (byMessage.get(index) ?? []).map((call) => ({
      id: call.id,
      tool: call.tool,
      input: inputText(call.input, inputChars),
      result: resultNote(call),
    }))
    const text = textOf(message)
    if (text.length === 0 && toolCalls.length === 0) return
    const entry: Entry = { i: index, role: String(message.info?.role ?? "user"), text }
    if (toolCalls.length > 0) entry.tool_calls = toolCalls
    entries.push(entry)
  })
  return entries
}

function goalFrom(messages: Message[]): string {
  return messages
    .filter((message) => message.info?.role === "user" && textOf(message).length > 0)
    .slice(-3)
    .map((message) => truncate(textOf(message), 500))
    .join("\n")
}

function fitState(messages: Message[], calls: Call[]): { state: object; tokens: number; stage: string } {
  const goal = goalFrom(messages)
  const stateOf = (history: Entry[]) => ({ context: STATE_CONTEXT, goal, history })
  const tokensOf = (history: Entry[]) =>
    estimateTokens(JSON.stringify(stateOf([]))) +
    history.reduce((sum, entry) => sum + estimateTokens(JSON.stringify(entry)) + 1, 0)

  for (const limit of INPUT_CHARS) {
    const history = buildHistory(messages, calls, limit)
    const tokens = tokensOf(history)
    if (tokens <= MAX_STATE_TOKENS) return { state: stateOf(history), tokens, stage: `inputs<=${limit}` }
  }

  const history = buildHistory(messages, calls, INPUT_CHARS[2])
  let tokens = tokensOf(history)
  const pinnedAt = (entry: Entry) => isPinned(entry.i, messages.length)
  const order = [
    ...history.map((_, i) => i).filter((i) => !pinnedAt(history[i]!)),
    ...history.map((_, i) => i).filter((i) => pinnedAt(history[i]!)),
  ]

  for (const index of order) {
    const entry = history[index]
    if (!entry || entry.text.length <= TEXT_HEAD + TEXT_TAIL + 40) continue
    entry.text = abridge(entry.text, TEXT_HEAD, TEXT_TAIL)
    tokens = tokensOf(history)
    if (tokens <= MAX_STATE_TOKENS) return { state: stateOf(history), tokens, stage: "texts abridged" }
  }

  for (const index of order) {
    const entry = history[index]
    if (!entry || pinnedAt(entry) || entry.text.length === 0) continue
    const original = textOf(messages[entry.i] ?? {}).length || entry.text.length
    entry.text = `[… ${original} chars omitted …]`
    tokens = tokensOf(history)
    if (tokens <= MAX_STATE_TOKENS) return { state: stateOf(history), tokens, stage: "old messages collapsed" }
  }

  const byMessage = new Map<number, Call[]>()
  for (const call of calls) {
    const list = byMessage.get(call.messageIndex) ?? []
    list.push(call)
    byMessage.set(call.messageIndex, list)
  }
  for (const index of order) {
    const entry = history[index]
    const own = entry ? byMessage.get(entry.i) : undefined
    if (!entry || pinnedAt(entry) || !own) continue
    entry.tool_calls = own.map(compactCall)
    tokens = tokensOf(history)
    if (tokens <= MAX_STATE_TOKENS) return { state: stateOf(history), tokens, stage: "old calls compacted" }
  }

  return { state: stateOf(history), tokens, stage: "overflow" }
}

// --- decisions -----------------------------------------------------------------

type Action = "keep" | "drop_result" | "drop_call"

function questionsFor(call: Call): Record<string, Question> {
  return {
    [`call_${call.id}`]: {
      type: "noul",
      instructions: `Tool call ${call.id} (${call.tool}) should stay in the history: knowing this call was made, with its input, still matters for what the assistant does next`,
    },
    [`result_${call.id}`]: {
      type: "noul",
      instructions: `The full output of tool call ${call.id} (${call.tool}, ${call.output.length} chars) should stay in the history verbatim: the assistant still needs its contents and re-running the tool would not do`,
    },
  }
}

const REQUEST_OVERHEAD_TOKENS = 20

function batch(calls: Call[], stateTokens: number): Call[][] {
  const budget = MAX_REQUEST_TOKENS - stateTokens - REQUEST_OVERHEAD_TOKENS
  const batches: Call[][] = []
  let current: Call[] = []
  let currentTokens = 0
  for (const call of calls) {
    const tokens = estimateTokens(JSON.stringify(questionsFor(call)))
    if (current.length > 0 && currentTokens + tokens > budget) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    if (current.length === 0 && tokens > budget) throw new Error(`state leaves no room for questions (~${stateTokens} tokens)`)
    current.push(call)
    currentTokens += tokens
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function decide(call: Call, keepCall: number, keepResult: number): Action {
  if (call.pinned) return "keep"
  if (keepResult >= KEEP_THRESHOLD) return "keep"
  if (keepCall >= KEEP_THRESHOLD) return "drop_result"
  return "drop_call"
}

function truncatedOutput(call: Call): string {
  if (call.output.length <= TRUNCATE_HEAD + 120) return call.output
  const head = TRUNCATE_HEAD > 0 ? `${call.output.slice(0, TRUNCATE_HEAD)}\n` : ""
  return `${head}[jev-compaction truncated ${call.output.length - TRUNCATE_HEAD} chars of this tool result${call.isError ? " (error)" : ""}; re-run the tool if needed]`
}

// --- telemetry -----------------------------------------------------------------
//
// Savings alone tell you nothing about whether the decisions are good. The number
// that matters is how often the model re-runs a tool whose result we dropped or
// truncated: that is the direct, measurable cost of a wrong call. Everything here
// exists so that trade-off is visible instead of assumed.

const LEDGER_FILE = join(STATE_DIR, "jev-compaction-ledger.jsonl")

/** Process-local counters, flushed on a throttle so hot paths stay cheap. */
const counters = {
  transformCalls: 0,
  engaged: 0,
  belowThreshold: 0,
  capReached: 0,
  overflow: 0,
  noKey: 0,
}
let lastFlush = 0
const FLUSH_MS = 60_000

/** Per-session record of what we removed, so a later repeat can be attributed to us. */
type SessionMemory = { dropped: Map<string, string>; truncated: Map<string, string> }
const sessions = new Map<string, SessionMemory>()

function memoryFor(sessionID: string): SessionMemory {
  let entry = sessions.get(sessionID)
  if (!entry) {
    if (sessions.size > 200) sessions.clear()
    entry = { dropped: new Map(), truncated: new Map() }
    sessions.set(sessionID, entry)
  }
  return entry
}

/**
 * Identifies "the same tool call" across steps regardless of its call id. A call
 * that reappears with a new id after we removed it is a re-run the model paid for.
 */
function signature(call: Call): string {
  let input = ""
  try {
    input = JSON.stringify(call.input)
  } catch {
    input = "[unserializable]"
  }
  return `${call.tool}\u0000${input}`
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

/** Fold the in-memory counters into the stats file, at most once a minute. */
function flushCounters(force = false) {
  const now = Date.now()
  if (!force && now - lastFlush < FLUSH_MS) return
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

// --- the pruner ----------------------------------------------------------------

async function prune(messages: Message[], reason: string): Promise<void> {
  if (!ENABLED) return
  try {
    counters.transformCalls += 1
    if (!Array.isArray(messages) || messages.length === 0) return

    const calls = collectCalls(messages)
    if (calls.length === 0) {
      flushCounters()
      return
    }

    const estimated = estimateTokens(JSON.stringify(messages))
    if (estimated < THRESHOLD_TOKENS) {
      counters.belowThreshold += 1
      trace("below threshold", { estimated, threshold: THRESHOLD_TOKENS })
      flushCounters()
      return
    }

    const allowed = Math.max(0, DAILY_REQUEST_CAP - dayUsage().requests)
    if (allowed === 0) {
      counters.capReached += 1
      trace("daily cap reached, skipping", { used: dayUsage().requests, cap: DAILY_REQUEST_CAP })
      flushCounters()
      return
    }
    if (!apiKey()) {
      counters.noKey += 1
      trace("no key, skipping")
      flushCounters()
      return
    }

    const started = Date.now()
    const sessionID = String(messages[0]?.info?.sessionID ?? "unknown")
    const memory = memoryFor(sessionID)
    const candidates = calls.filter((call) => !call.pinned && !decided.has(call.callID))
    const tokensBefore = messages.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0)

    // A call that turns up again under a fresh id, after we removed or shortened the
    // original, is one the model had to pay for twice. Counted before this run's own
    // decisions so a re-run is never attributed to the decision that caused it.
    let rerunAfterDrop = 0
    let rerunAfterTruncate = 0
    for (const call of calls) {
      const sig = signature(call)
      const droppedId = memory.dropped.get(sig)
      if (droppedId && droppedId !== call.callID) {
        rerunAfterDrop += 1
        memory.dropped.delete(sig)
      }
      const truncatedId = memory.truncated.get(sig)
      if (truncatedId && truncatedId !== call.callID) {
        rerunAfterTruncate += 1
        memory.truncated.delete(sig)
      }
    }

    let requests = 0
    let stage = "cache"
    if (candidates.length > 0) {
      const fitted = fitState(messages, calls)
      stage = fitted.stage
      if (fitted.stage === "overflow") {
        counters.overflow += 1
        trace("state overflow, skipping", { tokens: fitted.tokens })
    // Force the flush when something was pruned: the throttle exists to keep the
    // hot below-threshold path cheap, and a real prune is not on that path.
    flushCounters(counters.engaged > 0)
        return
      }
      // Reserve against the cap before firing: every request is already in flight by
      // the time the first answer returns, so checking only the total afterwards
      // would let a single run overshoot the ceiling.
      const send = batch(candidates, fitted.tokens).slice(0, allowed)
      if (send.length === 0) {
        trace("no request budget left for a batch", { stateTokens: fitted.tokens })
        return
      }
      dayUsage().requests += send.length
      writeUsage(dayUsage())

      const answered = await Promise.all(
        send.map(async (group) => {
          const questions = Object.assign({}, ...group.map(questionsFor))
          const answers = await ask(fitted.state, questions)
          requests += 1
          return group.map((call) => ({
            call,
            keepCall: noul(answers, `call_${call.id}`),
            keepResult: noul(answers, `result_${call.id}`),
          }))
        }),
      )
      if (decided.size > 5000) decided.clear()
      for (const group of answered) {
        for (const item of group) {
          const action = decide(item.call, item.keepCall, item.keepResult)
          trace("decision", {
            id: item.call.id,
            tool: item.call.tool,
            keepCall: item.keepCall,
            keepResult: item.keepResult,
            action,
          })
          decided.set(item.call.callID, action)
        }
      }
    }

    // Apply by part reference. Parts are held directly, so removing one cannot shift
    // the position of another in the same message.
    const drop = new Set<Part>()
    let dropped = 0
    let truncated = 0
    for (const call of calls) {
      const action = decided.get(call.callID)
      if (!action || action === "keep" || call.pinned) continue
      if (action === "drop_call") {
        drop.add(call.part)
        memory.dropped.set(signature(call), call.callID)
        dropped += 1
        continue
      }
      const next = truncatedOutput(call)
      if (next === call.output) continue
      if (call.part.state?.status === "completed") call.part.state.output = next
      else if (call.part.state?.status === "error") call.part.state.error = next
      memory.truncated.set(signature(call), call.callID)
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

    const tokensAfter = messages.reduce((sum, message) => sum + estimateTokens(JSON.stringify(message)), 0)
    const tokensSaved = Math.max(0, tokensBefore - tokensAfter)
    const ms = Date.now() - started

    counters.engaged += 1
    updateStats((stats) => {
      stats.runs = (Number(stats.runs) || 0) + 1
      stats.tokensSaved = (Number(stats.tokensSaved) || 0) + tokensSaved
      stats.callsSeen = (Number(stats.callsSeen) || 0) + calls.length
      stats.dropped = (Number(stats.dropped) || 0) + dropped
      stats.truncated = (Number(stats.truncated) || 0) + truncated
      stats.rerunAfterDrop = (Number(stats.rerunAfterDrop) || 0) + rerunAfterDrop
      stats.rerunAfterTruncate = (Number(stats.rerunAfterTruncate) || 0) + rerunAfterTruncate
      stats.last = {
        tokensBefore,
        tokensAfter,
        tokensSaved,
        calls: calls.length,
        dropped,
        truncated,
        requests,
        ms,
        stage,
        rerunAfterDrop,
        rerunAfterTruncate,
      }
    })
    flushCounters()

    // One line per run that actually changed something, so the history can be
    // analysed later without having had debug logging on at the time.
    if (dropped > 0 || truncated > 0 || rerunAfterDrop > 0 || rerunAfterTruncate > 0) {
      appendLedger({
        at: new Date().toISOString(),
        session: sessionID,
        reason,
        stage,
        tokensBefore,
        tokensAfter,
        tokensSaved,
        calls: calls.length,
        dropped,
        truncated,
        requests,
        rerunAfterDrop,
        rerunAfterTruncate,
        ms,
      })
    }
    trace("pruned", {
      reason,
      session: sessionID,
      stage,
      requests,
      dropped,
      truncated,
      tokensSaved,
      rerunAfterDrop,
      rerunAfterTruncate,
    })
  } catch (error) {
    trace("prune failed", { error: String((error as Error)?.message ?? error) })
  }
}

// --- plugin --------------------------------------------------------------------

async function server() {
  return {
    "experimental.chat.messages.transform": async (_input: unknown, output: { messages: Message[] }) => {
      await prune(output.messages, "step")
    },

    "experimental.session.compacting": async (_input: unknown, output: { context: string[]; prompt?: string }) => {
      output.context.push(
        "Tool results marked `[jev-compaction truncated …]` were shortened deliberately: the call is still " +
          "historically accurate but the body was dropped as no longer needed. Do not treat them as tool failures.",
      )
    },
  }
}

export default { id: "jev-compaction", server }
