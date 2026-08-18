import { readFile, readdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const MINUTE_MS = 60_000
export const HOUR_MS = 3_600_000
export const DAY_MS = 86_400_000
export const DEFAULT_PERIOD_DAYS = 30

/**
 * Usage history is state, not configuration and not a project artifact. Keep it
 * out of ~/.config/opencode and .opencode so it is neither hand-edited config
 * nor accidentally committed with a repository.
 */
export function defaultOpenCodeStatePath() {
  const root = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state")
  return join(root, "opencode")
}

export function logDir(statePath = defaultOpenCodeStatePath()) {
  return join(statePath, "skill-usage")
}

/**
 * Accept compact periods for both the CLI and the TUI period prompt.
 * Bare integers remain days for backward compatibility with the original CLI.
 */
export function normalizePeriod(period = String(DEFAULT_PERIOD_DAYS)) {
  const value = String(period).trim().toLowerCase()
  if (value === "all") return "all"

  const match = /^(\d+)([mhd]?)$/.exec(value)
  if (!match) throw new Error(`Invalid period: ${period}`)

  const amount = Number(match[1])
  if (!Number.isSafeInteger(amount) || amount < 1) {
    throw new Error(`Invalid period: ${period}`)
  }

  return `${amount}${match[2] || "d"}`
}

export function parsePeriod(period = String(DEFAULT_PERIOD_DAYS), now = Date.now()) {
  const normalized = normalizePeriod(period)
  if (normalized === "all") return undefined

  const match = /^(\d+)([mhd])$/.exec(normalized)
  const amount = Number(match[1])
  const unitMs = { m: MINUTE_MS, h: HOUR_MS, d: DAY_MS }[match[2]]
  const duration = amount * unitMs

  if (!Number.isSafeInteger(duration)) {
    throw new Error(`Invalid period: ${period}`)
  }

  return now - duration
}

function parseLine(line) {
  try {
    const record = JSON.parse(line)
    if (!record || typeof record !== "object") return undefined
    if (typeof record.ts !== "string" || typeof record.skill !== "string") return undefined
    if (!Number.isFinite(Date.parse(record.ts)) || record.skill.length === 0) return undefined
    if (record.agent !== undefined && typeof record.agent !== "string") return undefined
    return record
  } catch {
    return undefined
  }
}

export async function getRecords(
  period = String(DEFAULT_PERIOD_DAYS),
  now = Date.now(),
  dir = logDir(),
) {
  const cutoff = parsePeriod(period, now)

  let names = []
  try {
    names = (await readdir(dir)).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
  } catch (error) {
    if (error?.code !== "ENOENT") throw error
  }

  const records = []

  for (const name of names) {
    // A whole UTC day ending before the cutoff cannot contain matching records.
    // Skip it before reading the file so short TUI queries stay cheap even when
    // retention spans many daily files.
    if (cutoff !== undefined) {
      const dayStart = Date.parse(`${name.slice(0, 10)}T00:00:00.000Z`)
      if (Number.isFinite(dayStart) && dayStart + DAY_MS <= cutoff) continue
    }

    let text
    try {
      text = await readFile(join(dir, name), "utf8")
    } catch {
      continue
    }

    for (const line of text.split(/\r?\n/)) {
      if (!line) continue

      const record = parseLine(line)
      if (!record) continue
      if (cutoff !== undefined && Date.parse(record.ts) < cutoff) continue
      records.push(record)
    }
  }

  return records
}

export async function getUsage(
  period = String(DEFAULT_PERIOD_DAYS),
  now = Date.now(),
  dir = logDir(),
) {
  const counts = new Map()
  for (const record of await getRecords(period, now, dir)) {
    counts.set(record.skill, (counts.get(record.skill) ?? 0) + 1)
  }

  return [...counts.entries()].sort(
    ([skillA, countA], [skillB, countB]) => countB - countA || skillA.localeCompare(skillB),
  )
}

function normalizeInstalledSkills(skills) {
  if (skills === undefined) return undefined
  return [...new Set(skills.filter((name) => typeof name === "string" && name.length > 0))]
}

export function buildUsageRows(entries, installedSkills) {
  const installed = normalizeInstalledSkills(installedSkills)
  if (installed === undefined) {
    return entries.map(([skill, count]) => ({ skill, count, removed: false }))
  }

  const installedSet = new Set(installed)
  const counts = new Map(entries)
  const names = new Set([...installed, ...counts.keys()])

  return [...names]
    .map((skill) => ({
      skill,
      count: counts.get(skill) ?? 0,
      removed: !installedSet.has(skill),
    }))
    .sort(
      (a, b) =>
        Number(a.removed) - Number(b.removed) ||
        b.count - a.count ||
        a.skill.localeCompare(b.skill),
    )
}

function formatTable(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)),
  )
  const formatRow = (row) =>
    row.map((cell, index) => String(cell).padEnd(widths[index])).join("  ").trimEnd()
  return [formatRow(headers), ...rows.map(formatRow)].join("\n")
}

export function formatUsage(entries, installedSkills) {
  const rows = buildUsageRows(entries, installedSkills)
  if (rows.length === 0) return ""

  return formatTable(
    ["Skill", "Calls"],
    rows.map((row) => [`${row.skill}${row.removed ? " [removed]" : ""}`, row.count]),
  )
}

export function buildAgentMatrix(records, installedSkills) {
  const installed = normalizeInstalledSkills(installedSkills)
  const installedSet = installed === undefined ? undefined : new Set(installed)
  const skillAgentCounts = new Map()
  const agentTotals = new Map()
  const skillTotals = new Map()

  for (const record of records) {
    const agent = typeof record.agent === "string" && record.agent.length > 0 ? record.agent : "unknown"
    let agents = skillAgentCounts.get(record.skill)
    if (!agents) {
      agents = new Map()
      skillAgentCounts.set(record.skill, agents)
    }
    agents.set(agent, (agents.get(agent) ?? 0) + 1)
    agentTotals.set(agent, (agentTotals.get(agent) ?? 0) + 1)
    skillTotals.set(record.skill, (skillTotals.get(record.skill) ?? 0) + 1)
  }

  const agents = [...agentTotals.keys()].sort((a, b) => {
    if (a === "unknown") return 1
    if (b === "unknown") return -1
    return (agentTotals.get(b) ?? 0) - (agentTotals.get(a) ?? 0) || a.localeCompare(b)
  })

  const names = new Set([...(installed ?? []), ...skillAgentCounts.keys()])
  const rows = [...names]
    .map((skill) => ({
      skill,
      removed: installedSet === undefined ? false : !installedSet.has(skill),
      total: skillTotals.get(skill) ?? 0,
      counts: agents.map((agent) => skillAgentCounts.get(skill)?.get(agent) ?? 0),
    }))
    .sort(
      (a, b) =>
        Number(a.removed) - Number(b.removed) ||
        b.total - a.total ||
        a.skill.localeCompare(b.skill),
    )

  return { agents, rows }
}

export function formatAgentMatrix(records, installedSkills) {
  const matrix = buildAgentMatrix(records, installedSkills)
  if (matrix.rows.length === 0) return ""
  if (matrix.agents.length === 0) return "No agent usage recorded."

  return formatTable(
    ["Skill", ...matrix.agents],
    matrix.rows.map((row) => [
      `${row.skill}${row.removed ? " [removed]" : ""}`,
      ...row.counts,
    ]),
  )
}
