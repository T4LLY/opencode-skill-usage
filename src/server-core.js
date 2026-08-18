import { appendFile, mkdir, readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { DAY_MS, defaultOpenCodeStatePath, logDir } from "./stats.js"

export const DEFAULT_RETENTION_DAYS = 30
export const DEFAULT_SESSION_CACHE_LIMIT = 256

export function resolveRetentionDays(options) {
  const value = options?.retentionDays
  return Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_RETENTION_DAYS
}

export function resolveSessionCacheLimit(options) {
  const value = options?.sessionCacheLimit
  return Number.isSafeInteger(value) && value >= 1 ? value : DEFAULT_SESSION_CACHE_LIMIT
}

function logFile(dir, ts = new Date()) {
  return join(dir, `${ts.toISOString().slice(0, 10)}.jsonl`)
}

export async function pruneLogs(dir, days, now = Date.now()) {
  let names
  try {
    names = await readdir(dir)
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }

  const cutoff = now - days * DAY_MS

  await Promise.all(
    names.map(async (name) => {
      const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
      if (!match) return

      const fileTime = Date.parse(`${match[1]}T00:00:00.000Z`)
      if (!Number.isFinite(fileTime) || fileTime + DAY_MS > cutoff) return

      try {
        await rm(join(dir, name))
      } catch {
        // Retention cleanup must never affect OpenCode.
      }
    }),
  )
}

/**
 * Create hooks without touching OpenCode APIs or the filesystem.
 *
 * Why: OpenCode awaits plugin activation during its own startup. Keep
 * activation synchronous in effect: build closures now, defer all I/O until a
 * Skill has actually completed.
 *
 * OpenCode's tool.execute.after hook does not expose the active agent, while
 * chat.params exposes both sessionID and agent before model/tool execution.
 * Keep a tiny in-memory session -> agent map instead of performing SDK/session
 * lookups for every Skill. Session lifecycle events remove entries, dispose
 * clears the cache, and a configurable hard cap prevents unbounded growth even
 * if cleanup events are missed. The default cap is deliberately small because
 * users may run several OpenCode processes at once. If a mapping is unavailable,
 * the event is still recorded without agent so telemetry can never block Skill
 * execution.
 *
 * statePath is injectable for tests. Runtime storage follows OpenCode's
 * XDG-style state location without calling the SDK during startup.
 */
export function createServer(options, statePath = defaultOpenCodeStatePath()) {
  const retentionDays = resolveRetentionDays(options)
  const sessionCacheLimit = resolveSessionCacheLimit(options)
  const dir = logDir(statePath)
  const sessionAgents = new Map()
  let lastPrune = 0

  function forgetSession(sessionID) {
    if (typeof sessionID === "string" && sessionID.length > 0) {
      sessionAgents.delete(sessionID)
    }
  }

  function rememberSessionAgent(sessionID, agent) {
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    if (typeof agent !== "string" || agent.length === 0) return

    // Refresh insertion order so the fallback bound keeps recently active
    // sessions. Normal cleanup happens via session lifecycle events below.
    sessionAgents.delete(sessionID)
    sessionAgents.set(sessionID, agent)

    // Lifecycle events are best-effort observability signals. Even if idle or
    // deleted events are missed, cap the cache so it can never grow without
    // bound in a long-lived OpenCode process.
    if (sessionAgents.size > sessionCacheLimit) {
      const oldestSessionID = sessionAgents.keys().next().value
      if (oldestSessionID !== undefined) sessionAgents.delete(oldestSessionID)
    }
  }

  return {
    "chat.params": async (input) => {
      rememberSessionAgent(input?.sessionID, input?.agent)
    },

    event: async (input) => {
      const event = input?.event
      if (event?.type === "session.idle") {
        forgetSession(event.properties?.sessionID)
        return
      }

      if (event?.type === "session.deleted") {
        // Current OpenCode emits the deleted Session as properties.info. Keep
        // sessionID as a defensive fallback for compatible event variants.
        forgetSession(event.properties?.info?.id ?? event.properties?.sessionID)
      }
    },

    dispose: async () => {
      sessionAgents.clear()
    },

    "tool.execute.after": async (input) => {
      // Count completed Skill loads, not attempts. `after` also keeps the logger
      // observational: it never participates in deciding whether a Skill runs.
      if (input?.tool !== "skill") return

      const skill = input.args?.name
      if (typeof skill !== "string" || skill.length === 0) return

      try {
        const now = new Date()
        const record = { ts: now.toISOString(), skill }
        const agent = sessionAgents.get(input.sessionID)
        if (agent) record.agent = agent

        await mkdir(dir, { recursive: true })
        // One append-only file per UTC day makes retention a file deletion
        // problem instead of a read/trim/rewrite problem. That matters when
        // multiple OpenCode processes may append usage at the same time.
        await appendFile(logFile(dir, now), `${JSON.stringify(record)}\n`, "utf8")

        const nowMs = now.getTime()
        if (lastPrune === 0 || nowMs - lastPrune >= DAY_MS) {
          lastPrune = nowMs
          await pruneLogs(dir, retentionDays, nowMs)
        }
      } catch {
        // Usage data is telemetry, not product state. A full disk, permissions
        // error, or malformed old log must never fail the Skill that just ran.
      }
    },
  }
}
