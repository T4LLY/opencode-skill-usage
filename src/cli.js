#!/usr/bin/env node

import { formatUsage, getUsage } from "./stats.js"

const args = process.argv.slice(2)

try {
  const json = args.includes("--json")
  const period = args.find((arg) => arg !== "--json") ?? "30"
  const entries = await getUsage(period)

  if (json) {
    console.log(JSON.stringify(Object.fromEntries(entries)))
  } else {
    const text = formatUsage(entries)
    if (text) console.log(text)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
