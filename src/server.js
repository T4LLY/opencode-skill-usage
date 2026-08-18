import { createServer } from "./server-core.js"

/**
 * OpenCode has separate server and TUI plugin runtimes. Keep this entrypoint
 * server-only even though both targets ship in the same npm package. The
 * package manifest exposes ./server and ./tui separately so OpenCode's own
 * `opencode plugin` installer can register each target in the correct runtime.
 *
 * Do not replace this with a prompt/custom command just to make /skill-usage
 * appear: those commands are sent through the agent/LLM path. The no-LLM slash
 * command belongs in src/tui.js.
 */
async function server(_input, options) {
  return createServer(options)
}

export default {
  id: "t4lly.opencode-skill-usage.server",
  server,
}
