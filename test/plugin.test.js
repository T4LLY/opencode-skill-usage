import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import serverModule from "../src/server.js"
import {
  createServer,
  resolveRetentionDays,
  resolveSessionCacheLimit,
} from "../src/server-core.js"
import {
  HOUR_MS,
  MINUTE_MS,
  DAY_MS,
  buildAgentMatrix,
  buildUsageRows,
  formatAgentMatrix,
  formatUsage,
  getRecords,
  normalizePeriod,
  parsePeriod,
} from "../src/stats.js"
import tuiModule from "../src/tui.js"
import manifest from "../package.json" with { type: "json" }

const root = await mkdtemp(join(tmpdir(), "opencode-skill-usage-"))
const statePath = join(root, "opencode-state")
const usageDir = join(statePath, "skill-usage")

async function writeRecords(records) {
  await mkdir(usageDir, { recursive: true })
  const byDay = new Map()
  for (const record of records) {
    const day = record.ts.slice(0, 10)
    const list = byDay.get(day) ?? []
    list.push(record)
    byDay.set(day, list)
  }
  for (const [day, list] of byDay) {
    await writeFile(
      join(usageDir, `${day}.jsonl`),
      `${list.map((record) => JSON.stringify(record)).join("\n")}\n`,
    )
  }
}

test.after(async () => {
  await rm(root, { recursive: true, force: true })
})

test("manifest exposes separate server/TUI targets and bounded cache default", () => {
  assert.equal(manifest.version, "0.7.2")
  assert.equal(manifest.main, "./src/server.js")
  assert.equal(manifest.exports["./server"].import, "./src/server.js")
  assert.deepEqual(manifest.exports["./server"].config, {
    retentionDays: 30,
    sessionCacheLimit: 256,
  })
  assert.equal(manifest.exports["./tui"].import, "./src/tui.js")
  assert.equal(typeof serverModule.server, "function")
  assert.equal(typeof tuiModule.tui, "function")
})

test("server options default and validate", () => {
  assert.equal(resolveRetentionDays(undefined), 30)
  assert.equal(resolveRetentionDays({ retentionDays: 7 }), 7)
  assert.equal(resolveRetentionDays({ retentionDays: 0 }), 30)
  assert.equal(resolveRetentionDays({ retentionDays: "7" }), 30)

  assert.equal(resolveSessionCacheLimit(undefined), 256)
  assert.equal(resolveSessionCacheLimit({ sessionCacheLimit: 32 }), 32)
  assert.equal(resolveSessionCacheLimit({ sessionCacheLimit: 0 }), 256)
  assert.equal(resolveSessionCacheLimit({ sessionCacheLimit: "32" }), 256)
})

test("period parser supports minutes, hours, days, all, and legacy bare days", () => {
  const now = Date.UTC(2026, 7, 19, 0, 0, 0)
  assert.equal(normalizePeriod(" 30M "), "30m")
  assert.equal(normalizePeriod("2H"), "2h")
  assert.equal(normalizePeriod("1d"), "1d")
  assert.equal(normalizePeriod("7"), "7d")
  assert.equal(normalizePeriod("ALL"), "all")
  assert.equal(parsePeriod("30m", now), now - 30 * MINUTE_MS)
  assert.equal(parsePeriod("2h", now), now - 2 * HOUR_MS)
  assert.equal(parsePeriod("1d", now), now - DAY_MS)
  assert.equal(parsePeriod("all", now), undefined)
  assert.throws(() => normalizePeriod("0h"), /Invalid period/)
  assert.throws(() => normalizePeriod("1.5h"), /Invalid period/)
  assert.throws(() => normalizePeriod("week"), /Invalid period/)
})

test("server initialization performs no SDK access", async () => {
  const client = new Proxy(
    {},
    {
      get() {
        throw new Error("server plugin touched the OpenCode client during startup")
      },
    },
  )

  const hooks = await serverModule.server(
    { client },
    { retentionDays: 60, sessionCacheLimit: 64 },
  )
  assert.equal(typeof hooks["chat.params"], "function")
  assert.equal(typeof hooks["tool.execute.after"], "function")
})

test("server records skill and agent without SDK lookups", async () => {
  await rm(usageDir, { recursive: true, force: true })
  const hooks = createServer({ retentionDays: 30, sessionCacheLimit: 256 }, statePath)

  await hooks["chat.params"]({ sessionID: "s1", agent: "orchestrator" })
  await hooks["chat.params"]({ sessionID: "s2", agent: "librarian" })
  await hooks["tool.execute.after"]({ tool: "read", sessionID: "s1", args: { name: "ignored" } })
  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "s1", args: { name: "gitnexus-cli" } })
  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "s2", args: { name: "context7-cli" } })
  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "unknown", args: { name: "jq-cli" } })

  const records = await getRecords("all", Date.now(), usageDir)
  assert.deepEqual(
    records.map(({ skill, agent }) => ({ skill, agent })),
    [
      { skill: "gitnexus-cli", agent: "orchestrator" },
      { skill: "context7-cli", agent: "librarian" },
      { skill: "jq-cli", agent: undefined },
    ],
  )
})

test("session-agent cache is cleaned by lifecycle events and dispose", async () => {
  await rm(usageDir, { recursive: true, force: true })
  const hooks = createServer({ retentionDays: 30, sessionCacheLimit: 256 }, statePath)

  await hooks["chat.params"]({ sessionID: "idle-session", agent: "orchestrator" })
  await hooks.event({ event: { type: "session.idle", properties: { sessionID: "idle-session" } } })
  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "idle-session", args: { name: "after-idle" } })

  await hooks["chat.params"]({ sessionID: "deleted-session", agent: "oracle" })
  await hooks.event({
    event: { type: "session.deleted", properties: { info: { id: "deleted-session" } } },
  })
  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "deleted-session", args: { name: "after-delete" } })

  await hooks["chat.params"]({ sessionID: "dispose-session", agent: "librarian" })
  await hooks.dispose()
  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "dispose-session", args: { name: "after-dispose" } })

  const records = await getRecords("all", Date.now(), usageDir)
  assert.ok(records.every((record) => record.agent === undefined))
})

test("configurable cache limit bounds memory if lifecycle events are missed", async () => {
  await rm(usageDir, { recursive: true, force: true })
  const hooks = createServer({ retentionDays: 30, sessionCacheLimit: 2 }, statePath)

  await hooks["chat.params"]({ sessionID: "s0", agent: "a0" })
  await hooks["chat.params"]({ sessionID: "s1", agent: "a1" })
  await hooks["chat.params"]({ sessionID: "s2", agent: "a2" })

  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "s0", args: { name: "oldest" } })
  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "s1", args: { name: "middle" } })
  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "s2", args: { name: "newest" } })

  const records = await getRecords("all", Date.now(), usageDir)
  assert.deepEqual(
    records.map(({ skill, agent }) => ({ skill, agent })),
    [
      { skill: "oldest", agent: undefined },
      { skill: "middle", agent: "a1" },
      { skill: "newest", agent: "a2" },
    ],
  )
})

test("retention cleanup runs on first recorded skill, not during startup", async () => {
  await rm(usageDir, { recursive: true, force: true })
  await mkdir(usageDir, { recursive: true })
  const oldPath = join(usageDir, "2000-01-01.jsonl")
  await writeFile(oldPath, '{"ts":"2000-01-01T00:00:00.000Z","skill":"old"}\n')

  const hooks = createServer({ retentionDays: 7, sessionCacheLimit: 256 }, statePath)
  assert.equal(await readFile(oldPath, "utf8"), '{"ts":"2000-01-01T00:00:00.000Z","skill":"old"}\n')

  await hooks["tool.execute.after"]({ tool: "skill", sessionID: "s1", args: { name: "fresh" } })
  await assert.rejects(readFile(oldPath, "utf8"), /ENOENT/)
})

test("record queries filter sub-day periods", async () => {
  await rm(usageDir, { recursive: true, force: true })
  const now = Date.now()
  await writeRecords([
    { ts: new Date(now - HOUR_MS).toISOString(), skill: "recent", agent: "orchestrator" },
    { ts: new Date(now - 3 * HOUR_MS).toISOString(), skill: "old", agent: "oracle" },
  ])

  const records = await getRecords("2h", now, usageDir)
  assert.deepEqual(records.map((record) => record.skill), ["recent"])
})

test("usage rows include unused installed skills and keep removed history", () => {
  const rows = buildUsageRows(
    [
      ["gitnexus-cli", 3],
      ["old-skill", 2],
    ],
    ["gitnexus-cli", "uiua"],
  )

  assert.deepEqual(rows, [
    { skill: "gitnexus-cli", count: 3, removed: false },
    { skill: "uiua", count: 0, removed: false },
    { skill: "old-skill", count: 2, removed: true },
  ])
  const text = formatUsage(
    [
      ["gitnexus-cli", 3],
      ["old-skill", 2],
    ],
    ["gitnexus-cli", "uiua"],
  )
  assert.match(text, /gitnexus-cli\s+3/)
  assert.match(text, /uiua\s+0/)
  assert.match(text, /old-skill \[removed\]\s+2/)
})

test("agent matrix uses Skills as rows and agents as columns", () => {
  const records = [
    { ts: "2026-08-19T00:00:00.000Z", skill: "gitnexus-cli", agent: "orchestrator" },
    { ts: "2026-08-19T00:00:01.000Z", skill: "gitnexus-cli", agent: "orchestrator" },
    { ts: "2026-08-19T00:00:02.000Z", skill: "gitnexus-cli", agent: "oracle" },
    { ts: "2026-08-19T00:00:03.000Z", skill: "context7-cli", agent: "librarian" },
    { ts: "2026-08-19T00:00:04.000Z", skill: "old-skill" },
  ]
  const matrix = buildAgentMatrix(records, ["gitnexus-cli", "context7-cli", "uiua"])

  assert.deepEqual(matrix.agents, ["orchestrator", "librarian", "oracle", "unknown"])
  assert.deepEqual(
    matrix.rows.map((row) => [row.skill, row.removed, row.counts]),
    [
      ["gitnexus-cli", false, [2, 0, 1, 0]],
      ["context7-cli", false, [0, 1, 0, 0]],
      ["uiua", false, [0, 0, 0, 0]],
      ["old-skill", true, [0, 0, 0, 1]],
    ],
  )

  const text = formatAgentMatrix(records, ["gitnexus-cli", "context7-cli", "uiua"])
  assert.match(text, /^Skill\s+orchestrator\s+librarian\s+oracle\s+unknown/m)
  assert.match(text, /gitnexus-cli\s+2\s+0\s+1\s+0/)
})

function createTuiHarness(promptAnswers = []) {
  const layers = []
  let dialogProps
  let dialogSize
  let dialogOnClose
  const toasts = []

  function DialogSelect(props) {
    dialogProps = props
    return props
  }

  function DialogPrompt() {}
  DialogPrompt.show = async () => (promptAnswers.length ? promptAnswers.shift() : null)

  const api = {
    state: { path: { state: statePath } },
    client: {
      app: {
        async skills() {
          return { data: [{ name: "gitnexus-cli" }, { name: "uiua" }] }
        },
      },
    },
    keymap: {
      registerLayer(value) {
        const entry = { value, disposed: false }
        layers.push(entry)
        return () => {
          entry.disposed = true
        }
      },
    },
    ui: {
      DialogSelect,
      DialogPrompt,
      toast(value) {
        toasts.push(value)
      },
      dialog: {
        replace(render, onClose) {
          dialogOnClose?.()
          dialogOnClose = onClose
          render()
        },
        setSize(value) {
          dialogSize = value
        },
        clear() {
          dialogOnClose?.()
          dialogOnClose = undefined
        },
      },
    },
  }

  return {
    api,
    get commandLayer() {
      return layers.find((entry) => entry.value.commands)?.value
    },
    get modalLayer() {
      return [...layers]
        .reverse()
        .find((entry) => entry.value.mode === "modal" && !entry.disposed)?.value
    },
    get dialogProps() {
      return dialogProps
    },
    get dialogSize() {
      return dialogSize
    },
    toasts,
  }
}

test("TUI views are scrollable/filterable and modal P changes period", async () => {
  await rm(usageDir, { recursive: true, force: true })
  const now = Date.now()
  await writeRecords([
    { ts: new Date(now - HOUR_MS).toISOString(), skill: "gitnexus-cli", agent: "orchestrator" },
    { ts: new Date(now - 3 * HOUR_MS).toISOString(), skill: "gitnexus-cli", agent: "oracle" },
    { ts: new Date(now - HOUR_MS).toISOString(), skill: "old-skill", agent: "oracle" },
  ])

  const harness = createTuiHarness(["2h"])
  await tuiModule.tui(harness.api)
  assert.equal(harness.commandLayer.commands.length, 2)

  const usage = harness.commandLayer.commands.find((command) => command.slashName === "skill-usage")
  assert.ok(usage)
  await usage.run()

  assert.equal(harness.dialogSize, "xlarge")
  assert.equal(harness.dialogProps.title, "Skill Usage [all]")
  assert.equal(harness.dialogProps.placeholder, "Filter skills · P: Period")
  assert.equal(harness.dialogProps.footerHints, undefined)
  assert.equal(harness.dialogProps.bindings, undefined)
  assert.equal(harness.modalLayer.mode, "modal")
  assert.equal(harness.modalLayer.bindings[0].key, "shift+p")
  assert.equal(harness.modalLayer.bindings[0].desc, "Period")
  assert.match(harness.dialogProps.options[0].category, /^Skill\s+Calls/)
  assert.ok(harness.dialogProps.options.some((option) => /uiua\s+0/.test(option.title)))

  const periodCommand = harness.modalLayer.bindings[0].cmd
  await periodCommand()
  assert.equal(harness.dialogProps.title, "Skill Usage [2h]")
  const gitnexus = harness.dialogProps.options.find((option) => option.title.includes("gitnexus-cli"))
  assert.match(gitnexus.title, /gitnexus-cli\s+1/)
})

test("closing the usage dialog disposes its modal Period binding", async () => {
  await rm(usageDir, { recursive: true, force: true })
  const harness = createTuiHarness()
  await tuiModule.tui(harness.api)

  const usage = harness.commandLayer.commands.find((command) => command.slashName === "skill-usage")
  await usage.run()
  assert.ok(harness.modalLayer)

  harness.api.ui.dialog.clear()
  assert.equal(harness.modalLayer, undefined)
})

test("invalid TUI period warns and keeps the current view", async () => {
  await rm(usageDir, { recursive: true, force: true })
  const harness = createTuiHarness(["1.5h"])
  await tuiModule.tui(harness.api)

  const usage = harness.commandLayer.commands.find((command) => command.slashName === "skill-usage")
  await usage.run()
  await harness.modalLayer.bindings[0].cmd()

  assert.equal(harness.dialogProps.title, "Skill Usage [all]")
  assert.equal(harness.toasts.length, 1)
  assert.match(harness.toasts[0].message, /Invalid period/)
  assert.equal(harness.toasts[0].variant, "warning")
})

test("agent TUI command renders a two-dimensional matrix", async () => {
  await rm(usageDir, { recursive: true, force: true })
  const now = Date.now()
  await writeRecords([
    { ts: new Date(now).toISOString(), skill: "gitnexus-cli", agent: "orchestrator" },
    { ts: new Date(now).toISOString(), skill: "gitnexus-cli", agent: "oracle" },
  ])

  const harness = createTuiHarness()
  await tuiModule.tui(harness.api)
  const byAgent = harness.commandLayer.commands.find((command) => command.slashName === "skill-usage-agent")
  await byAgent.run()

  assert.equal(harness.dialogProps.title, "Skill Usage by Agent [all]")
  assert.match(harness.dialogProps.options[0].category, /^Skill\s+oracle\s+orchestrator|^Skill\s+orchestrator\s+oracle/)
  assert.ok(harness.dialogProps.options.some((option) => /gitnexus-cli\s+1\s+1/.test(option.title)))
  assert.ok(harness.dialogProps.options.some((option) => /uiua\s+0\s+0/.test(option.title)))
})

test("TUI activation errors are not hidden", async () => {
  await assert.rejects(() => tuiModule.tui({}), /registerLayer/)
})
