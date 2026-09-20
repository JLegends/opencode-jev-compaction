// jev-savings — TUI sidebar widget that reports what the jev-compaction server
// plugin has removed from context. Reads the stats file the server plugin writes.
//
// Plain JS with getters on purpose. opencode loads published plugins from inside
// node_modules, and its bundled Bun runtime does not apply the JSX transform to
// files there, so a shipped .tsx never executes. Getters are what a Solid-aware
// JSX compiler would emit for reactive props, so this is the compiled form.

import { createSignal, Show } from "solid-js"
import { jsx, jsxs } from "@opentui/solid/jsx-runtime"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

const id = "jev-savings"

const POLL_MS = 3000

const STATS_FILE = join(homedir(), ".local", "share", "opencode", "jev-compaction.json")

const empty = () => ({ runs: 0, tokensSaved: 0, callsSeen: 0, dropped: 0, truncated: 0 })

function read() {
  try {
    const raw = JSON.parse(readFileSync(STATS_FILE, "utf8"))
    return {
      runs: Number(raw.runs) || 0,
      tokensSaved: Number(raw.tokensSaved) || 0,
      callsSeen: Number(raw.callsSeen) || 0,
      dropped: Number(raw.dropped) || 0,
      truncated: Number(raw.truncated) || 0,
    }
  } catch {
    return empty()
  }
}

function compact(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const tui = async (api) => {
  const [stats, setStats] = createSignal(empty())

  setStats(read())
  const timer = setInterval(() => setStats(read()), POLL_MS)
  api.lifecycle.onDispose(() => clearInterval(timer))

  api.slots.register({
    order: 91,
    slots: {
      sidebar_content() {
        return jsxs(Show, {
          get when() {
            return stats().runs > 0 && stats().tokensSaved > 0
          },
          get children() {
            return jsxs("box", {
              children: [
                jsx("text", {
                  get fg() {
                    return api.theme.current.text
                  },
                  get children() {
                    return jsx("b", {
                      get children() {
                        return "Jev savings"
                      },
                    })
                  },
                }),
                jsx("text", {
                  get fg() {
                    return api.theme.current.textMuted
                  },
                  get children() {
                    return `~${compact(stats().tokensSaved)} tokens saved`
                  },
                }),
                jsx("text", {
                  get fg() {
                    return api.theme.current.textMuted
                  },
                  get children() {
                    const current = stats()
                    const plural = current.runs === 1 ? "run" : "runs"
                    return `${current.dropped} dropped, ${current.truncated} truncated · ${current.runs} ${plural}`
                  },
                }),
              ],
            })
          },
        })
      },
    },
  })
}

export default { id, tui }
