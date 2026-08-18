import { join } from "node:path"
import {
  defaultOpenCodeStatePath,
  formatAgentMatrix,
  formatUsage,
  getRecords,
  getUsage,
  normalizePeriod,
} from "./stats.js"

async function installedSkillNames(api) {
  try {
    // Use the same OpenCode app.skills endpoint as the built-in Skills dialog.
    // This keeps zero-usage rows aligned with OpenCode's actual discovery and
    // avoids reimplementing project/global/.agents/.claude precedence here.
    const result = await api?.client?.app?.skills?.()
    const skills = Array.isArray(result) ? result : result?.data
    if (!Array.isArray(skills)) return undefined
    return skills.map((skill) => skill?.name).filter((name) => typeof name === "string")
  } catch {
    // Usage already recorded is still useful if skill discovery is temporarily
    // unavailable. Undefined tells the formatter not to mark entries removed.
    return undefined
  }
}

function stateUsageDir(api) {
  const statePath = api?.state?.path?.state || defaultOpenCodeStatePath()
  return join(statePath, "skill-usage")
}

function tableOptions(message) {
  const lines = String(message || "No Skills found.").split("\n")
  const header = lines.length > 1 ? lines.shift() : undefined
  const rows = lines.length > 0 ? lines : ["No Skills found."]

  return rows.map((title, index) => ({
    title,
    value: index,
    category: header,
    truncateTitle: false,
    titleWidth: 108,
  }))
}

function warn(api, message) {
  api?.ui?.toast?.({ message, variant: "warning" })
}

async function askPeriod(api, current) {
  const DialogPrompt = api?.ui?.DialogPrompt
  const dialog = api?.ui?.dialog
  if (typeof DialogPrompt !== "function" || typeof dialog?.replace !== "function") {
    throw new Error("OpenCode DialogPrompt is unavailable")
  }

  // The public TUI plugin API exposes DialogPrompt as a component plus the
  // dialog stack. OpenCode's internal DialogPrompt.show() helper is not part
  // of the public TuiPluginApi, so build the tiny Promise wrapper ourselves.
  return new Promise((resolve) => {
    let settled = false

    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }

    dialog.replace(
      () =>
        DialogPrompt({
          title: `Period [${current}]`,
          placeholder: "1m, 2h, 1d, 7d, 30d, all",
          onConfirm(value) {
            finish(value)
            dialog.clear()
          },
          onCancel() {
            finish(null)
            dialog.clear()
          },
        }),
      () => finish(null),
    )
  })
}

/**
 * Render usage through OpenCode's built-in DialogSelect rather than a static
 * alert. DialogSelect already owns a ScrollBox and standard arrow/page/mouse
 * navigation, so long zero-usage lists stay usable without a custom JSX UI.
 *
 * The visible filter is only for Skill-name filtering. Shift+P opens the host
 * DialogPrompt for the period. Period parsing remains local and deterministic
 * (m/h/d/all); no prompt is sent to an agent or LLM.
 */
function showScrollableUsage(api, title, period, message, onPeriod) {
  if (
    typeof api?.ui?.dialog?.replace !== "function" ||
    typeof api?.ui?.DialogSelect !== "function"
  ) {
    const text = `${title} [${period}]\n${message}`
    api?.ui?.toast?.({ message: text, variant: "info" })
    return
  }

  // DialogSelect's filter input owns normal text keys, so register Period at
  // the host modal-keymap layer instead of relying on undocumented component
  // props. The binding exists only while this usage dialog is open.
  let disposePeriodBinding
  const disposeBinding = () => {
    disposePeriodBinding?.()
    disposePeriodBinding = undefined
  }

  disposePeriodBinding = api.keymap.registerLayer({
    mode: "modal",
    bindings: [
      {
        key: "shift+p",
        cmd: async () => {
          // Do not leave this binding alive while DialogPrompt is on top of the
          // modal stack, otherwise Shift+P could recursively reopen the prompt.
          disposeBinding()
          await onPeriod()
        },
        desc: "Period",
      },
    ],
  })

  api.ui.dialog.replace(
    () =>
      api.ui.DialogSelect({
        title: `${title} [${period}]`,
        options: tableOptions(message),
        placeholder: "Filter skills · P: Period",
        preserveSelection: true,
        onSelect() {},
      }),
    disposeBinding,
  )
  api.ui.dialog.setSize?.("xlarge")
}

function usageRunner(api, kind) {
  const title = kind === "agent" ? "Skill Usage by Agent" : "Skill Usage"

  return async function run() {
    // A fresh slash invocation starts from all retained history. Period changes
    // are view-local and disappear when the dialog is closed.
    let period = "all"

    async function render() {
      let message
      try {
        const now = Date.now()
        const dir = stateUsageDir(api)
        const [data, skills] = await Promise.all([
          kind === "agent" ? getRecords(period, now, dir) : getUsage(period, now, dir),
          installedSkillNames(api),
        ])
        message =
          kind === "agent"
            ? formatAgentMatrix(data, skills) || "No Skills found."
            : formatUsage(data, skills) || "No Skills found."
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }

      showScrollableUsage(api, title, period, message, async () => {
        let input
        try {
          input = await askPeriod(api, period)
        } catch (error) {
          warn(api, error instanceof Error ? error.message : String(error))
          await render()
          return
        }

        if (input !== null && input.trim() !== "") {
          try {
            period = normalizePeriod(input)
          } catch (error) {
            warn(api, error instanceof Error ? error.message : String(error))
          }
        }

        // DialogPrompt replaces the table. Confirm or cancel returns to the same
        // usage view, with a valid new period applied if one was entered.
        await render()
      })
    }

    await render()
  }
}

/**
 * Register display commands in the TUI runtime, not the server runtime.
 *
 * OpenCode's ordinary custom commands are prompt templates and invoke an LLM.
 * `slashName` on TUI keymap commands executes run() directly. Keep both usage
 * views here so inspecting telemetry never spends model tokens.
 */
async function tui(api) {
  api.keymap.registerLayer({
    commands: [
      {
        name: "skill-usage.show",
        title: "Skill Usage",
        category: "Plugin",
        namespace: "palette",
        desc: "Show Skill usage including unused installed Skills",
        slashName: "skill-usage",
        run: usageRunner(api, "usage"),
      },
      {
        name: "skill-usage.agent",
        title: "Skill Usage by Agent",
        category: "Plugin",
        namespace: "palette",
        desc: "Show Skill usage as a Skill by Agent matrix",
        slashName: "skill-usage-agent",
        run: usageRunner(api, "agent"),
      },
    ],
  })
}

export default {
  id: "t4lly.opencode-skill-usage.tui",
  tui,
}
