#!/usr/bin/env node

import { buildAgentMatrix, formatAgentMatrix, formatUsage, getRecords, getUsage } from "./stats.js"

const args = process.argv.slice(2)

function agentUsageJson(records) {
  const matrix = buildAgentMatrix(records)
  return Object.fromEntries(
    matrix.rows.map((row) => [
      row.skill,
      Object.fromEntries(
        matrix.agents.flatMap((agent, index) =>
          row.counts[index] > 0 ? [[agent, row.counts[index]]] : [],
        ),
      ),
    ]),
  )
}

try {
  const json = args.includes("--json")
  const agent = args.includes("--agent")
  const period = args.find((arg) => arg !== "--json" && arg !== "--agent") ?? "30"

  if (agent) {
    const records = await getRecords(period)
    if (json) {
      console.log(JSON.stringify(agentUsageJson(records)))
    } else {
      const text = formatAgentMatrix(records)
      if (text) console.log(text)
    }
  } else {
    const entries = await getUsage(period)
    if (json) {
      console.log(JSON.stringify(Object.fromEntries(entries)))
    } else {
      const text = formatUsage(entries)
      if (text) console.log(text)
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
