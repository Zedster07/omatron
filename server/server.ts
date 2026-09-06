#!/usr/bin/env bun
// ============================================================================
//  desktop-agent -- policy-gated desktop control for Hyprland / Omarchy,
//  exposed to Claude Code as an MCP server over stdio.
//
//  Gives the agent eyes (screenshots), an inventory (window list) and hands
//  (focus, move, close, type, keys, mouse) -- but routes every single action
//  through ~/.config/desktop-agent/policy.jsonc first.
//
//  The policy file is re-read on EVERY call, so the leash can be tightened or
//  loosened mid-session just by saving the file. Nothing to restart.
//
//  Design notes worth knowing:
//   * Text and keys go to a *named window* via Hyprland's send_shortcut, which
//     does not steal focus. The agent can drive an app while you keep working.
//   * Text is delivered by clipboard + paste rather than synthesised
//     keystrokes: one atomic action, and Unicode survives intact. The previous
//     clipboard contents are put back afterwards.
//   * Refusals always name the rule responsible, because a fail-closed policy
//     you cannot debug is a policy you will end up switching off.
//   * An "ask" verdict is resolved by the Omarchy bar plugin's approval
//     overlay (dada.desktop-agent), not by Claude Code's own prompt. The
//     policy file is the single gate; allowlist this server in Claude Code so
//     the two do not both ask.
//
//  Environment:
//    DESKTOP_AGENT_POLICY          override the policy file path
//    DESKTOP_AGENT_IDENTITY        caller identity for the "agents" section
//    DESKTOP_AGENT_QS_SHELL        quickshell config path for the overlay IPC
//    DESKTOP_AGENT_ASK_TIMEOUT_MS  how long an approval may sit unanswered
// ============================================================================

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import * as browser from "./browser"
import { $ } from "bun"
import { AsyncLocalStorage } from "node:async_hooks"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// ----------------------------------------------------------------- constants

/**
 * Resolved on every call rather than captured at import time, so the policy
 * can be redirected (in tests, or per-session) without reloading the module.
 */
const policyPath = () =>
  process.env.DESKTOP_AGENT_POLICY || path.join(os.homedir(), ".config", "desktop-agent", "policy.jsonc")
const AUDIT_PATH = path.join(os.homedir(), ".local", "share", "desktop-agent", "desktop.log")
import { onWorkspace, isLaunch, confinementWorkspace, ensureAgentTerminal, sendToAgentTerminal, abortAgentTerminal } from "../voice/workspace.ts"
import { beat } from "../voice/heartbeat.ts"
import { runPool, concurrencyLimit } from "../voice/pool.ts"
import { closeSubagentWindows, purgeSubagentDirs } from "../voice/workspace.ts"
import { runSubagent } from "../voice/subagent.ts"
import { createJob, listJobs } from "../voice/schedule.ts"
import { settingStr } from "../voice/settings.ts"

// Per-user scratch. /tmp/desktop-agent is created by whoever gets there first
// and owned by them, so on a shared machine the second user hits EACCES on a
// path they cannot fix. XDG_RUNTIME_DIR is already per-user and cleaned up on
// logout; the uid suffix is the fallback for when it is not set.
const TMP = process.env.XDG_RUNTIME_DIR
  ? path.join(process.env.XDG_RUNTIME_DIR, "desktop-agent")
  : path.join(os.tmpdir(), `desktop-agent-${process.getuid?.() ?? "user"}`)

// Where a capture goes when the caller asks to keep it.
//
// Under state rather than XDG_RUNTIME_DIR because the point is to still be
// there after the run -- and after a logout, which is when someone actually
// goes looking for what the agent saw.
const SHOTS = path.join(os.homedir(), ".local", "state", "desktop-agent", "shots")

/**
 * Keep the last 40 saved captures and delete the rest.
 *
 * Unbounded, this is a folder of desktop photographs that grows for as long as
 * the plugin is installed and that nobody ever thinks to look in. A cap is not
 * a privacy control -- the person can empty the folder -- but "the last few
 * runs" is what the feature is actually for.
 */
async function pruneShots(keep = 40) {
  try {
    const names = (await fs.readdir(SHOTS)).filter((n) => n.endsWith(".png")).sort()
    for (const n of names.slice(0, Math.max(0, names.length - keep)))
      await fs.rm(path.join(SHOTS, n), { force: true }).catch(() => {})
  } catch {}
}

/**
 * Which identity the "agents" policy section is matched against. MCP gives the
 * server no way to see which Claude Code subagent is calling, so this is fixed
 * per server entry rather than per call. Run two entries with different values
 * if you want two different leashes.
 */
const IDENTITY = process.env.DESKTOP_AGENT_IDENTITY?.trim() || "agent"

/**
 * Workspace that anything the agent OPENS gets placed on.
 *
 * This used to live only in the hand-off prompt, as a sentence asking the
 * agent to launch things with a [workspace N silent] prefix. Prompt text is a
 * request, not a mechanism: the agent mostly ignored it and dropped windows
 * into the middle of whatever the person was doing. Placement belongs here,
 * where every window-opening path goes through one function and no model has
 * to remember anything.
 *
 * Per-run via the env the runner sets, falling back to the saved setting so it
 * also applies to a plain Claude Code session using this MCP server. 0 is off.
 */
const CONFINE_WS = confinementWorkspace()

/**
 * Master or delegated subagent.
 *
 * Set by the code that spawns a subagent, so a subagent cannot claim otherwise
 * -- it never sees its own spawn arguments and cannot rewrite the environment
 * of a process that already exists.
 *
 * Two things belong to the master alone, and both for the same reason: they
 * are not parallelisable, so handing them to five subagents produces a fight
 * rather than five times the work.
 *
 *   the browser   one instance, one debugger connection, one page. Five agents
 *                 navigating it would each see whatever the last one loaded.
 *
 *   delegation    a subagent that can delegate can fan out without bound, and
 *                 the fan-out is exponential rather than linear. Depth one is
 *                 not a limitation of this design, it IS the design.
 *
 * Enforced here rather than asked for in a prompt. A rule the model is told
 * about is a rule it can reason its way around when a task seems to need it;
 * this one it simply cannot reach.
 */
/**
 * Drop marker files nothing is waiting for any more.
 *
 * The happy path unlinks them after reading. The unhappy ones do not: a
 * command that outlives its deadline, a server killed mid-call, a test that
 * polls the files and walks away. Each leak is two tiny files, which is
 * exactly the size of leak that never gets noticed and never stops.
 *
 * An hour is far longer than any tool call may run, so anything older is
 * certainly abandoned rather than in flight.
 */
function sweepMarkers(): void {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000
    for (const name of require("node:fs").readdirSync(TMP)) {
      if (!/^run-[0-9a-f]+\.(out|code)$/.test(name)) continue
      const full = path.join(TMP, name)
      try {
        if (require("node:fs").statSync(full).mtimeMs < cutoff) require("node:fs").unlinkSync(full)
      } catch {}
    }
  } catch {}
}

/**
 * Capabilities a SCHEDULED job declared when it was created, or null when this
 * is an ordinary run with a person present.
 *
 * A scheduled run has nobody to answer an approval, and the two obvious
 * options are both wrong: fail closed and the job never works, or run under a
 * blanket lease and it can do anything at 3am. So the job says up front what
 * it needs, that list is approved once when the job is made, and at run time
 * it is treated as already answered.
 *
 * The list is a ceiling, not a licence. Anything outside it is REFUSED rather
 * than queued for a question no one is awake to hear, so a task cannot grow
 * new powers by drifting into them -- which is the failure that matters when
 * the thing has been running unattended every morning for a month.
 */
const JOB_CAPS: Set<string> | null = (() => {
  const raw = process.env.DESKTOP_AGENT_JOB_CAPS
  if (raw === undefined) return null
  return new Set(raw.split(",").map(c => c.trim()).filter(Boolean))
})()
const JOB_ID = process.env.DESKTOP_AGENT_JOB?.trim() || ""

/**
 * How many approval cards are on screen waiting for a person.
 *
 * Input tools are refused while this is above zero. Not because clicking is
 * dangerous in itself, but because the one thing an approval must mean is that
 * somebody who is not the agent decided -- and an agent with a pointer could
 * click Allow.
 */
let awaitingApproval = 0

/** Tools that could answer an approval card, so they cannot run beside one. */
const INPUT_TOOLS = new Set(["desktop_mouse", "desktop_key", "desktop_type"])

const ROLE = process.env.DESKTOP_AGENT_ROLE?.trim() || "master"
const IS_SUBAGENT = ROLE !== "master"

const MASTER_ONLY: Record<string, string> = {
  // One browser, one debugger connection, one page.
  desktop_browser_open: "the browser belongs to the master",
  desktop_browser_read: "the browser belongs to the master",
  desktop_browser_click: "the browser belongs to the master",
  desktop_browser_type: "the browser belongs to the master",
  desktop_browser_close: "the browser belongs to the master",
  desktop_browser_screenshot: "the browser belongs to the master",

  // One delegator. Depth stays at one by construction.
  desktop_delegate: "only the master delegates",

  // One cursor, one keyboard focus, one active workspace.
  //
  // This is the same argument as the browser and I failed to follow it
  // through. A machine has exactly one pointer and one focused window: two
  // subagents typing at once do not each get a keyboard, they interleave
  // keystrokes into whichever window happened to be focused when each one
  // fired. The result is not a conflict anybody notices -- it is text going
  // into the wrong application, and both agents reporting success.
  //
  // Subagents are for headless work: reading files, running commands,
  // extracting and judging text. Anything that needs the screen itself is the
  // master's, precisely because there is only one of it.
  desktop_mouse: "the pointer belongs to the master — there is only one",
  desktop_type: "typing into windows belongs to the master — there is one keyboard focus",
  desktop_key: "sending keystrokes belongs to the master — there is one keyboard focus",
  desktop_workspace: "switching workspaces belongs to the master — it moves the whole screen",
  desktop_window: "moving and focusing windows belongs to the master",

  // Not flagged by the audit, but it follows from the same rule. A subagent
  // has no mouse, keyboard or window tools, so an app it launches is one it
  // cannot use -- all it can do is leave a window lying around for somebody
  // else to close. Opening things is the master's job because using them is.
  desktop_launch: "opening applications belongs to the master — you have no way to drive one",

  // A subagent exists for the length of one micro-task. Letting it schedule
  // would let a bounded piece of work leave something behind that outlives
  // every part of the system that was supervising it.
  desktop_schedule: "scheduling belongs to the master — you exist for one task",
}

/**
 * Run shell commands in a terminal the person can watch, instead of a pipe.
 *
 * On by default. An agent that changes your machine through invisible pipes
 * gives you no way to see what it is doing while it does it -- only a summary
 * afterwards, which you have to take on trust. A visible terminal is what a
 * person doing the same job would leave behind.
 */
const VISIBLE_RUNS = (() => {
  if (process.env.DESKTOP_AGENT_VISIBLE_RUNS === "false") return false
  try {
    const raw = require("node:fs").readFileSync(
      `${process.env.HOME}/.config/desktop-agent/settings.json`, "utf8")
    return JSON.parse(raw)?.agent?.visibleRuns !== false
  } catch { return true }
})()

/** The bar panel's emergency stop: a file whose existence means "refuse". */
const KILL_FLAG =
  process.env.DESKTOP_AGENT_KILL_FLAG ||
  path.join(os.homedir(), ".local", "state", "desktop-agent", "disabled")

function killSwitchEngaged(): boolean {
  try {
    return existsSync(KILL_FLAG)
  } catch {
    // Unreadable state is not a reason to keep going.
    return true
  }
}

const QS_SHELL = process.env.DESKTOP_AGENT_QS_SHELL || "/usr/share/omarchy/shell"
// The plugin that serves approval prompts. Configurable so a second MCP entry
// can point at a different overlay, but it defaults to THIS plugin -- the
// server, the policy and the overlay ship together and are one thing.
const QS_TARGET = process.env.DESKTOP_AGENT_QS_TARGET?.trim() || "io.github.zedster07.desktop-agent"
const ASK_TIMEOUT_MS = Number(process.env.DESKTOP_AGENT_ASK_TIMEOUT_MS) || 120_000

/**
 * How long the desktop must stay quiet before the run counts as finished and
 * the recap card is pushed to the bar. Set DESKTOP_AGENT_RECAP=off to disable.
 */
const RECAP_IDLE_MS = Number(process.env.DESKTOP_AGENT_RECAP_IDLE_MS) || 20_000
const RECAP_ENABLED = (process.env.DESKTOP_AGENT_RECAP ?? "on").toLowerCase() !== "off"

/**
 * The YOLO lease: a time-boxed grant that promotes "ask" to "allow" so the
 * agent stops interrupting, and that ends on its own.
 *
 * It lives in state, not in the policy file, for one reason: expiry needs no
 * writer. A lapsed lease is just a file whose timestamp is in the past, so
 * there is nothing to crash, nothing to forget to turn off, and no edit left
 * behind in the user's config. If this server dies mid-lease, the lease still
 * expires. If the file is deleted, yolo is off immediately.
 */
const YOLO_PATH =
  process.env.DESKTOP_AGENT_YOLO || path.join(os.homedir(), ".local", "state", "desktop-agent", "yolo.json")

type Action = "allow" | "ask" | "deny"
type WindowVerb = "see" | "focus" | "manage" | "input"
type Capability =
  | "observe"
  | "screenshot"
  | "workspace"
  | "focus"
  | "manage"
  | "launch"
  | "type"
  | "key"
  | "mouse"
  | "run"
  | "write"
  | "browser"
  | "secret"

const RANK: Record<Action, number> = { allow: 0, ask: 1, deny: 2 }
const WINDOW_VERBS: WindowVerb[] = ["see", "focus", "manage", "input"]
const ALL_CAPS: Capability[] = [
  "secret",
  "observe",
  "screenshot",
  "workspace",
  "focus",
  "manage",
  "launch",
  "type",
  "key",
  "mouse",
  "run",
  "write",
  "browser",
]
const ACTIONS = new Set(["allow", "ask", "deny"])

/** Classes whose paste shortcut is Ctrl+Shift+V rather than Ctrl+V. */
const TERMINAL_CLASSES = [
  "foot",
  "footclient",
  "alacritty",
  "kitty",
  "org.wezfurlong.wezterm",
  "com.mitchellh.ghostty",
  "xterm*",
  "*terminal*",
  "wezterm",
]

type LaunchEntry = { command: string[]; args?: boolean; action?: Action }

type Policy = {
  enabled: boolean
  capabilities: Partial<Record<Capability, Action>>
  /** Entries in "capabilities" this build ignores, verbatim, for reporting. */
  capUnknown: string[]
  agents: Record<string, Action | Partial<Record<Capability, Action>>>
  workspaces: Record<string, Action>
  apps: Record<string, Action | Partial<Record<WindowVerb, Action>>>
  launch: Record<string, LaunchEntry>
  forbidKeys: string[]
  protectSelf: boolean
  maxTextLength: number
  screenshot: { maxWidth: number; redactDenied: boolean }
  run: { commands: Record<string, Action>; timeoutMs: number; maxOutputBytes: number; cwd: string }
  paths: Record<string, Action>
  write: { maxBytes: number; backup: boolean }
  browser: { command: string; headless: boolean }
  yolo: { enabled: boolean; maxMinutes: number }
  audit: boolean
}

/** Permits nothing. Used when the policy file is missing or unparseable. */
const CLOSED: Policy = {
  enabled: false,
  capabilities: {},
  capUnknown: [],
  agents: {},
  workspaces: {},
  apps: {},
  launch: {},
  forbidKeys: ["*"],
  protectSelf: true,
  maxTextLength: 0,
  screenshot: { maxWidth: 1920, redactDenied: true },
  run: { commands: {}, timeoutMs: 0, maxOutputBytes: 0, cwd: "" },
  paths: {},
  write: { maxBytes: 0, backup: true },
  browser: { command: "", headless: false },
  yolo: { enabled: false, maxMinutes: 0 },
  audit: true,
}

// ------------------------------------------------------------------- helpers

/** Strip // and block comments plus trailing commas, leaving valid JSON. */
function stripJsonc(src: string): string {
  let out = ""
  let inStr = false
  let quote = ""
  let esc = false
  let inLine = false
  let inBlock = false

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    const n = src[i + 1]

    if (inLine) {
      if (c === "\n") {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === "*" && n === "/") {
        inBlock = false
        i++
      }
      continue
    }
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === "\\") esc = true
      else if (c === quote) inStr = false
      continue
    }
    if (c === '"' || c === "'") {
      inStr = true
      quote = c
      out += c
      continue
    }
    if (c === "/" && n === "/") {
      inLine = true
      i++
      continue
    }
    if (c === "/" && n === "*") {
      inBlock = true
      i++
      continue
    }
    out += c
  }

  return out.replace(/,(\s*[}\]])/g, "$1")
}

/** Glob -> anchored, case-insensitive RegExp. Supports * and ?. */
const reCache = new Map<string, RegExp>()
function glob(pattern: string): RegExp {
  const cached = reCache.get(pattern)
  if (cached) return cached
  let body = ""
  for (const ch of pattern) {
    if (ch === "*") body += ".*"
    else if (ch === "?") body += "."
    else body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }
  const re = new RegExp(`^${body}$`, "i")
  reCache.set(pattern, re)
  return re
}

const matchesAny = (patterns: string[], subject: string) => patterns.some((p) => glob(p).test(subject))

/** "~/x" -> "/home/you/x". Everything else is left exactly as written. */
function expandHome(p: string): string {
  if (p === "~") return os.homedir()
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2))
  return p
}

/**
 * Turn whatever path the agent passed into the single absolute string the
 * rules are matched against.
 *
 * The symlink walk is the whole point. Without it, "~/Work/notes" could be a
 * link into ~/.config/desktop-agent and a rule denying the policy directory
 * would never fire -- the string would not look like the thing it opens. We
 * resolve the deepest ancestor that actually exists and rejoin the rest,
 * because the file being written usually does not exist yet.
 */
async function realPath(input: string): Promise<string> {
  const abs = path.resolve(expandHome((input ?? "").trim()))
  const tail: string[] = []
  let dir = abs
  for (;;) {
    try {
      const real = await fs.realpath(dir)
      return path.join(real, ...tail.reverse())
    } catch {
      const parent = path.dirname(dir)
      if (parent === dir) return abs
      tail.push(path.basename(dir))
      dir = parent
    }
  }
}

/** Escape a JS string for embedding in a Lua string literal. */
function luaStr(s: string): string {
  return `"${s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\0/g, "")}"`
}

/** Most restrictive of several actions. A missing rule counts as deny. */
function strictest(...candidates: Array<Action | undefined>): Action {
  let worst: Action = "allow"
  for (const c of candidates) {
    const a: Action = c ?? "deny"
    if (RANK[a] > RANK[worst]) worst = a
  }
  return worst
}

/** Last matching rule wins. Returns the action and the pattern that won. */
function evaluate(rules: Record<string, Action>, subjects: string[]): { action?: Action; rule?: string } {
  let hit: { action?: Action; rule?: string } = {}
  for (const [pattern, action] of Object.entries(rules ?? {})) {
    if (!ACTIONS.has(action)) continue
    const re = glob(pattern)
    if (subjects.some((s) => re.test(s))) hit = { action, rule: pattern }
  }
  return hit
}

function coerceAction(v: unknown, fallback?: Action): Action | undefined {
  return typeof v === "string" && ACTIONS.has(v) ? (v as Action) : fallback
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** stdout is the MCP wire; anything human-readable goes to stderr. */
const note = (msg: string) => process.stderr.write(`desktop-agent: ${msg}\n`)

// ------------------------------------------------------------- policy loader

let cache: { key: string; policy: Policy; error?: string } | null = null

async function loadPolicy(): Promise<{ policy: Policy; error?: string }> {
  const file = policyPath()
  let stat: Awaited<ReturnType<typeof fs.stat>>
  try {
    stat = await fs.stat(file)
  } catch {
    cache = null
    return {
      policy: CLOSED,
      error: `policy file not found at ${file} — refusing everything until it exists`,
    }
  }

  // Keyed on path as well as mtime/size, so redirecting the policy cannot hit
  // a stale entry belonging to a different file.
  const key = `${file}:${stat.mtimeMs}:${stat.size}`
  if (cache?.key === key) return { policy: cache.policy, error: cache.error }

  let raw: string
  try {
    raw = await fs.readFile(file, "utf8")
  } catch (e) {
    return { policy: CLOSED, error: `cannot read ${file}: ${e}` }
  }

  let parsed: any
  try {
    parsed = JSON.parse(stripJsonc(raw))
  } catch (e) {
    const error = `policy file is not valid JSONC (${
      e instanceof Error ? e.message : e
    }) — refusing everything until it parses`
    cache = { key, policy: CLOSED, error }
    return { policy: CLOSED, error }
  }

  // Normalise defensively: a single typo should degrade one rule, not brick
  // the whole tool surface. Anything absent still defaults to deny.
  const apps: Policy["apps"] = {}
  for (const [pattern, value] of Object.entries(parsed.apps ?? {})) {
    if (typeof value === "string") {
      const a = coerceAction(value)
      if (a) apps[pattern] = a
    } else if (value && typeof value === "object") {
      const obj: Partial<Record<WindowVerb, Action>> = {}
      for (const verb of WINDOW_VERBS) {
        const a = coerceAction((value as any)[verb])
        if (a) obj[verb] = a
      }
      apps[pattern] = obj
    }
  }

  const workspaces: Record<string, Action> = {}
  for (const [pattern, value] of Object.entries(parsed.workspaces ?? {})) {
    const a = coerceAction(value)
    if (a) workspaces[pattern] = a
  }

  // Anything in "capabilities" that this build will never consult.
  //
  // Both halves used to vanish without a word: a key nobody recognises
  // ("mose": "allow") and a value nobody recognises ("mouse": "allowed") were
  // each dropped by the loop below, leaving the real capability at its default
  // and nothing anywhere saying so. You edit the file, it saves, it is valid
  // JSON, no error appears -- and you conclude you granted something. Twice in
  // one session that cost somebody a whole round of debugging.
  //
  // Not fatal: refusing to load over a typo would take the desktop down for a
  // misspelling. Loud instead -- desktop_policy names them, and so does doctor.
  const capUnknown: string[] = []
  const capabilities: Policy["capabilities"] = {}
  for (const [k, v] of Object.entries(parsed.capabilities ?? {})) {
    const a = coerceAction(v)
    if (!ALL_CAPS.includes(k as Capability)) {
      capUnknown.push(`"${k}": not a capability this build knows`)
      continue
    }
    if (!a) {
      capUnknown.push(`"${k}": ${JSON.stringify(v)} is not "allow", "ask" or "deny"`)
      continue
    }
    ;(capabilities as any)[k] = a
  }

  // Per-identity limits. See the CAVEAT in the policy file: MCP cannot tell
  // subagents apart, so this keys on DESKTOP_AGENT_IDENTITY, not the subagent.
  const agents: Policy["agents"] = {}
  for (const [pattern, value] of Object.entries(parsed.agents ?? {})) {
    if (typeof value === "string") {
      const a = coerceAction(value)
      if (a) agents[pattern] = a
    } else if (value && typeof value === "object") {
      const obj: Partial<Record<Capability, Action>> = {}
      for (const cap of ALL_CAPS) {
        const a = coerceAction((value as any)[cap])
        if (a) obj[cap] = a
      }
      const star = coerceAction((value as any)["*"])
      if (star) for (const cap of ALL_CAPS) if (obj[cap] === undefined) obj[cap] = star
      agents[pattern] = obj
    }
  }

  const launch: Record<string, LaunchEntry> = {}
  for (const [name, value] of Object.entries(parsed.launch ?? {})) {
    if (typeof value === "string") launch[name] = { command: [value] }
    else if (Array.isArray(value)) launch[name] = { command: value.map(String) }
    else if (value && typeof value === "object") {
      const v = value as any
      const cmd = Array.isArray(v.command) ? v.command.map(String) : typeof v.command === "string" ? [v.command] : []
      if (cmd.length) launch[name] = { command: cmd, args: v.args === true, action: coerceAction(v.action) }
    }
  }

  // Command rules for desktop_run. Same last-match-wins globbing as the rest.
  const runCommands: Record<string, Action> = {}
  for (const [pattern, value] of Object.entries(parsed.run?.commands ?? {})) {
    const a = coerceAction(value)
    if (a) runCommands[pattern] = a
  }

  // Same shape as "workspaces": a flat pattern -> action map, last match wins.
  // An absent section means nothing matches, which means deny -- an install
  // that never heard of "paths" cannot write, rather than writing anywhere.
  const paths: Record<string, Action> = {}
  for (const [pattern, value] of Object.entries(parsed.paths ?? {})) {
    const a = coerceAction(value)
    if (a) paths[expandHome(pattern)] = a
  }

  const policy: Policy = {
    // Two ways to be off, and either is enough.
    //
    // `enabled: false` in the policy is the file-level switch. The flag file is
    // what the bar panel writes, because rewriting a JSONC file to flip one
    // boolean means a regex over a document full of comments -- which silently
    // flipped the WRONG key when "enabled": true appeared in a nested section
    // first. A flag file cannot mis-target and needs nothing running to hold.
    enabled: parsed.enabled !== false && !killSwitchEngaged(),
    capabilities,
    capUnknown,
    agents,
    workspaces,
    apps,
    launch,
    forbidKeys: Array.isArray(parsed.forbidKeys) ? parsed.forbidKeys.map(String) : [],
    protectSelf: parsed.protectSelf !== false,
    maxTextLength: Number.isFinite(parsed.maxTextLength) ? Number(parsed.maxTextLength) : 4000,
    screenshot: {
      maxWidth: Number.isFinite(parsed.screenshot?.maxWidth) ? Number(parsed.screenshot.maxWidth) : 1920,
      redactDenied: parsed.screenshot?.redactDenied !== false,
    },
    run: {
      commands: runCommands,
      timeoutMs: Number.isFinite(parsed.run?.timeoutMs) ? Number(parsed.run.timeoutMs) : 15_000,
      maxOutputBytes: Number.isFinite(parsed.run?.maxOutputBytes) ? Number(parsed.run.maxOutputBytes) : 100_000,
      cwd: typeof parsed.run?.cwd === "string" ? parsed.run.cwd : "",
    },
    paths,
    write: {
      maxBytes: Number.isFinite(parsed.write?.maxBytes) ? Math.max(0, Number(parsed.write.maxBytes)) : 1_000_000,
      backup: parsed.write?.backup !== false,
    },
    browser: {
      command: typeof parsed.browser?.command === "string" ? parsed.browser.command : "",
      headless: parsed.browser?.headless === true,
    },
    // Opt-in, unlike everything else here which defaults to "ask". An absent
    // "yolo" section means no lease can ever take effect.
    yolo: {
      enabled: parsed.yolo?.enabled === true,
      maxMinutes: Number.isFinite(parsed.yolo?.maxMinutes) ? Math.max(0, Number(parsed.yolo.maxMinutes)) : 60,
    },
    audit: parsed.audit !== false,
  }

  cache = { key, policy }
  return { policy }
}

// ----------------------------------------------------------- self-protection

let selfPidCache: { at: number; pids: Set<number> } | null = null

/** This server's PID plus every ancestor -- i.e. Claude Code and its terminal. */
async function selfPids(): Promise<Set<number>> {
  if (selfPidCache && Date.now() - selfPidCache.at < 30_000) return selfPidCache.pids
  const pids = new Set<number>()
  let pid = process.pid
  for (let i = 0; i < 64 && pid > 1; i++) {
    pids.add(pid)
    let stat: string
    try {
      stat = await fs.readFile(`/proc/${pid}/stat`, "utf8")
    } catch {
      break
    }
    // "pid (comm may contain spaces and parens) state ppid ..."
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const ppid = Number(tail[1])
    if (!Number.isFinite(ppid) || ppid <= 1) break
    pid = ppid
  }
  selfPidCache = { at: Date.now(), pids }
  return pids
}

// --------------------------------------------------------------------- types

type Win = {
  address: string
  pid: number
  class: string
  initialClass: string
  title: string
  initialTitle: string
  workspace: { id: number; name: string }
  at: [number, number]
  size: [number, number]
  floating: boolean
  fullscreen: number
  hidden: boolean
  mapped: boolean
  monitor: number
  focusHistoryID: number
  pinned: boolean
  xwayland: boolean
}

type Mon = {
  id: number
  name: string
  x: number
  y: number
  width: number
  height: number
  scale: number
  focused: boolean
  activeWorkspace: { id: number; name: string }
}

// ------------------------------------------------------------------- runtime

const sh = $.nothrow()

async function hyprJson<T>(what: string): Promise<T> {
  const r = await sh`hyprctl -j ${what}`.quiet()
  if (r.exitCode !== 0) throw new Error(`hyprctl -j ${what} failed: ${r.stderr.toString().trim()}`)
  return JSON.parse(r.stdout.toString()) as T
}

/** Run a Lua dispatcher expression; throw on any Hyprland-side error. */
async function dispatch(expr: string): Promise<string> {
  const r = await sh`hyprctl dispatch ${expr}`.quiet()
  const out = `${r.stdout.toString()}${r.stderr.toString()}`.trim()
  if (r.exitCode !== 0 || /^error:/im.test(out)) {
    throw new Error(`hyprland refused: ${out || `exit ${r.exitCode}`}`)
  }
  return out
}

const windows = () => hyprJson<Win[]>("clients")
const monitors = () => hyprJson<Mon[]>("monitors")
const cursorPos = async () => {
  const r = await sh`hyprctl cursorpos`.quiet()
  const [x, y] = r.stdout
    .toString()
    .trim()
    .split(",")
    .map((s) => Number(s.trim()))
  return { x: x || 0, y: y || 0 }
}

async function audit(policy: Policy, line: string) {
  if (!policy.audit) return
  try {
    await fs.mkdir(path.dirname(AUDIT_PATH), { recursive: true })
    await fs.appendFile(AUDIT_PATH, `${new Date().toISOString()} ${line}\n`)
  } catch {
    /* auditing must never block or fail an action */
  }
}

// --------------------------------------------------------- decision engine

type Decision = { action: Action; reasons: string[]; subject: string }

/** Thrown when the policy says no. Carries a fully-explained message. */
class Refused extends Error {}

const windowSubjects = (w: Win) => [
  `class:${w.class}`,
  `initialclass:${w.initialClass ?? ""}`,
  `title:${w.title}`,
  `initialtitle:${w.initialTitle ?? ""}`,
  `pid:${w.pid}`,
  w.class,
  w.title,
]

const workspaceSubjects = (ws: { id: number; name: string }) => [ws.name, `id:${ws.id}`, `name:${ws.name}`]

/**
 * Which identity is asking. Absent or empty "agents" means no constraint;
 * once the section is used at all it behaves as an allowlist.
 */
function agentAction(policy: Policy, agent: string, cap: Capability): { action?: Action; note: string } {
  if (!Object.keys(policy.agents).length) {
    return { action: "allow", note: `identity "${agent}" -> allow (no "agents" section, so no per-identity limit)` }
  }
  let action: Action | undefined
  let rule: string | undefined
  let wasObject = false
  for (const [pattern, value] of Object.entries(policy.agents)) {
    if (!glob(pattern).test(agent)) continue
    rule = pattern
    wasObject = typeof value !== "string"
    action = typeof value === "string" ? value : (value[cap] ?? "deny")
  }
  return {
    action,
    note: rule
      ? `identity "${agent}" -> ${action} (agents["${rule}"]${wasObject ? `.${cap}` : ""})`
      : `identity "${agent}" -> deny (nothing in "agents" matched)`,
  }
}

/** Resolve one verb against one window, explaining every dimension. */
async function decideWindow(policy: Policy, cap: Capability, verb: WindowVerb, w: Win): Promise<Decision> {
  const subject = `${w.class} — "${w.title}" [${w.address} ws=${w.workspace.name}]`
  if (!policy.enabled) {
    return { action: "deny", reasons: ['policy "enabled" is false — desktop control is switched off'], subject }
  }
  if (policy.protectSelf && (await selfPids()).has(w.pid)) {
    return {
      action: "deny",
      reasons: [`this is the terminal the agent itself runs in (pid ${w.pid}) — blocked by "protectSelf"`],
      subject,
    }
  }

  const reasons: string[] = []
  const ag = agentAction(policy, IDENTITY, cap)
  reasons.push(ag.note)

  const capAction = coerceAction(policy.capabilities[cap], "ask")
  reasons.push(`capability "${cap}" -> ${capAction} (capabilities.${cap})`)

  const ws = evaluate(policy.workspaces, workspaceSubjects(w.workspace))
  reasons.push(
    ws.action
      ? `workspace "${w.workspace.name}" -> ${ws.action} (workspaces["${ws.rule}"])`
      : `workspace "${w.workspace.name}" -> deny (nothing in "workspaces" matched)`,
  )

  let appAction: Action | undefined
  let appRule: string | undefined
  let appWasObject = false
  const subjects = windowSubjects(w)
  for (const [pattern, value] of Object.entries(policy.apps)) {
    const re = glob(pattern)
    if (!subjects.some((s) => re.test(s))) continue
    appRule = pattern
    appWasObject = typeof value !== "string"
    // An object that omits this verb denies it.
    appAction = typeof value === "string" ? value : (value[verb] ?? "deny")
  }
  reasons.push(
    appRule
      ? `app "${verb}" -> ${appAction} (apps["${appRule}"]${appWasObject ? `.${verb}` : ""})`
      : `app "${verb}" -> deny (nothing in "apps" matched)`,
  )

  return { action: strictest(ag.action, capAction, ws.action, appAction), reasons, subject }
}

/** Resolve a capability that has no particular window target. */
function decideGlobal(policy: Policy, cap: Capability, subject: string): Decision {
  if (!policy.enabled) {
    return { action: "deny", reasons: ['policy "enabled" is false — desktop control is switched off'], subject }
  }
  const ag = agentAction(policy, IDENTITY, cap)
  const capAction = coerceAction(policy.capabilities[cap], "ask")!
  return {
    action: strictest(ag.action, capAction),
    reasons: [ag.note, `capability "${cap}" -> ${capAction} (capabilities.${cap})`],
    subject,
  }
}

/** Add a workspace check to an existing decision (for destinations). */
function withWorkspace(policy: Policy, d: Decision, ws: string): Decision {
  const hit = evaluate(policy.workspaces, [ws, `name:${ws}`])
  return {
    action: strictest(d.action, hit.action),
    subject: d.subject,
    reasons: [
      ...d.reasons,
      hit.action
        ? `destination workspace "${ws}" -> ${hit.action} (workspaces["${hit.rule}"])`
        : `destination workspace "${ws}" -> deny (nothing in "workspaces" matched)`,
    ],
  }
}

function refusal(what: string, d: Decision, policyError?: string): string {
  return [
    `REFUSED: ${what} on ${d.subject}`,
    ...d.reasons.map((r) => `  ${r}`),
    `  => effective: ${d.action}`,
    "",
    policyError
      ? `Policy problem: ${policyError}`
      : `The user can change this in ${policyPath()} — it takes effect on the next call, no restart needed.`,
  ].join("\n")
}

/**
 * Paths YOLO will not promote, however long the lease has left.
 *
 * Same reasoning as NEVER_YOLO for commands, and the same escape hatch: this is
 * not a denylist. Name a path under "paths" with "allow" and it is allowed,
 * because you named it. What this stops is the leash quietly becoming writable
 * because a timer happens to be running -- the agent's own prompt, its own
 * policy, its own lease -- and the system files that make the desktop boot.
 */
const NEVER_YOLO_PATHS: string[] = [
  // The leash. An agent that can edit these is not restricted by them.
  "*/.config/desktop-agent/*",
  "*/.claude/*",
  "*/.local/state/desktop-agent/*",
  // Secrets. Reading them is already possible; writing them is how you get a
  // trojanned key or a rewritten known_hosts.
  "*/.ssh/*", "*/.gnupg/*", "*/.aws/*", "*/.docker/config.json",
  "*.env", "*/.env.*", "*/.netrc", "*/.git-credentials", "*/.pgpass", "*/.npmrc",
  // Anything that runs automatically the next time you open a shell or log in.
  "*/.bashrc", "*/.zshrc", "*/.profile", "*/.bash_profile", "*/.zprofile",
  "*/.config/autostart/*", "*/.config/systemd/*", "*/.local/share/systemd/*",
  "*/.config/environment.d/*",
  // Break these and the desktop stops coming up.
  "*/.config/hypr/*", "*/.config/omarchy/*", "*/.config/uwsm/*",
  // Not the user's to edit in the first place.
  "/etc/*", "/usr/*", "/boot/*", "/bin/*", "/sbin/*", "/lib/*", "/lib64/*",
  "/var/*", "/opt/*", "/sys/*", "/proc/*", "/dev/*", "/run/*",
  // Git internals: rewriting hooks or config is code execution on next commit.
  "*/.git/*",
]

const neverYoloPath = (abs: string) => matchesAny(NEVER_YOLO_PATHS, abs)

/** Resolve a write verb against one absolute path, explaining every dimension. */
function decidePath(policy: Policy, cap: Capability, abs: string): Decision {
  if (!policy.enabled) {
    return { action: "deny", reasons: ['policy "enabled" is false \u2014 desktop control is switched off'], subject: abs }
  }
  const ag = agentAction(policy, IDENTITY, cap)
  const capAction = coerceAction(policy.capabilities[cap], "ask")
  const hit = evaluate(policy.paths, [abs])
  return {
    action: strictest(ag.action, capAction, hit.action),
    subject: abs,
    reasons: [
      ag.note,
      `capability "${cap}" -> ${capAction} (capabilities.${cap})`,
      hit.action
        ? `path -> ${hit.action} (paths["${hit.rule}"])`
        : 'path -> deny (nothing in "paths" matched)',
    ],
  }
}

const BACKUP_DIR = path.join(os.homedir(), ".local", "state", "desktop-agent", "backups")

/**
 * Copy a file aside before it is overwritten or edited.
 *
 * Backups live in state rather than beside the original, so an agent working
 * through a directory does not leave a trail of .bak files the user has to
 * clean up afterwards. Returns the backup path, or undefined -- callers report
 * what actually happened, so "backed up" is never printed when nothing was.
 */
async function backupFile(policy: Policy, abs: string): Promise<string | undefined> {
  if (!policy.write.backup) return undefined
  try {
    await fs.mkdir(BACKUP_DIR, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, "-")
    const flat = abs.replace(/[/\\]/g, "%").slice(-160)
    const dest = path.join(BACKUP_DIR, `${stamp}${flat}`)
    await fs.copyFile(abs, dest)
    return dest
  } catch {
    return undefined
  }
}

// ----------------------------------------------------------------- yolo lease

/**
 * Commands YOLO will not promote, however long the lease has left.
 *
 * This is deliberately NOT a denylist. If the user writes "rm": "allow" in
 * their policy, that is their machine and it runs -- they named it. What this
 * blocks is a command becoming allowed *by default*, silently, because a timer
 * happens to be running. Everything here still raises the approval overlay
 * during yolo, so the irreversible step stays the one thing a human sees.
 *
 * It also closes the obvious loop. Every command that could rewrite the lease
 * file -- tee, dd, cp, mv, install, truncate, sed -- is in here, so a yolo
 * session cannot quietly extend its own yolo session.
 */
/**
 * This plugin's own controls. Never runnable through desktop_run, whatever the
 * policy says -- see the refusal in desktop_run for why this is not a policy
 * rule. "desktop-agent remind" is unaffected: the voice route spawns it
 * directly and never passes through this tool.
 */
const SELF_CONTROL = new Set(["desktop-agent", "desktop-agent-config", "desktop-yolo", "desktop-agent-arm"])

const NEVER_YOLO: string[] = [
  // Destroy or overwrite what is already on disk.
  "rm", "rmdir", "unlink", "shred", "srm", "wipe", "trash", "trash-put", "gio",
  "dd", "truncate", "tee", "sponge", "mv", "cp", "install", "ln", "sed", "rsync",
  // Repartition, reformat, remount.
  "mkfs", "mkfs.*", "mke2fs", "mkswap", "fdisk", "sfdisk", "cfdisk", "parted",
  "gparted", "wipefs", "blkdiscard", "cryptsetup", "mount", "umount", "losetup",
  "swapon", "swapoff",
  // End the session or the machine.
  "shutdown", "reboot", "poweroff", "halt", "init", "telinit",
  "systemctl", "loginctl", "systemd-run",
  // Kill somebody else's process.
  "kill", "pkill", "killall", "xkill",
  // Change who may read what.
  "chmod", "chown", "chgrp", "chattr", "setfacl",
  "passwd", "chpasswd", "useradd", "userdel", "usermod", "groupadd", "groupdel",
  // Install code that then runs unsupervised, long after the lease is over.
  "pacman", "yay", "paru", "apt", "apt-get", "dnf", "rpm", "flatpak", "snap",
  "pip", "pip3", "npm", "pnpm", "yarn", "cargo", "gem", "go", "make",
  // Reach the network: fetch-then-run inbound, exfiltration outbound.
  "curl", "wget", "nc", "ncat", "socat", "ftp", "scp", "sftp",
  // Outlive the lease -- including the lease's own control, so a yolo session
  // can never buy itself more yolo.
  "crontab", "at", "batch", "desktop-yolo",
  // This plugin's own controls. desktop_run refuses these outright; they are
  // here too so no other path can auto-approve one under a lease.
  "desktop-agent", "desktop-agent-*",
  // The omarchy router reaches shutdown, factory reset, package installs and
  // the shell's own IPC through arguments this list cannot see. It stays on the
  // overlay under a lease so the subcommand is read by a human.
  "omarchy", "omarchy-*",
  // Firewall.
  "iptables", "ip6tables", "nft", "firewall-cmd", "ufw",
]

/**
 * Tools that only WRITE when asked to, and otherwise just read.
 *
 * The list above matches on the program name, so `sed -i` -- which rewrites a
 * file in place -- and `sed -n '480,515p'` -- which prints thirty-five lines --
 * were treated as equally destructive. A research task that reads PDFs and
 * slices text uses these constantly, so someone on full access got asked over
 * and over for commands that could not change anything.
 *
 * The predicate answers "does THIS invocation write?", and defaults to yes.
 * An unrecognised flag, a flag bundle that might hide -i, an argument that
 * cannot be parsed: all of those fall through to destructive. Being wrong in
 * the direction of asking costs a keystroke; being wrong the other way
 * overwrites a file nobody approved.
 */
const CONDITIONAL: Record<string, (argv: string[]) => boolean> = {
  // -i/--in-place is the only way sed touches a file.
  sed: argv => argv.some(a => a === "--in-place" || /^--in-place=/.test(a) ||
                              (/^-[a-zA-Z]*i/.test(a) && !a.startsWith("--"))),
  // curl and wget write only when told where to put it.
  curl: argv => argv.some(a => ["-o", "-O", "--output", "--remote-name",
                                "--output-dir", "--create-dirs"].includes(a) ||
                               /^--output=/.test(a) || /^-[a-zA-Z]*[oO]/.test(a)),
  wget: argv => argv.some(a => !a.startsWith("-") ? false
                             : ["-O", "--output-document", "-P", "--directory-prefix"].includes(a) ||
                               /^--output-document=/.test(a)),
}

/**
 * Is this command one the lease must never promote?
 *
 * `argv` is the whole invocation, not just the program, so a tool that can go
 * either way is judged by what it was actually asked to do.
 */
const neverYolo = (base: string, argv: string[] = []) => {
  const conditional = CONDITIONAL[base]
  if (conditional) {
    try { return conditional(argv) } catch { return true }
  }
  return matchesAny(NEVER_YOLO, base)
}

type Yolo = { active: boolean; until: number; remainingMs: number; why?: string }
const YOLO_OFF: Yolo = { active: false, until: 0, remainingMs: 0 }

/**
 * Read the lease. Every failure mode -- absent, unparseable, expired, stamped
 * in the future, longer than the policy's ceiling -- returns inactive. The
 * only way to be in yolo is for a well-formed, unexpired lease to exist at
 * this instant.
 */
async function yoloState(policy: Policy): Promise<Yolo> {
  if (!policy.enabled) return { ...YOLO_OFF, why: "the kill switch is on" }
  if (!policy.yolo.enabled) return { ...YOLO_OFF, why: 'policy "yolo.enabled" is not true' }

  let parsed: any
  try {
    parsed = JSON.parse(await fs.readFile(YOLO_PATH, "utf8"))
  } catch {
    return YOLO_OFF
  }

  const until = Number(parsed?.until)
  const grantedAt = Number(parsed?.grantedAt)
  if (!Number.isFinite(until) || !Number.isFinite(grantedAt)) return YOLO_OFF

  const now = Date.now()
  // A lease stamped in the future is a clock change or a forgery, not a grant.
  if (grantedAt > now + 60_000) return { ...YOLO_OFF, why: "the lease is stamped in the future" }

  // The ceiling is re-derived from grantedAt on every read, not trusted from
  // when it was written. So a hand-edited "until" years out is still capped by
  // the policy, and no lease can outlive the window the user actually saw.
  const effective = Math.min(until, grantedAt + policy.yolo.maxMinutes * 60_000)
  if (now >= effective) return YOLO_OFF

  return { active: true, until: effective, remainingMs: effective - now }
}

const minutesLeft = (ms: number) => Math.max(1, Math.ceil(ms / 60_000))

// ------------------------------------------------------------ approval bridge

/**
 * Call one function on the Omarchy bar plugin over Quickshell IPC. Returns
 * ok:false when the shell or the plugin is not there, which the caller must
 * treat as "cannot ask" -- and therefore as a refusal.
 */
async function qsIpc(fn: string, ...args: string[]): Promise<{ ok: boolean; out: string }> {
  const r = await sh`qs -p ${QS_SHELL} ipc call ${QS_TARGET} ${fn} ${args}`.quiet()
  const out = r.stdout.toString().trim()
  // qs reports a missing target on STDOUT and still exits 0, so the exit code
  // alone would read "Target not found." as a successful reply -- and, for a
  // request, as a request id that can never resolve.
  const failed = /^(target not found|no such|function .* not found|error)/i.test(out)
  return { ok: r.exitCode === 0 && !failed, out: failed ? "" : out }
}

type Verdict = "allow" | "always" | "deny" | "timeout" | "unavailable"

/** Queue an approval on the bar overlay and wait for the user to answer it. */
async function askOverlay(req: {
  tool: string
  capability: string
  scope: string
  target: string
  reasons: string[]
}): Promise<Verdict> {
  // One retry: saving any file in the plugin directory makes Quickshell reload
  // it, and an approval must not be refused because it landed in that window.
  const payload = JSON.stringify(req)
  let started = await qsIpc("request", payload)
  if (!started.ok || !/^req-\d+$/.test(started.out)) {
    await sleep(750)
    started = await qsIpc("request", payload)
  }
  if (!started.ok || !/^req-\d+$/.test(started.out)) return "unavailable"
  const id = started.out

  const deadline = Date.now() + ASK_TIMEOUT_MS
  try {
    while (Date.now() < deadline) {
      await sleep(250)
      const v = await qsIpc("verdict", id)
      if (!v.ok) return "unavailable"
      if (v.out === "allow" || v.out === "always" || v.out === "deny") return v.out
      if (v.out === "gone") return "unavailable"
    }
    return "timeout"
  } finally {
    await qsIpc("cancel", id).catch(() => {})
  }
}

// ------------------------------------------------------------ run journal

/**
 * What the agent did since the desktop last went quiet. A "run" is not a
 * concept MCP gives us -- there is no end-of-task signal -- so it is inferred:
 * the run ends once no tool has been called for RECAP_IDLE_MS.
 */
type Note = { text: string; tone: "ok" | "warn" | "bad" }
type Entry = Note & { order: number }

let journal: Entry[] = []
let callSeq = 0
let runStartedAt = 0
let recapTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Per-call scratch space. AsyncLocalStorage rather than a module-level
 * variable so two overlapping tool calls cannot write into each other's entry.
 */
const callCtx = new AsyncLocalStorage<{ tool: string; seq: number; approvals: string[] }>()

function noteApproval(text: string) {
  callCtx.getStore()?.approvals.push(text)
}

/**
 * `order` keeps the card in the order the agent *started* things, not the
 * order they happened to finish -- concurrent calls complete out of sequence
 * and a recap that reorders the story is worse than no recap.
 */
function record(note: Note, order: number) {
  if (!RECAP_ENABLED) return
  if (!journal.length) runStartedAt = Date.now()
  journal.push({ ...note, order })
}

/** Push the recap to the bar and start a fresh run. */
async function flushRecap() {
  recapTimer = null
  const notes = journal.slice().sort((a, b) => a.order - b.order)
  journal = []
  if (!notes.length) return

  const payload = {
    startedAt: runStartedAt,
    endedAt: Date.now(),
    counts: {
      actions: notes.length,
      approvals: notes.filter((n) => n.tone === "warn").length,
      problems: notes.filter((n) => n.tone === "bad").length,
    },
    lines: notes.map(({ text, tone }) => ({ text, tone })),
  }

  const r = await qsIpc("recap", JSON.stringify(payload))
  if (!r.ok) note("recap could not be shown — the bar plugin is unreachable")
}

function armRecap() {
  if (!RECAP_ENABLED) return
  if (recapTimer) clearTimeout(recapTimer)
  recapTimer = setTimeout(() => void flushRecap(), RECAP_IDLE_MS)
  // The timer must not hold the process open once Claude Code closes stdio.
  recapTimer.unref?.()
}

/** Scopes the user answered "always" to, for the life of this server process. */
const sessionAlways = new Set<string>()

/**
 * Permit, prompt, or refuse. Returns normally when the action may proceed;
 * throws a fully-explained Refused when it may not.
 */
async function gate(
  toolName: string,
  cap: Capability,
  d: Decision,
  policyError: string | undefined,
  scope: string,
  noYolo?: string,
  // Refused in a SCHEDULED job, but a lease may still promote it.
  //
  // Split out of noYolo, which used to mean both at once. That conflation is
  // what made "full access" stop at a login box: a lease is something you
  // granted by hand, at the keyboard, for the next hour -- the opposite of
  // unattended -- and treating it like a 3am cron run made the switch not mean
  // what it says. Nobody being there is the thing worth refusing for, and that
  // is the job case, which this still covers.
  unattended?: string,
) {
  if (d.action === "deny") throw new Refused(refusal(toolName, d, policyError))

  if (JOB_CAPS) {
    // Outside what the job declared: refused, and told to say so rather than
    // wait. The person will read the result in the morning; a job that hangs
    // until its idle watchdog kills it tells them nothing.
    if (!JOB_CAPS.has(cap)) {
      // Audited before throwing. A refusal during a scheduled run is the one
      // nobody saw happen, so it is the one most worth being able to look up:
      // "why did the 7am job not do the thing" has no other answer.
      await audit((await loadPolicy()).policy,
        `job ${JOB_ID}: REFUSED ${toolName} (${cap}) — not in its declared capabilities`)
      throw new Refused(
        `REFUSED: this scheduled job may only ${[...JOB_CAPS].join(", ") || "(nothing)"}, and "${cap}" is not on that list.\n` +
        `  Nobody is watching, so this cannot be approved now. Finish what you can and say in your report\n` +
        `  that the job needs "${cap}" — its capabilities can be changed by recreating it.`)
    }
    // The floor, said plainly. An irreversible command is never pre-approved,
    // and previously it fell through to the approval overlay -- which cannot
    // answer at 3am, so the agent was told "the Omarchy bar plugin is not
    // loaded". That reads as a broken UI and invites retrying, when the truth
    // is a rule it will never get past.
    const blocked = noYolo ?? unattended
    if (d.action === "ask" && blocked) {
      await audit((await loadPolicy()).policy,
        `job ${JOB_ID}: REFUSED ${toolName} — ${blocked}, and unattended runs cannot be asked`)
      throw new Refused(
        `REFUSED: ${blocked}. A scheduled job runs with nobody watching, so this can never be\n` +
        `  approved at the time. It is not a fault and retrying will not help — say in your report\n` +
        `  that this step needs a person.`)
    }

    // On the list, so it was approved when the job was created.
    if (d.action === "ask" && !blocked) {
      await audit((await loadPolicy()).policy, `job ${JOB_ID}: ${toolName} (${cap}) -- pre-approved when the job was created`)
      return
    }
  }
  if (d.action !== "ask") return

  const key = `${toolName}\u0000${scope}`
  if (sessionAlways.has(key)) return

  // YOLO promotes "ask" to "allow" and does nothing else. A "deny" from any
  // dimension has already thrown above, so no lease can reach a password
  // manager, a terminal's keyboard, a scratchpad workspace, or Claude Code's
  // own window -- those stay refused for exactly the reasons they always were.
  // The lease removes the interruption, never the boundary.
  {
    const { policy } = await loadPolicy()
    const y = await yoloState(policy)
    if (y.active) {
      if (!noYolo) {
        const left = minutesLeft(y.remainingMs)
        noteApproval(`YOLO auto-approved ${scope} — ${left} min left`)
        await audit(policy, `yolo ${toolName} ${scope} -> auto-approved (${left} min left)`)
        return
      }
      // Still asking despite the lease. Say so on the overlay, otherwise the
      // prompt looks like the lease is broken rather than doing its job.
      d.reasons.push(`YOLO is on, but ${noYolo} — asking anyway`)
    }
  }

    // The agent must not be able to answer its own question.
    //
    // mouse, key and type are "allow" in the default policy, and the approval
    // card is an ordinary layer surface: nothing stopped an agent moving the
    // pointer onto "Allow once" and clicking it. Every gate in this project
    // rests on a person deciding, and that made the deciding optional.
    awaitingApproval++
    let verdict: string
    try {
      verdict = await askOverlay({
        tool: toolName,
        capability: cap,
        scope,
        target: d.subject,
        reasons: d.reasons,
      })
    } finally {
      awaitingApproval--
    }

  if (verdict === "always") {
    sessionAlways.add(key)
    noteApproval(`you approved ${scope} for the rest of the run`)
    return
  }
  if (verdict === "allow") {
    noteApproval(`you approved ${scope}`)
    return
  }

  const why: Record<Exclude<Verdict, "allow" | "always">, string> = {
    deny: "the user denied it in the approval overlay",
    timeout: `nobody answered the approval overlay within ${Math.round(ASK_TIMEOUT_MS / 1000)}s`,
    unavailable:
      "the approval overlay is unreachable — the Omarchy bar plugin " +
      `"${QS_TARGET}" is not loaded, so an "ask" verdict cannot be resolved and fails closed.\n` +
      `  Check: qs -p ${QS_SHELL} ipc call ${QS_TARGET} status`,
  }

  throw new Refused(
    [
      `REFUSED: ${toolName} on ${d.subject}`,
      ...d.reasons.map((r) => `  ${r}`),
      `  => effective: ask, and ${why[verdict]}`,
      "",
      `Set the relevant rule to "allow" in ${policyPath()} to stop being asked, ` +
        "or ask the user to approve it on the bar.",
    ].join("\n"),
  )
}

// ----------------------------------------------------------- window lookup

/** Resolve a loose selector to exactly one window. */
async function resolve(selector?: string): Promise<Win> {
  if (!selector || selector === "active" || selector === "focused") {
    const active = await hyprJson<Win | Record<string, never>>("activewindow")
    if (!("address" in active) || !active.address) throw new Error("no window is focused right now")
    return active as Win
  }

  const all = await windows()
  if (/^0x[0-9a-f]+$/i.test(selector)) {
    const w = all.find((x) => x.address.toLowerCase() === selector.toLowerCase())
    if (!w) throw new Error(`no window with address ${selector}`)
    return w
  }

  const mapped = all.filter((w) => w.mapped)
  const re = glob(selector.includes("*") ? selector : `*${selector}*`)
  const hits = mapped.filter((w) => re.test(w.class) || re.test(w.title))

  if (hits.length === 0) {
    const inventory = mapped.map((w) => `  ${w.class} — "${w.title}"`).join("\n")
    throw new Error(`no window matches "${selector}". Currently open:\n${inventory}`)
  }
  hits.sort((a, b) => a.focusHistoryID - b.focusHistoryID)
  if (hits.length > 3) {
    const list = hits.map((w) => `  ${w.address}  ${w.class} — "${w.title}"`).join("\n")
    throw new Error(`"${selector}" matches ${hits.length} windows — pass an address instead:\n${list}`)
  }
  return hits[0]!
}

const describe = (w: Win) =>
  [
    `${w.address}  ws=${w.workspace.name}  ${w.size[0]}x${w.size[1]}+${w.at[0]}+${w.at[1]}` +
      `${w.floating ? "  floating" : ""}${w.fullscreen ? "  fullscreen" : ""}${w.pinned ? "  pinned" : ""}`,
    `  class: ${w.class}`,
    `  title: ${w.title}`,
  ].join("\n")

const target = (w: Win) => `address:${w.address}`

// ---------------------------------------------------------------- clipboard

/** Set the clipboard without letting wl-copy's lingering daemon block us. */
function clipboardSet(text: string) {
  // wl-copy forks and stays alive to serve the selection. If we inherit its
  // stdio, awaiting it never returns -- so detach completely and forget it.
  const proc = Bun.spawn(["wl-copy", "--type", "text/plain;charset=utf-8", "--", text], {
    stdio: ["ignore", "ignore", "ignore"],
  })
  proc.unref()
}

async function clipboardGet(): Promise<string | null> {
  const r = await sh`wl-paste --no-newline`.quiet()
  return r.exitCode === 0 ? r.stdout.toString() : null
}

// --------------------------------------------------------------------- keys

const MOD_ORDER = ["SUPER", "CTRL", "ALT", "SHIFT"] as const
const MOD_ALIAS: Record<string, string> = {
  super: "SUPER",
  mod: "SUPER",
  win: "SUPER",
  meta: "SUPER",
  logo: "SUPER",
  ctrl: "CTRL",
  control: "CTRL",
  alt: "ALT",
  mod1: "ALT",
  shift: "SHIFT",
}

/** "ctrl+shift+v" or "SUPER SHIFT E" -> mods/key plus a canonical form. */
function parseChord(chord: string): { mods: string; key: string; canonical: string } {
  const parts = chord.trim().split(/[+\s]+/).filter(Boolean)
  if (parts.length === 0) throw new Error("empty key chord")
  const key = parts.pop()!
  const mods = new Set<string>()
  for (const p of parts) {
    const m = MOD_ALIAS[p.toLowerCase()]
    if (!m) throw new Error(`unknown modifier "${p}" in "${chord}" — use SUPER, CTRL, ALT or SHIFT`)
    mods.add(m)
  }
  const ordered = MOD_ORDER.filter((m) => mods.has(m))
  return {
    mods: ordered.join(" "),
    key,
    canonical: `${ordered.join(" ")}${ordered.length ? "+" : ""}${key}`,
  }
}

async function sendChord(chord: string, w: Win, policy: Policy) {
  const { mods, key, canonical } = parseChord(chord)
  if (matchesAny(policy.forbidKeys, canonical)) {
    throw new Refused(
      `REFUSED: key chord "${canonical}" is listed in "forbidKeys" in ${policyPath()}.\n` +
        `  forbidKeys: ${policy.forbidKeys.join(", ")}`,
    )
  }
  await dispatch(`hl.dsp.send_shortcut({mods=${luaStr(mods)}, key=${luaStr(key)}, window=${luaStr(target(w))}})`)
  return canonical
}

// -------------------------------------------------------------- screenshots

async function imageSize(file: string): Promise<{ w: number; h: number }> {
  const r = await sh`magick identify -format ${"%w %h"} ${file}`.quiet()
  const [w, h] = r.stdout.toString().trim().split(/\s+/).map(Number)
  return { w: w || 0, h: h || 0 }
}

/**
 * Black out windows the agent may not see, then downscale.
 * Redaction happens at native resolution so the rectangles line up.
 */
async function postProcess(
  file: string,
  region: { x: number; y: number; w: number; h: number },
  hide: Win[],
  policy: Policy,
): Promise<{ file: string; redacted: string[] }> {
  const size = await imageSize(file)
  const sx = region.w > 0 && size.w > 0 ? size.w / region.w : 1
  const sy = region.h > 0 && size.h > 0 ? size.h / region.h : 1

  const args: string[] = [file]
  const redacted: string[] = []

  if (hide.length) {
    args.push("-fill", "black", "-stroke", "red", "-strokewidth", "3")
    for (const w of hide) {
      const x1 = Math.max(0, Math.round((w.at[0] - region.x) * sx))
      const y1 = Math.max(0, Math.round((w.at[1] - region.y) * sy))
      const x2 = Math.min(size.w, Math.round((w.at[0] + w.size[0] - region.x) * sx))
      const y2 = Math.min(size.h, Math.round((w.at[1] + w.size[1] - region.y) * sy))
      if (x2 <= x1 || y2 <= y1) continue
      args.push("-draw", `rectangle ${x1},${y1} ${x2 - 1},${y2 - 1}`)
      redacted.push(`${w.class} — "${w.title}"`)
    }
  }

  if (policy.screenshot.maxWidth > 0) args.push("-resize", `${policy.screenshot.maxWidth}x>`)

  const out = file.replace(/\.png$/, "-final.png")
  args.push(out)
  const r = await sh`magick ${args}`.quiet()
  if (r.exitCode !== 0) throw new Error(`magick failed: ${r.stderr.toString().trim()}`)
  return { file: out, redacted }
}

// ------------------------------------------------------------------ ydotool

async function ydotoolReady(): Promise<{ ok: true } | { ok: false; why: string }> {
  // Bun Shell has no `command` builtin, so resolve the binary natively rather
  // than shelling out -- a shell probe here silently reports "not installed"
  // however many copies of ydotool are on PATH.
  if (!Bun.which("ydotool")) {
    return {
      ok: false,
      why:
        "Clicking and dragging need ydotool, which is not installed. " +
        "Cursor movement and scrolling still work — those do not use it.\n" +
        "  omarchy pkg add ydotool\n" +
        "  systemctl --user enable --now ydotool.service",
    }
  }
  const candidates = [
    process.env.YDOTOOL_SOCKET,
    `${process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid?.() ?? 1000}`}/.ydotool_socket`,
    "/tmp/.ydotool_socket",
  ].filter(Boolean) as string[]
  for (const s of candidates) {
    try {
      await fs.access(s)
      return { ok: true }
    } catch {
      /* keep looking */
    }
  }
  return {
    ok: false,
    why:
      `ydotool is installed but its daemon is not running (no socket at ${candidates.join(", ")}).\n` +
      "  systemctl --user enable --now ydotool.service",
  }
}

async function ydotool(args: string[]) {
  const ready = await ydotoolReady()
  if (!ready.ok) throw new Error(ready.why)
  const r = await sh`ydotool ${args}`.quiet()
  if (r.exitCode !== 0) throw new Error(`ydotool ${args.join(" ")} failed: ${r.stderr.toString().trim()}`)
}

/** Topmost window containing a point, restricted to visible workspaces. */
async function windowAt(x: number, y: number): Promise<Win | null> {
  const [all, mons] = await Promise.all([windows(), monitors()])
  const activeWs = new Set(mons.map((m) => m.activeWorkspace.id))
  const hits = all.filter(
    (w) =>
      w.mapped &&
      !w.hidden &&
      (activeWs.has(w.workspace.id) || w.pinned) &&
      x >= w.at[0] &&
      x < w.at[0] + w.size[0] &&
      y >= w.at[1] &&
      y < w.at[1] + w.size[1],
  )
  hits.sort((a, b) => a.focusHistoryID - b.focusHistoryID)
  return hits[0] ?? null
}

// ==================================================================== server

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
type ToolResult = { content: Content[]; isError?: boolean }

const say = (text: string, extra: Content[] = []): ToolResult => ({
  content: [{ type: "text", text }, ...extra],
})

/**
 * Every refusal and every runtime failure comes back as tool content rather
 * than a protocol error, so the model actually reads the explanation instead
 * of seeing a bare "tool failed".
 */

/**
 * Say what is happening, right now, on the HUD.
 *
 * A tier-4 run showed one line -- the planner's reason for handing off, fixed
 * at the start -- for its whole duration. Two minutes of "needs to load
 * animhq.com" while the agent had long since given up on the browser and moved
 * to curl. It reads as frozen, and twice someone had to ask whether it was
 * working or stuck. The agent knows exactly what it is doing at every step;
 * nothing was carrying that the four inches to the screen.
 *
 * Fire-and-forget on purpose. This is a readout, not a protocol: if the shell
 * is slow, missing, or the plugin is not loaded, the tool call must not wait or
 * fail for the sake of a label.
 */
function pulse(label: string): void {
  if (!label) return
  try {
    Bun.spawn(["qs", "-p", QS_SHELL, "ipc", "call", QS_TARGET, "activity", label.slice(0, 90)],
              { stdout: "ignore", stderr: "ignore", stdin: "ignore" }).unref()
  } catch {}
}

/** One short phrase for what a tool call is about to do. */
function activityLabel(tool: string, a: any): string {
  const first = (v: unknown) => String(v ?? "").split("\n")[0].slice(0, 48)
  switch (tool) {
    case "desktop_screenshot":    return "looking at the screen"
    case "desktop_windows":       return "checking what is open"
    case "desktop_policy":        return "checking what it is allowed to do"
    case "desktop_run":           return `running ${first(a?.command)}`
    case "desktop_launch":        return `opening ${first(a?.app)}`
    case "desktop_workspace":     return `switching to workspace ${first(a?.workspace)}`
    case "desktop_window":        return `${first(a?.verb) || "changing"} a window`
    case "desktop_type":          return "typing"
    case "desktop_key":           return `pressing ${first(a?.keys) || "a key"}`
    case "desktop_mouse":         return "moving the mouse"
    case "desktop_write":         return `writing ${first(a?.path)}`
    case "desktop_edit":          return `editing ${first(a?.path)}`
    case "desktop_browser_open":  return `opening ${first(a?.url) || "the browser"}`
    case "desktop_browser_read":  return "reading the page"
    case "desktop_browser_click": return "clicking on the page"
    case "desktop_browser_type":  return "typing into the page"
    case "desktop_browser_close": return "closing the browser"
    default:                      return tool.replace(/^desktop_/, "").replace(/_/g, " ")
  }
}

/**
 * The plugin's own surfaces, and where they are on screen.
 *
 * An agent that can click and type can operate the UI that governs it: the
 * approval card, the panel with its settings, the prompt. Blocking input while
 * a card is up was half the answer -- it stopped the obvious case and left the
 * principle unstated. The principle is that the machinery deciding what an
 * agent may do must not itself be reachable by that agent.
 *
 * "Keep the dangerous switch in a config file" was the wrong way to say this.
 * It protects by location, which means the protection disappears the moment
 * the switch is put somewhere convenient -- and a settings panel nobody can
 * use without editing JSON is a bad answer to a real question.
 */
const OWN_SURFACES = [
  "omarchy-desktop-agent-prompt",
  "omarchy-desktop-agent-approval",
  "omarchy-desktop-agent-recap",
  "omarchy-desktop-agent-voice",
  // The panel shares Omarchy's bar-flyout namespace, so it cannot be told
  // apart by name. It is covered by the keyboard rule below and by refusing
  // clicks while it is open.
  "omarchy-keyboard-panel",
]

interface Rect { x: number; y: number; w: number; h: number; ns: string }

/** Where our surfaces currently are, or [] if none are mapped. */
async function ownSurfaceRects(): Promise<Rect[]> {
  try {
    const p = Bun.spawn(["hyprctl", "-j", "layers"], { stdout: "pipe", stderr: "ignore" })
    const data = JSON.parse(await new Response(p.stdout).text())
    const out: Rect[] = []
    for (const mon of Object.values<any>(data)) {
      for (const level of Object.values<any>(mon?.levels ?? {})) {
        for (const l of level as any[]) {
          if (OWN_SURFACES.includes(String(l.namespace))) {
            out.push({ x: l.x, y: l.y, w: l.w, h: l.h, ns: String(l.namespace) })
          }
        }
      }
    }
    return out
  } catch { return [] }
}

/** Would a click at (x, y) land on something of ours? */
function insideOwnSurface(rects: Rect[], x: number, y: number): Rect | null {
  return rects.find(r => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) ?? null
}

function guard(tool: string, fn: (args: any) => Promise<ToolResult>) {
  return async (args: any): Promise<ToolResult> => {
    const seq = ++callSeq
    const store = { tool, seq, approvals: [] as string[] }
    let failed: "refused" | "failed" | null = null
    if (INPUT_TOOLS.has(tool)) {
      // Keystrokes go wherever focus is, and our prompt and approval card take
      // focus exclusively -- so typing while one is up types INTO it. The
      // approval counter catches the card; the surface check catches the
      // prompt and anything else of ours that is mapped, without needing to
      // know which is focused.
      if (awaitingApproval > 0) {
        return {
          content: [{
            type: "text",
            text: `REFUSED: an approval is on screen and "${tool}" could answer it.\n` +
                  `  Wait for the person to decide. Their answer comes back as the result of the\n` +
                  `  call that raised it — you do not need to do anything to receive it.`,
          }],
          isError: true,
        }
      }
      if (tool !== "desktop_mouse") {
        const up = (await ownSurfaceRects()).filter(r => r.ns !== "omarchy-keyboard-panel")
        if (up.length) {
          return {
            content: [{
              type: "text",
              text: `REFUSED: this plugin's own interface is on screen (${up.map(r => r.ns).join(", ")}),\n` +
                    `  and it holds the keyboard — anything typed now goes into it rather than the\n` +
                    `  application you meant. Wait for it to close.`,
            }],
            isError: true,
          }
        }
      }
    }

    if (IS_SUBAGENT && MASTER_ONLY[tool]) {
      // Told what to do instead, not just refused. A subagent that hits this
      // should hand the need back up rather than look for another way round --
      // and saying so is the difference between a redirect and a dead end.
      const why = MASTER_ONLY[tool]
      return {
        content: [{
          type: "text",
          text: `REFUSED: ${why}, and you are a delegated subagent (${ROLE}).\n` +
                `  Finish what you can with the tools you have, and return what you still need\n` +
                `  as text in your report. The master will do it and can delegate again.`,
        }],
        isError: true,
      }
    }

    // Attributed, because four subagents pulsing into one readout is otherwise
    // a flicker of disconnected verbs with no way to tell who is doing what.
    pulse((IS_SUBAGENT ? `[${ROLE}] ` : "") + activityLabel(tool, args))

    // Held open for as long as the call takes. A download, a page load or a
    // compile is silent in the audit log and busy on the machine, so beating
    // only at the edges would read the slowest work as the most idle.
    beat()
    const heart = setInterval(beat, 5000)
    try {
      return await callCtx.run(store, () => fn(args))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!(e instanceof Refused)) note(msg)
      failed = e instanceof Refused ? "refused" : "failed"
      return { content: [{ type: "text", text: msg }], isError: true }
    } finally {
      clearInterval(heart)
      beat()
      // desktop_policy is the agent reading the rules, not touching anything.
      if (tool !== "desktop_policy") {
        // seq*10 keeps an approval immediately above the action it unblocked.
        store.approvals.forEach((a, i) => record({ text: a, tone: "warn" }, seq * 10 + i))
        record(
          failed
            ? { text: `${describeCall(tool, args)} — ${failed}`, tone: "bad" }
            : { text: describeCall(tool, args), tone: "ok" },
          seq * 10 + 9,
        )
        armRecap()
      }
    }
  }
}

/** One human-readable line per tool call, for the recap card. */
function describeCall(tool: string, args: any): string {
  const a = args ?? {}
  const where = a.window ? ` on ${a.window}` : ""
  switch (tool) {
    case "desktop_windows":
      return "listed the open windows"
    case "desktop_screenshot":
      return `captured ${a.target ?? "the focused monitor"}`
    case "desktop_window":
      return `${a.action}${where}${a.workspace ? ` -> workspace ${a.workspace}` : ""}`
    case "desktop_workspace":
      if (a.workspace) return `switched to workspace ${a.workspace}`
      return a.monitor ? `focused monitor ${a.monitor}` : "workspace change"
    case "desktop_launch":
      return `launched ${a.app}`
    case "desktop_type": {
      const n = typeof a.text === "string" ? a.text.length : 0
      return `typed ${n} character${n === 1 ? "" : "s"}${where}${a.submit ? " and pressed Return" : ""}`
    }
    case "desktop_key":
      return `pressed ${Array.isArray(a.keys) ? a.keys.join(", ") : "keys"}${where}`
    case "desktop_run":
      return `ran ${[a.command, ...(Array.isArray(a.args) ? a.args : [])].join(" ")}`
    case "desktop_browser_open":
      return args?.url ? `opened ${args.url} in the agent browser` : "opened the agent browser"
    case "desktop_browser_read":
      return `read the agent browser page${args?.filter ? ` for "${args.filter}"` : ""}`
    case "desktop_browser_click":
      return `clicked element ${args?.ref} in the agent browser`
    case "desktop_browser_type":
      return `typed into element ${args?.ref} in the agent browser`
    case "desktop_browser_close":
      return "closed the agent browser"
    case "desktop_mouse":
      return `mouse ${a.action}${a.x !== undefined ? ` at ${Math.round(a.x)},${Math.round(a.y ?? 0)}` : ""}`
    default:
      return tool
  }
}

const server = new McpServer({ name: "desktop", version: "2.0.0" })

// Master-only tools are not merely refused to a subagent -- they are not
// offered to it.
//
// Refusing at call time is the backstop and it works, but a tool that appears
// in the list is a tool the model will reason about, attempt, and spend a turn
// discovering it cannot have. Worse, it invites working around: an agent told
// "you may not use the browser" while looking at a browser tool will look for
// another way to browse. Removing it from the list removes the idea.
//
// The refusal in guard() stays as defence in depth: registration is decided
// once at startup from the environment, and anything that reaches a handler by
// some other route still stops there.
{
  const registerAll = server.registerTool.bind(server)
  ;(server as unknown as { registerTool: typeof registerAll }).registerTool = ((
    name: string, spec: unknown, handler: unknown,
  ) => {
    if (IS_SUBAGENT && MASTER_ONLY[name]) return undefined as never
    return registerAll(name as never, spec as never, handler as never)
  }) as typeof registerAll
}

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_delegate",
  {
    description:
      "Run several INDEPENDENT pieces of work in parallel, each in its own agent with its own terminal. " +
      "Use it when a job splits cleanly into pieces that do not need each other's results -- five papers to read, " +
      "ten directories to inspect -- and you will combine the answers yourself afterwards. " +
      "Each task must be self-contained: subagents cannot see each other, cannot ask you anything, and return text only. " +
      "They have no browser and cannot delegate further; if a piece needs either, they say so and you do it. " +
      "Do NOT use this for work that must happen in order, or for a single task split into steps.",
    inputSchema: {
      tasks: z.array(z.string().min(1)).min(1).max(20)
        .describe("One self-contained instruction per subagent, in the order you want the results."),
    },
  },
  guard("desktop_delegate", async (args: { tasks: string[] }) => {
    const { policy, error } = await loadPolicy()
    if (!policy.enabled) {
      throw new Refused('REFUSED: policy "enabled" is false — desktop control is switched off')
    }
    if (error) throw new Refused(`REFUSED: ${error}`)

    // Last batch's directories go now, not at the end of this one. Whatever a
    // previous wave left is certainly finished with; what THIS wave writes is
    // about to be read by the master.
    purgeSubagentDirs(TMP)

    const limit = concurrencyLimit(Number(await settingStr("agent.maxSubagents", "4")))
    const idleMs = Number(await settingStr("agent.idleSec", "120")) * 1000
    const maxMs = Number(await settingStr("agent.maxRunSec", "3600")) * 1000

    await audit(policy, `delegate ${args.tasks.length} task(s), ${limit} at a time`)

    let results
    try {
      results = await runPool(args.tasks, limit, (task, i) =>
        runSubagent(task, i, { workspace: CONFINE_WS || 10, idleMs, maxMs }))
    } finally {
      // In a finally, because a throw between here and the return would
      // otherwise leave four windows open with no batch running behind them.
      closeSubagentWindows()
    }

    // Reported per task, in the order they were given, with failures named.
    // A join that has to work out which answer belongs to which task will
    // eventually pair the wrong two, and a batch that hides its failures is
    // worse than one that fails outright: the master would synthesise three
    // findings and present them as five.
    const out: string[] = []
    let failed = 0
    results.forEach((r, i) => {
      const v = r.ok ? r.value : null
      if (!v || !v.ok) failed++
      out.push(`## task ${i + 1}${v ? ` (${v.name})` : ""} — ${v?.ok ? "done" : "FAILED"}`)
      const body = v ? (v.ok ? v.report : `${v.summary}\n${v.report}`.trim())
                     : (r as { ok: false; error: string }).error
      // Capped per task. Twenty subagents returning directory listings or build
      // logs would arrive as one enormous string in the master's context, and a
      // model reasoning across a swamped window joins worse than one reading
      // four tidy summaries. The subagent prompt asks for brevity; this is what
      // happens when it does not comply.
      out.push(body.length > 4000
        ? `${body.slice(0, 4000)}\n\n… truncated at 4000 characters (the full text stayed in ${v?.name ?? "the subagent"}'s scratch directory)`
        : body)
      out.push("")
    })
    out.unshift(failed
      ? `${results.length - failed} of ${results.length} finished, ${failed} failed. Use what succeeded and say plainly what is missing.`
      : `All ${results.length} finished.`)
    return say(out.join("\n"))
  }),
)

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_schedule",
  {
    description:
      "Schedule something for later or for repeatedly: a reminder, or a task you will carry out then. " +
      "Use kind='reminder' for anything that is just a message to the person at a time -- it sends a notification and runs no agent at all, " +
      "which is what most requests of this shape actually want. " +
      "Use kind='task' only when work must genuinely be DONE at that time, and list the capabilities it will need: " +
      "a scheduled task runs with nobody watching, so it cannot ask for anything it did not declare. " +
      "Creating a schedule asks the person first, and shows them exactly what it will be allowed to do.",
    inputSchema: {
      kind: z.enum(["reminder", "task"]).describe("reminder = a notification; task = an agent run"),
      text: z.string().min(1).describe("What to say (reminder) or what to do (task)."),
      when: z.string().min(1).describe(
        "When to fire. Either a systemd calendar spec -- 'Mon..Fri 08:30', '09:00' (every day), '*-*-* 07:00:00', '2026-09-06 14:30' -- or a plain 'tomorrow 09:00' / 'today 18:30', which is converted. A bare time repeats DAILY; give a date for once."),
      recurrent: z.boolean().describe("true repeats on that schedule; false fires once and removes itself."),
      capabilities: z.array(z.enum(ALL_CAPS as unknown as [string, ...string[]])).optional()
        .describe("For kind='task': everything it may do. Ask for the least that will work; it cannot be widened at run time."),
    },
  },
  guard("desktop_schedule", async (args: {
    kind: "reminder" | "task"; text: string; when: string; recurrent: boolean; capabilities?: string[]
  }) => {
    const { policy, error } = await loadPolicy()
    if (!policy.enabled) throw new Refused('REFUSED: policy "enabled" is false — desktop control is switched off')

    // A schedule outlives the conversation that made it, so it is agreed to
    // once, in front of the person, with its powers written out. This is the
    // moment that decides what runs unattended later.
    const caps = args.kind === "task" ? (args.capabilities ?? []) : []
    const d: Decision = {
      action: "ask",
      subject: `${args.recurrent ? "repeating" : "one-off"} ${args.kind}: ${args.text.slice(0, 80)}`,
      reasons: [
        `when: ${args.when}`,
        args.kind === "task"
          ? `may: ${caps.length ? caps.join(", ") : "(nothing declared — it will be able to do nothing)"}`
          : "sends a notification; runs no agent",
        args.recurrent ? "repeats until cancelled or expired (90 days)" : "fires once, then removes itself",
      ],
    }
    // Checked BEFORE asking, not after. The other order raises an approval
    // card, waits for a person to read and accept it, and then refuses anyway
    // -- which teaches them that approving does not mean the thing happens.
    const existing = listJobs()
    if (existing.length >= 20) {
      throw new Refused(
        `REFUSED: 20 jobs are already scheduled, which is the limit. ` +
        `See them with "desktop-agent jobs" and cancel some first.`)
    }

    await gate("desktop_schedule", "observe", d, error, `schedule:${args.kind}`,
      // Never pre-approved by a lease or by another job's capabilities:
      // creating a schedule is how a single run becomes a standing one, and
      // that should always be a decision somebody makes awake.
      "creating a schedule is always confirmed in person")

    const r = createJob({
      kind: args.kind, text: args.text, when: args.when,
      recurrent: args.recurrent, capabilities: caps,
    })
    if (!r.ok) throw new Error(r.error ?? "could not schedule it")

    await audit(policy, `scheduled ${args.kind} ${r.job!.id}: ${args.when} — ${args.text.slice(0, 60)}`)
    return say(
      `scheduled: ${r.job!.id}\n` +
      `  ${args.recurrent ? "repeats" : "once"} at ${args.when}\n` +
      (caps.length ? `  may: ${caps.join(", ")}\n` : "") +
      `  cancel with: desktop-agent job-cancel ${r.job!.id}`)
  }),
)

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_policy",
  {
    description:
      "Show the desktop-control policy currently in force: which capabilities, workspaces and applications you may observe and act on, " +
      "plus the effective verdict for every window open right now. " +
      "Call this when you are unsure whether something is permitted, or after a refusal, instead of retrying blindly. " +
      "The user may change the policy at any moment; it is re-read on every call.",
    inputSchema: {},
  },
  guard("desktop_policy", async () => {
    const { policy, error } = await loadPolicy()
    const out: string[] = []

    out.push(`policy file: ${policyPath()}`)
    out.push(`caller identity: "${IDENTITY}"`)
    if (error) out.push(`PROBLEM: ${error}`)
    out.push(`enabled: ${policy.enabled}${policy.enabled ? "" : "   <- every desktop tool is refusing"}`)
    const y = await yoloState(policy)
    out.push(
      y.active
        ? `YOLO: ON — every "ask" is auto-approved for the next ${minutesLeft(y.remainingMs)} min. ` +
            "Destructive commands still prompt. Every \"deny\" still refuses."
        : `YOLO: off${y.why ? ` (${y.why})` : ""}`,
    )
    out.push(`protectSelf: ${policy.protectSelf}    maxTextLength: ${policy.maxTextLength}`)
    out.push(`screenshot: maxWidth=${policy.screenshot.maxWidth} redactDenied=${policy.screenshot.redactDenied}`)

    out.push("", "capabilities (unset = ask):")
    for (const cap of ALL_CAPS) out.push(`  ${cap.padEnd(11)} ${coerceAction(policy.capabilities[cap], "ask")}`)
    // Said here because this is where someone looks when a change did not
    // take. Silence was the bug: the line is in the file, the file is valid,
    // and the setting it names does nothing.
    if (policy.capUnknown.length) {
      out.push("", "IGNORED — these lines in \"capabilities\" have NO EFFECT:")
      for (const u of policy.capUnknown) out.push(`  ${u}`)
      out.push(`  the capabilities this build reads are: ${ALL_CAPS.join(", ")}`)
    }

    out.push("", `per-identity limits for "${IDENTITY}" (last match wins):`)
    if (!Object.keys(policy.agents).length) {
      out.push('  (no "agents" section — no per-identity limit)')
    } else {
      for (const cap of ALL_CAPS) out.push(`  ${cap.padEnd(11)} ${agentAction(policy, IDENTITY, cap).action ?? "deny"}`)
    }

    out.push("", "paths — where desktop_write and desktop_edit may go (last match wins, unmatched = deny):")
    if (!Object.keys(policy.paths).length) {
      out.push('  (no "paths" section — every write is refused)')
    } else {
      for (const [pattern, action] of Object.entries(policy.paths)) out.push(`  ${action.padEnd(6)} ${pattern}`)
    }
    out.push(`  write.maxBytes=${policy.write.maxBytes} write.backup=${policy.write.backup}`)
    out.push("  Writes by a command you run (ffmpeg, git, tar) are NOT checked against this — only your own")
    out.push("  desktop_write / desktop_edit calls are. run.commands is what gates those.")

    out.push("", "workspaces (last match wins, unmatched = deny):")
    for (const [p, a] of Object.entries(policy.workspaces)) out.push(`  ${p.padEnd(22)} ${a}`)
    if (!Object.keys(policy.workspaces).length) out.push("  (none — every workspace is denied)")

    out.push("", "apps (last match wins, unmatched = deny):")
    for (const [p, v] of Object.entries(policy.apps)) {
      out.push(
        `  ${p.padEnd(38)} ${
          typeof v === "string" ? v : WINDOW_VERBS.map((k) => `${k}=${v[k] ?? "deny"}`).join(" ")
        }`,
      )
    }
    if (!Object.keys(policy.apps).length) out.push("  (none — every window is denied)")

    out.push("", "launchable applications (by name only):")
    for (const [n, e] of Object.entries(policy.launch)) {
      out.push(`  ${n.padEnd(12)} ${e.command.join(" ")}${e.args ? "  [args allowed]" : ""}  ${e.action ?? "ask"}`)
    }
    if (!Object.keys(policy.launch).length) out.push("  (none)")

    if (policy.forbidKeys.length) out.push("", `forbidden key chords: ${policy.forbidKeys.join(", ")}`)

    try {
      const open = (await windows()).filter((w) => w.mapped)
      out.push("", "effective verdict per open window:")
      const capFor: Record<WindowVerb, Capability> = {
        see: "observe",
        focus: "focus",
        manage: "manage",
        input: "type",
      }
      for (const w of open) {
        const verdicts: string[] = []
        for (const verb of WINDOW_VERBS) {
          verdicts.push(`${verb}=${(await decideWindow(policy, capFor[verb], verb, w)).action}`)
        }
        out.push(`  ${(w.class || "?").slice(0, 30).padEnd(31)} ${verdicts.join(" ")}`)
        out.push(`  ${" ".repeat(31)} "${w.title.slice(0, 60)}"`)
      }
    } catch {
      /* Hyprland unreachable; the static dump above still stands */
    }

    const ready = await ydotoolReady()
    out.push("", `mouse click/drag backend: ${ready.ok ? "ready (ydotool)" : "UNAVAILABLE"}`)
    if (!ready.ok) out.push(ready.why.split("\n").map((l) => `  ${l}`).join("\n"))

    const overlay = await qsIpc("status")
    out.push(
      `approval overlay: ${overlay.ok ? `reachable — ${overlay.out}` : `UNREACHABLE — every "ask" verdict will refuse`}`,
    )

    return say(out.join("\n"))
  }),
)

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_windows",
  {
    description:
      "List the windows, workspaces and monitors you are allowed to see, with addresses and geometry. " +
      "Use the returned 0x… address to target the other desktop tools unambiguously. " +
      "Windows the policy hides are omitted and reported only as a count, so a short list does not mean little is open.",
    inputSchema: {
      workspace: z.string().optional().describe('Restrict to one workspace by name, e.g. "3". Omit to list every workspace.'),
    },
  },
  guard("desktop_windows", async (args: { workspace?: string }) => {
    const { policy, error } = await loadPolicy()
    await gate("desktop_windows", "observe", decideGlobal(policy, "observe", "window inventory"), error, "observe")

    const [all, mons, cur] = await Promise.all([windows(), monitors(), cursorPos()])
    const visible: Win[] = []
    let withheld = 0

    for (const w of all) {
      if (!w.mapped) continue
      if (args.workspace && w.workspace.name !== args.workspace) continue
      if ((await decideWindow(policy, "observe", "see", w)).action === "deny") {
        withheld++
        continue
      }
      visible.push(w)
    }
    visible.sort((a, b) => a.workspace.id - b.workspace.id || a.focusHistoryID - b.focusHistoryID)

    const out: string[] = []
    out.push(
      `monitors: ${mons
        .map(
          (m) =>
            `${m.name} ${m.width}x${m.height}@${m.scale}x at ${m.x},${m.y} (ws ${m.activeWorkspace.name}${
              m.focused ? ", focused" : ""
            })`,
        )
        .join("  |  ")}`,
    )
    out.push(`cursor: ${cur.x},${cur.y}`)
    out.push("")

    if (!visible.length) out.push("no windows you are allowed to see")
    let ws = ""
    for (const w of visible) {
      if (w.workspace.name !== ws) {
        ws = w.workspace.name
        out.push(`workspace ${ws}:`)
      }
      out.push(describe(w).split("\n").map((l) => `  ${l}`).join("\n"))
    }
    if (withheld) {
      out.push("")
      out.push(`(${withheld} window${withheld === 1 ? "" : "s"} withheld by policy — you may not see them)`)
    }

    return say(out.join("\n"))
  }),
)

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_screenshot",
  {
    description:
      "Capture the screen and return it as an image you can actually look at. " +
      "Take one before any mouse work to find out where things are, and another afterwards to confirm the result. " +
      "Windows you may not see are painted over with a black, red-bordered rectangle rather than the capture being refused — " +
      "a black box means 'withheld by policy', not 'empty'.",
    inputSchema: {
      target: z
        .string()
        .optional()
        .describe(
          'What to capture: omit or "screen" for the focused monitor, a monitor name such as "eDP-1", ' +
            "or a window address/class/title fragment to capture just that window.",
        ),
      save: z
        .boolean()
        .optional()
        .describe(
          "Keep the capture as a PNG the person can open afterwards, and report its path. " +
            "Off by default: a capture left on disk is a picture of someone's desktop. " +
            "Use it when your report needs evidence rather than just your own reading of the screen.",
        ),
    },
  },
  guard("desktop_screenshot", async (args: { target?: string; save?: boolean }) => {
    const { policy, error } = await loadPolicy()
    const sel = args.target?.trim()
    const mons = await monitors()
    const monNames = new Set(mons.map((m) => m.name))

    let region: { x: number; y: number; w: number; h: number }
    let label: string
    let capArgs: string[]
    // The window this capture claims to be of, when it is of one at all.
    let target: Win | null = null

    if (sel && monNames.has(sel)) {
      const m = mons.find((x) => x.name === sel)!
      region = { x: m.x, y: m.y, w: Math.round(m.width / m.scale), h: Math.round(m.height / m.scale) }
      label = `monitor ${m.name}`
      capArgs = ["-o", m.name]
    } else if (!sel || sel === "screen" || sel === "all") {
      const m = mons.find((x) => x.focused) ?? mons[0]
      if (!m) throw new Error("no monitors reported by Hyprland")
      region = { x: m.x, y: m.y, w: Math.round(m.width / m.scale), h: Math.round(m.height / m.scale) }
      label = `monitor ${m.name}`
      capArgs = ["-o", m.name]
    } else {
      const w = await resolve(sel)
      const d = await decideWindow(policy, "screenshot", "see", w)
      await gate("desktop_screenshot", "screenshot", d, error, `class:${w.class}`)

      // A window not currently on screen cannot be captured, and must not be
      // faked from the pixels at its coordinates.
      //
      // grim photographs a RECTANGLE OF THE OUTPUT, not a window's surface. A
      // window parked on workspace 10 while the monitor shows workspace 1
      // still reports geometry, so the old code handed back whatever was
      // physically at those coordinates and stamped the requested window's
      // name on it: a capture labelled 'agent-browser — "Dalti Provider"' that
      // was in fact somebody's YouTube page. Silent, confident, and wrong --
      // the worst shape a verification tool can fail in, because the label
      // asserts a provenance the pixels do not have.
      //
      // Refusing is the honest answer. The agent can switch workspaces and ask
      // again; what it must never get is plausible pixels under the wrong name.
      const shown = new Set(mons.map((m) => m.activeWorkspace.id))
      if (!w.mapped || w.hidden || (!shown.has(w.workspace.id) && !w.pinned)) {
        throw new Refused(
          `REFUSED: ${w.class} — "${w.title}" is not on screen right now ` +
            `(it is on workspace ${w.workspace.name}; ` +
            `${mons.map((m) => `${m.name} is showing ${m.activeWorkspace.name}`).join(", ")}).\n` +
            "  A capture is a photograph of the screen, so there is nothing of this window to\n" +
            "  photograph. Returning the pixels at its coordinates would show you a different\n" +
            "  window under this one's name.\n" +
            `  => switch to workspace ${w.workspace.name} with desktop_workspace, then capture again.`,
        )
      }

      region = { x: w.at[0], y: w.at[1], w: w.size[0], h: w.size[1] }
      label = `window ${w.class} — "${w.title}"`
      target = w
      capArgs = ["-g", `${region.x},${region.y} ${region.w}x${region.h}`]
    }

    if (capArgs[0] === "-o") {
      await gate("desktop_screenshot", "screenshot", decideGlobal(policy, "screenshot", label), error, "screen")
    }

    // Work out which visible windows must be hidden from the capture.
    const activeWs = new Set(mons.map((m) => m.activeWorkspace.id))
    const hide: Win[] = []
    // Everything else sharing the rectangle. Reported, not hidden: a capture is
    // whatever the screen shows there, so anything overlapping may be sitting
    // on top of what was asked for. Being told is what lets a caller doubt a
    // frame instead of describing it with confidence.
    const overlapping: Win[] = []
    for (const w of await windows()) {
      if (!w.mapped || w.hidden) continue
      if (!activeWs.has(w.workspace.id) && !w.pinned) continue
      const intersects =
        w.at[0] < region.x + region.w &&
        w.at[0] + w.size[0] > region.x &&
        w.at[1] < region.y + region.h &&
        w.at[1] + w.size[1] > region.y
      if (!intersects) continue
      if ((await decideWindow(policy, "screenshot", "see", w)).action === "deny") hide.push(w)
      else if (!target || w.address !== target.address) overlapping.push(w)
    }

    if (hide.length && !policy.screenshot.redactDenied) {
      throw new Refused(
        `REFUSED: desktop_screenshot on ${label}\n` +
          hide.map((w) => `  would expose a window you may not see: ${w.class} — "${w.title}"`).join("\n") +
          `\n  => "screenshot.redactDenied" is false in ${policyPath()}, so the capture is refused instead of masked.`,
      )
    }

    // 0700: a capture can hold whatever the policy works hard to redact
    // elsewhere, so no other local user gets to walk into this directory.
    await fs.mkdir(TMP, { recursive: true, mode: 0o700 })
    await fs.chmod(TMP, 0o700).catch(() => {})

    // pid in the name: every Claude Code session spawns its own server, and
    // two of them can reach the same millisecond.
    const raw = path.join(TMP, `shot-${Date.now()}-${process.pid}.png`)
    let processed: string | null = null
    let kept: string | null = null

    // Both files must go even if magick, the read, or the policy throws below.
    // A leaked capture is a screenshot of the user's desktop left on disk.
    try {
    const grab = await sh`grim ${capArgs} ${raw}`.quiet()
    if (grab.exitCode !== 0) throw new Error(`grim failed: ${grab.stderr.toString().trim()}`)

    const { file, redacted } = await postProcess(raw, region, hide, policy)
    processed = file
    const size = await imageSize(file)
    await audit(policy, `screenshot ${label}${redacted.length ? ` (redacted ${redacted.length})` : ""}`)

    const notes = [
      `captured ${label}`,
      `logical region ${region.w}x${region.h} at ${region.x},${region.y}`,
      `image ${size.w}x${size.h}px`,
    ]
    if (redacted.length) {
      notes.push("", "blacked out by policy (you may not see these):")
      notes.push(...redacted.map((r) => `  ${r}`))
    }
    // Only for a window capture: on a whole-monitor shot everything overlaps
    // everything, and saying so every time would train the reader to skip it.
    if (target && overlapping.length) {
      notes.push(
        "",
        "SHARING THIS RECTANGLE — any of these may be in front of the window you asked for:",
        ...overlapping.map((w) => `  ${w.class} — "${w.title}"`),
        "A capture is a photograph of the screen, not of a window's own surface. If what you",
        "see does not match the window named above, one of these is on top: focus it away, or",
        "focus the target first, then capture again.",
      )
    }
    notes.push(
      "",
      "Coordinates for desktop_mouse are Hyprland's global logical coordinates, " +
        `not image pixels: image (px,py) maps to global (${region.x} + px*${(region.w / (size.w || 1)).toFixed(4)}, ` +
        `${region.y} + py*${(region.h / (size.h || 1)).toFixed(4)}).`,
    )

    // Keeping it is the REDACTED file, never the raw grab.
    //
    // The alternative people reach for is allowing grim in run.commands, which
    // is the one thing that must not happen: grim is desktop_screenshot minus
    // the redaction, so it would hand over exactly the password managers and
    // 2FA windows blacked out above. An artifact is worth having; an
    // unredacted one is not.
    if (args.save) {
      await fs.mkdir(SHOTS, { recursive: true, mode: 0o700 })
      await fs.chmod(SHOTS, 0o700).catch(() => {})
      kept = path.join(SHOTS, `shot-${Date.now()}-${process.pid}.png`)
      await fs.copyFile(file, kept)
      await fs.chmod(kept, 0o600).catch(() => {})
      await pruneShots()
      notes.splice(1, 0, `saved to ${kept}`)
      await audit(policy, `screenshot saved ${kept}`)
    }

    const bytes = await fs.readFile(file)
    return say(notes.join("\n"), [{ type: "image", data: bytes.toString("base64"), mimeType: "image/png" }])
    } finally {
      await fs.rm(raw, { force: true }).catch(() => {})
      if (processed) await fs.rm(processed, { force: true }).catch(() => {})
    }
  }),
)

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_window",
  {
    description:
      "Act on one window: focus, close, kill, toggle floating or fullscreen, centre, pin, move, resize, " +
      "or send it to another workspace. Identify the window by its 0x… address from desktop_windows where possible; " +
      "a class or title fragment also works but is refused when it is ambiguous.",
    inputSchema: {
      window: z.string().describe('Window address (0x…), a class/title fragment, or "active" for the focused window.'),
      action: z
        .enum(["focus", "close", "kill", "float", "fullscreen", "center", "pin", "move", "resize", "to_workspace"])
        .describe(
          "focus moves keyboard focus. close asks the app to quit; kill force-terminates it. " +
            "float/fullscreen/pin toggle. move and resize need x and y. to_workspace needs workspace.",
        ),
      // Both are ABSOLUTE. Documented as deltas until someone spent a run
      // discovering otherwise: every negative "delta" came back "Invalid size",
      // which reads as a broken tool rather than a wrong description.
      x: z.number().optional().describe(
        "ABSOLUTE, not a delta. For move: the new left edge in Hyprland's global logical " +
          "coordinates. For resize: the new width in pixels.",
      ),
      y: z.number().optional().describe(
        "ABSOLUTE, not a delta. For move: the new top edge in Hyprland's global logical " +
          "coordinates. For resize: the new height in pixels.",
      ),
      workspace: z.string().optional().describe('For to_workspace: destination workspace name, e.g. "3".'),
    },
  },
  guard("desktop_window", async (args: { window: string; action: string; x?: number; y?: number; workspace?: string }) => {
    const { policy, error } = await loadPolicy()
    const w = await resolve(args.window)
    const verb: WindowVerb = args.action === "focus" ? "focus" : "manage"
    const cap: Capability = args.action === "focus" ? "focus" : "manage"

    let d = await decideWindow(policy, cap, verb, w)
    if (args.action === "to_workspace") {
      if (!args.workspace) throw new Error('action "to_workspace" requires the "workspace" argument')
      d = withWorkspace(policy, d, args.workspace)
    }
    await gate("desktop_window", cap, d, error, `class:${w.class}`)

    const t = luaStr(target(w))
    let expr: string
    switch (args.action) {
      case "focus":
        expr = `hl.dsp.focus({window=${t}})`
        break
      case "close":
        expr = `hl.dsp.window.close({window=${t}})`
        break
      case "kill":
        expr = `hl.dsp.window.kill({window=${t}})`
        break
      case "float":
        expr = `hl.dsp.window.float({window=${t}})`
        break
      case "fullscreen":
        expr = `hl.dsp.window.fullscreen({window=${t}})`
        break
      case "center":
        expr = `hl.dsp.window.center({window=${t}})`
        break
      case "pin":
        expr = `hl.dsp.window.pin({window=${t}})`
        break
      case "move":
        if (args.x === undefined || args.y === undefined) throw new Error('action "move" requires x and y')
        expr = `hl.dsp.window.move({window=${t}, x=${Math.round(args.x)}, y=${Math.round(args.y)}})`
        break
      case "resize":
        if (args.x === undefined || args.y === undefined) throw new Error('action "resize" requires x and y')
        expr = `hl.dsp.window.resize({window=${t}, x=${Math.round(args.x)}, y=${Math.round(args.y)}})`
        break
      case "to_workspace":
        expr = `hl.dsp.window.move({window=${t}, workspace=${luaStr(args.workspace!)}})`
        break
      default:
        throw new Error(`unknown action "${args.action}"`)
    }

    const said = await dispatch(expr)
    await audit(policy, `window ${args.action} ${w.class} "${w.title}" ${w.address}`)

    // Report the window's state afterwards so the agent sees the effect.
    const after = (await windows()).find((x) => x.address === w.address)
    return say(
      [
        `${args.action} -> ${w.class} — "${w.title}" [${w.address}]`,
        said ? `hyprland: ${said}` : "",
        after ? `now: ${describe(after)}` : "the window is gone",
      ]
        .filter(Boolean)
        .join("\n"),
    )
  }),
)

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_workspace",
  {
    description:
      "Switch the focused workspace, or move focus to another monitor. " +
      "Only workspaces permitted by the policy can be reached.",
    inputSchema: {
      workspace: z.string().optional().describe('Workspace to switch to, e.g. "3".'),
      monitor: z.string().optional().describe('Monitor to focus instead, e.g. "eDP-1".'),
    },
  },
  guard("desktop_workspace", async (args: { workspace?: string; monitor?: string }) => {
    const { policy, error } = await loadPolicy()
    if (!args.workspace && !args.monitor) throw new Error("pass either workspace or monitor")

    if (args.monitor) {
      await gate(
        "desktop_workspace",
        "workspace",
        decideGlobal(policy, "workspace", `monitor ${args.monitor}`),
        error,
        `monitor:${args.monitor}`,
      )
      await dispatch(`hl.dsp.focus({monitor=${luaStr(args.monitor)}})`)
    }

    if (args.workspace) {
      const d = withWorkspace(policy, decideGlobal(policy, "workspace", `workspace ${args.workspace}`), args.workspace)
      await gate("desktop_workspace", "workspace", d, error, `workspace:${args.workspace}`)
      await dispatch(`hl.dsp.focus({workspace=${luaStr(args.workspace)}})`)
    }

    await audit(policy, `workspace switch ${args.workspace ?? ""} ${args.monitor ?? ""}`.trim())
    const active = await hyprJson<{ name: string }>("activeworkspace")
    const mons = await monitors()
    return say(`now on workspace ${active.name}, monitor ${mons.find((m) => m.focused)?.name ?? "?"}`)
  }),
)

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_launch",
  {
    description:
      "Start an application by its policy-defined name. You cannot supply a command line — only a name the user has " +
      'listed under "launch" in the policy — so run desktop_policy first to see what is available.',
    inputSchema: {
      app: z.string().describe('Name from the policy\'s "launch" section, e.g. "browser".'),
      args: z
        .array(z.string())
        .optional()
        .describe("Extra arguments such as a URL. Only accepted when the policy entry sets args: true."),
    },
  },
  guard("desktop_launch", async (args: { app: string; args?: string[] }) => {
    const { policy, error } = await loadPolicy()
    const entry = policy.launch[args.app]
    if (!entry) {
      const names = Object.keys(policy.launch)
      throw new Refused(
        `REFUSED: "${args.app}" is not a launchable application.\n` +
          `  Available: ${names.length ? names.join(", ") : "(none defined)"}\n` +
          `  The user can add it under "launch" in ${policyPath()}.`,
      )
    }
    if (args.args?.length && !entry.args) {
      throw new Refused(
        `REFUSED: "${args.app}" does not accept arguments.\n` +
          `  Set "args": true on launch.${args.app} in ${policyPath()} to allow them.`,
      )
    }

    const cmd = [...entry.command, ...(args.args ?? [])]
    const ag = agentAction(policy, IDENTITY, "launch")
    const d: Decision = {
      action: strictest(ag.action, coerceAction(policy.capabilities.launch, "ask"), entry.action ?? "ask"),
      subject: `${args.app} (${cmd.join(" ")})`,
      reasons: [
        ag.note,
        `capability "launch" -> ${coerceAction(policy.capabilities.launch, "ask")} (capabilities.launch)`,
        `launch."${args.app}" -> ${entry.action ?? "ask"} (launch.${args.app}.action)`,
      ],
    }
    if (!policy.enabled) {
      d.action = "deny"
      d.reasons = ['policy "enabled" is false — desktop control is switched off']
    }
    await gate("desktop_launch", "launch", d, error, `app:${args.app}`)

    const before = new Set((await windows()).map((w) => w.address))
    // Placed, not requested. onWorkspace returns the argv unchanged when
    // confinement is off, so there is no second code path.
    const spawned = onWorkspace(cmd, CONFINE_WS)
    const proc = Bun.spawn(spawned, { stdio: ["ignore", "ignore", "ignore"], env: process.env })
    proc.unref()
    await audit(policy, `launch ${args.app}: ${cmd.join(" ")}` +
      (CONFINE_WS ? ` [workspace ${CONFINE_WS}]` : ""))

    // Give it a moment and report whatever window appeared.
    let appeared: Win[] = []
    for (let i = 0; i < 12 && !appeared.length; i++) {
      await sleep(400)
      appeared = (await windows()).filter((w) => !before.has(w.address) && w.mapped)
    }

    return say(
      appeared.length
        ? `launched ${args.app} (${cmd.join(" ")})\nnew window:\n${appeared.map(describe).join("\n")}`
        : `launched ${args.app} (${cmd.join(" ")}) — no window appeared within 5s; it may be slow to start or have no GUI`,
    )
  }),
)

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_type",
  {
    description:
      "Enter text into a window. Delivered via the clipboard and a paste shortcut, so it is one atomic action and " +
      "Unicode is preserved; the previous clipboard contents are restored afterwards. " +
      "The target window does NOT need to be focused, and typing into it will not steal focus from the user. " +
      "Never use this to run shell commands — that defeats every safeguard the user has set up.",
    inputSchema: {
      text: z.string().describe("The literal text to enter."),
      window: z
        .string()
        .optional()
        .describe("Target window address (0x…) or class/title fragment. Defaults to the focused window."),
      submit: z.boolean().optional().describe("Press Return afterwards, e.g. to send a message."),
      paste_chord: z
        .string()
        .optional()
        .describe("Override the paste shortcut. Defaults to ctrl+v, or ctrl+shift+v for terminals."),
      secret: z
        .boolean()
        .optional()
        .describe(
          "Set this when the text is a password, token, PIN or recovery code. It routes the call " +
            "through the \"secret\" capability, which asks every time and is never auto-approved by a " +
            "full-access lease — so the person sees a card naming the window before anything is typed. " +
            "Say so rather than typing a credential silently.",
        ),
    },
  },
  guard("desktop_type", async (args: { text: string; window?: string; submit?: boolean; paste_chord?: string; secret?: boolean }) => {
    const { policy, error } = await loadPolicy()
    const w = await resolve(args.window)
    const d = await decideWindow(policy, "type", "input", w)
    await gate("desktop_type", "type", d, error, `class:${w.class}`)

    // A credential gets its own gate on top of the ordinary one.
    //
    // Without this there was no gate at all: "type" is a single capability, so
    // a policy with type: "allow" -- which is what a working setup tends to
    // drift to, since asking about every keystroke is unusable -- typed a
    // password with no card shown. The lease was not even involved; an "allow"
    // returns from gate() before the lease is consulted.
    //
    // Declared by the caller here because a native window offers nothing to
    // detect from. The browser path does not have to take anyone's word for
    // it: it reads the field's own type over CDP.
    if (args.secret) {
      await gate(
        "desktop_type", "secret",
        decideGlobal(policy, "secret", `a password into ${w.class} — "${w.title}"`),
        error, `secret:${w.class}`,
        // A lease covers this. You granted it by hand, for the next hour, to
        // get work done -- being stopped at a login box is exactly what you
        // were buying your way past. A scheduled run is the different case,
        // and it is still refused.
        undefined,
        "a password is never typed unattended",
      )
    }

    if (args.text.length > policy.maxTextLength) {
      throw new Refused(
        `REFUSED: ${args.text.length} characters exceeds "maxTextLength" (${policy.maxTextLength}) in ${policyPath()}.`,
      )
    }

    const chord = args.paste_chord ?? (matchesAny(TERMINAL_CLASSES, w.class) ? "ctrl+shift+v" : "ctrl+v")
    const previous = await clipboardGet()

    clipboardSet(args.text)
    await sleep(150)
    const used = await sendChord(chord, w, policy)
    await sleep(400)

    if (args.submit) await sendChord("Return", w, policy)

    // Put the user's clipboard back.
    if (previous !== null && previous !== args.text) {
      await sleep(250)
      clipboardSet(previous)
    }

    await audit(policy, `type ${args.text.length} chars into ${w.class} "${w.title}"${args.submit ? " + Return" : ""}`)

    return say(
      `entered ${args.text.length} characters into ${w.class} — "${w.title}" [${w.address}] ` +
        `via ${used}${args.submit ? " then Return" : ""}\n` +
        `clipboard ${previous !== null ? "restored" : "was empty, left as the typed text"}\n` +
        "Take a screenshot to confirm it landed where you expected.",
    )
  }),
)

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_key",
  {
    description:
      'Press a key or keyboard shortcut in a window, e.g. "Return", "Escape", "ctrl+s", "super+1", "alt+Tab". ' +
      "Modifiers are SUPER, CTRL, ALT and SHIFT; the key name is an X11 keysym such as Return, Escape, Tab, BackSpace, " +
      "Left, Page_Up, F5 or a single character. The window does not need to be focused. " +
      "Prefer this over mouse clicks: it is deterministic and needs no coordinates.",
    inputSchema: {
      keys: z
        .array(z.string())
        .describe('Chords to press in order, e.g. ["ctrl+a", "Delete"]. Each is applied to the same window.'),
      window: z
        .string()
        .optional()
        .describe("Target window address (0x…) or class/title fragment. Defaults to the focused window."),
      delay_ms: z.number().optional().describe("Pause between chords in milliseconds. Default 80."),
    },
  },
  guard("desktop_key", async (args: { keys: string[]; window?: string; delay_ms?: number }) => {
    const { policy, error } = await loadPolicy()
    if (!args.keys.length) throw new Error("pass at least one key chord")
    const w = await resolve(args.window)
    const d = await decideWindow(policy, "key", "input", w)
    await gate("desktop_key", "key", d, error, `class:${w.class}`)

    // Validate every chord before pressing any, so a bad or forbidden chord
    // halfway through cannot leave things half-done.
    const canonical = args.keys.map((k) => parseChord(k).canonical)
    const banned = canonical.filter((c) => matchesAny(policy.forbidKeys, c))
    if (banned.length) {
      throw new Refused(
        `REFUSED: ${banned.join(", ")} listed in "forbidKeys" in ${policyPath()}.\n` +
          `  forbidKeys: ${policy.forbidKeys.join(", ")}`,
      )
    }

    const delay = Math.max(0, args.delay_ms ?? 80)
    const sent: string[] = []
    for (const k of args.keys) {
      sent.push(await sendChord(k, w, policy))
      await sleep(delay)
    }
    await audit(policy, `keys ${sent.join(" ")} -> ${w.class} "${w.title}"`)

    return say(`pressed ${sent.join(", ")} in ${w.class} — "${w.title}" [${w.address}]`)
  }),
)

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_mouse",
  {
    description:
      "Move the cursor, click, scroll or drag, in Hyprland's global logical coordinates. " +
      "Always take a screenshot first and convert image pixels to global coordinates using the mapping it reports — " +
      "clicking blind is how an agent closes the wrong dialog. " +
      "Cursor movement is native; clicking and dragging need the ydotool daemon. " +
      "Prefer desktop_key when a keyboard route exists.",
    inputSchema: {
      action: z
        .enum(["move", "click", "double_click", "right_click", "middle_click", "scroll", "drag"])
        .describe(
          "move and scroll need no extra daemon. click/double_click/right_click/middle_click/drag need ydotool. " +
            "scroll is implemented with Page_Up/Page_Down keys sent to the window under the cursor, because " +
            "ydotool 1.0.4 cannot emulate a wheel — so it pages rather than scrolling smoothly.",
        ),
      x: z.number().optional().describe("Global logical X. Defaults to the cursor's current X."),
      y: z.number().optional().describe("Global logical Y. Defaults to the cursor's current Y."),
      to_x: z.number().optional().describe("For drag: global X to release at."),
      to_y: z.number().optional().describe("For drag: global Y to release at."),
      amount: z
        .number()
        .optional()
        .describe("For scroll: pages to move. Negative scrolls down, positive up. Default -1, capped at 20."),
    },
  },
  guard("desktop_mouse", 
    async (args: { action: string; x?: number; y?: number; to_x?: number; to_y?: number; amount?: number }) => {
      const { policy, error } = await loadPolicy()
      const cur = await cursorPos()
      const x = Math.round(args.x ?? cur.x)
      const y = Math.round(args.y ?? cur.y)

      // Not onto our own surfaces. The approval card, the prompt and the
      // settings panel are how a person controls this agent; an agent that can
      // click them controls the thing that controls it. Checked by geometry
      // rather than by intent, because "do not click Allow" is advice and this
      // is a rule.
      const own = await ownSurfaceRects()
      const hitFrom = insideOwnSurface(own, x, y)
      const hitTo = args.to_x !== undefined && args.to_y !== undefined
        ? insideOwnSurface(own, Math.round(args.to_x), Math.round(args.to_y))
        : null
      const hit = hitFrom ?? hitTo
      if (hit) {
        throw new Refused(
          `REFUSED: (${x}, ${y}) is inside this plugin's own interface (${hit.ns}).\n` +
          `  Approvals, the prompt and the settings panel are the person's controls over you.\n` +
          `  Whatever you need there, ask for it in your answer instead.`)
      }

      // Whatever sits under the target point is what we are really acting on,
      // so it is that window's "input" verb that has to permit this.
      const under = await windowAt(x, y)
      let d: Decision
      if (under) {
        d = await decideWindow(policy, "mouse", "input", under)
      } else {
        d = decideGlobal(policy, "mouse", `empty desktop at ${x},${y}`)
        d.reasons.push("no window at that point — only the mouse capability applies")
      }
      await gate("desktop_mouse", "mouse", d, error, under ? `class:${under.class}` : "desktop")

      const move = (mx: number, my: number) => dispatch(`hl.dsp.cursor.move({x=${mx}, y=${my}})`)

      switch (args.action) {
        case "move":
          await move(x, y)
          break
        case "click":
          await move(x, y)
          await sleep(60)
          await ydotool(["click", "0xC0"])
          break
        case "double_click":
          await move(x, y)
          await sleep(60)
          await ydotool(["click", "--repeat", "2", "--next-delay", "40", "0xC0"])
          break
        case "right_click":
          await move(x, y)
          await sleep(60)
          await ydotool(["click", "0xC1"])
          break
        case "middle_click":
          await move(x, y)
          await sleep(60)
          await ydotool(["click", "0xC2"])
          break
        case "scroll": {
          // ydotool 1.0.4 has no wheel support (mousemove only takes
          // --absolute x y), so scrolling is done with paging keys sent to
          // whatever is under the cursor. No daemon needed.
          if (!under) throw new Error(`nothing to scroll at ${x},${y} — the cursor is over empty desktop`)
          const n = Math.round(args.amount ?? -1)
          if (n === 0) throw new Error("scroll amount of 0 does nothing")
          const key = n < 0 ? "Page_Down" : "Page_Up"
          await move(x, y)
          for (let i = 0; i < Math.min(Math.abs(n), 20); i++) {
            await sendChord(key, under, policy)
            await sleep(60)
          }
          break
        }
        case "drag": {
          if (args.to_x === undefined || args.to_y === undefined) {
            throw new Error('action "drag" requires to_x and to_y')
          }
          const tx = Math.round(args.to_x)
          const ty = Math.round(args.to_y)
          const dest = await windowAt(tx, ty)
          if (dest && dest.address !== under?.address) {
            const dd = await decideWindow(policy, "mouse", "input", dest)
            await gate("desktop_mouse", "mouse", dd, error, `class:${dest.class}`)
          }
          await move(x, y)
          await sleep(60)
          await ydotool(["click", "0x40"]) // press
          await sleep(80)
          await move(tx, ty)
          await sleep(120)
          await ydotool(["click", "0x80"]) // release
          break
        }
        default:
          throw new Error(`unknown action "${args.action}"`)
      }

      await audit(policy, `mouse ${args.action} at ${x},${y}${under ? ` on ${under.class}` : ""}`)
      const now = await cursorPos()

      return say(
        [
          `${args.action} at ${x},${y}${under ? ` on ${under.class} — "${under.title}"` : " (empty desktop)"}`,
          `cursor now at ${now.x},${now.y}`,
          "Take a screenshot to confirm the effect before acting again.",
        ].join("\n"),
      )
    },
  ),
)

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
server.registerTool(
  "desktop_run",
  {
    description:
      "Run a command and get its output. This is almost always faster and more reliable than driving a GUI: " +
      "to find a file, run fd or find rather than clicking through a file manager and screenshotting it. " +
      "Takes a program name and an argument list \u2014 NOT a shell line: there is no pipe, no globbing, no $(...) " +
      "and no redirection, so pass one program per call and do the combining yourself. " +
      "Which programs you may run is set by the user in the policy's \"run\" section; anything not listed there " +
      "prompts them for approval, so prefer the listed ones and run desktop_policy if you are unsure.",
    inputSchema: {
      command: z
        .string()
        .describe('The program to run, e.g. "fd". A bare name resolved on PATH, or an absolute path. Not a shell line.'),
      args: z
        .array(z.string())
        .optional()
        .describe('Arguments, one array element each, e.g. ["invoice", "/home/dada"]. Never pre-joined into one string.'),
      cwd: z.string().optional().describe("Absolute directory to run in. Defaults to your home directory."),
    },
  },
  guard("desktop_run", async (args: { command: string; args?: string[]; cwd?: string }) => {
    const { policy, error } = await loadPolicy()
    const cmd = (args.command ?? "").trim()

    // argv form is the whole point: the first token is always the real binary,
    // so a rule about "bash" cannot be laundered through "sh -c ...".
    if (!cmd) throw new Error("pass a command")
    if (/[\s;|&><$`\n]/.test(cmd)) {
      throw new Error(
        `"${cmd}" looks like a shell line, but desktop_run takes a program and an argument list.\n` +
          '  Right: { command: "fd", args: ["invoice", "/home/dada"] }\n' +
          '  Wrong: { command: "fd invoice ~ | head" }\n' +
          "  There is no shell here, so pipes and redirection do not work \u2014 make separate calls.",
      )
    }

    const base = path.basename(cmd)

    // This plugin's own controls are not runnable, at any policy setting.
    //
    // Refused here rather than through run.commands because run.commands is a
    // rule in the very file these commands rewrite: a policy carrying
    // "*": "allow", or one written before this rule existed, re-opens the loop
    // completely. Same reasoning as the geometry check on desktop_mouse, and
    // the same boundary -- the agent must not operate the person's controls
    // over it -- reached through a different door.
    //
    // The door I had missed. The switches moved into the panel on the argument
    // that clicks onto our surfaces are refused and desktop-agent-config is
    // refused from speech; desktop_run was a third route, and under a lease it
    // was auto-approved silently, so "policy-set-yolo true" bought the agent a
    // permanent one.
    if (SELF_CONTROL.has(base)) {
      throw new Refused(
        `REFUSED: "${base}" is this plugin's own control command.\n` +
          "  It changes the policy, the lease and the capabilities that govern you,\n" +
          "  so it is not something you may run -- under a lease, a scheduled job or\n" +
          "  otherwise. The person changes these from the panel's Policy tab.\n" +
          "  To schedule something, use desktop_schedule.",
      )
    }

    const hit = evaluate(policy.run.commands, [cmd, base])
    const ag = agentAction(policy, IDENTITY, "run")
    const capAction = coerceAction(policy.capabilities.run, "ask")

    const argv = args.args ?? []
    const shown = [cmd, ...argv].join(" ")
    const d: Decision = {
      action: policy.enabled ? strictest(ag.action, capAction, hit.action) : "deny",
      subject: shown,
      reasons: policy.enabled
        ? [
            ag.note,
            `capability "run" -> ${capAction} (capabilities.run)`,
            hit.action
              ? `command "${base}" -> ${hit.action} (run.commands["${hit.rule}"])`
              : `command "${base}" -> deny (nothing in run.commands matched)`,
          ]
        : ['policy "enabled" is false \u2014 desktop control is switched off'],
    }
    await gate(
      "desktop_run",
      "run",
      d,
      error,
      `cmd:${base}`,
      neverYolo(base, argv) ? `"${base}" is destructive and is never auto-approved` : undefined,
    )

    const bin = path.isAbsolute(cmd) ? cmd : Bun.which(cmd)
    if (!bin) throw new Error(`"${cmd}" is not on PATH`)

    const cwd = args.cwd || policy.run.cwd || os.homedir()
    try {
      const st = await fs.stat(cwd)
      if (!st.isDirectory()) throw new Error("not a directory")
    } catch {
      throw new Error(`cwd "${cwd}" is not a directory`)
    }

    // A command that opens a window gets placed on the agent's workspace too.
    // isLaunch() is what keeps this honest: "wpctl set-volume" and "hyprctl
    // dispatch close" are about where the person already is, and relocating
    // those would be actively wrong.
    const launches = isLaunch([bin, ...argv])

    let stdout = ""
    let stderr = ""
    let code = -1
    let timedOut = false

    // Run it where it can be SEEN.
    //
    // Everything used to go through a pipe: output captured, nothing on
    // screen, a desktop that changed by itself with no visible cause. A person
    // asked to do this would open a terminal and type in it, and watching that
    // terminal is how you can tell what is happening while it happens rather
    // than reading about it afterwards.
    //
    // A launch is excluded: it already opens its own window, and running
    // `chromium` inside a terminal just leaves a dead shell next to it.
    const visible = VISIBLE_RUNS && !launches && CONFINE_WS > 0
    await fs.mkdir(TMP, { recursive: true })

    // One persistent terminal, typed into. A fresh window per command was a
    // flicker on a workspace nobody was looking at; this is a session you can
    // switch to and read, with the commands in order and their output kept.
    const term = visible && (await ensureAgentTerminal(CONFINE_WS, TMP))
      ? sendToAgentTerminal([bin, ...argv], TMP, cwd)
      : null

    if (term) {
      // The exit code file is the completion marker: the terminal outlives the
      // command on purpose, so there is no process to wait on.
      const { outFile, codeFile } = term

      const deadline = Date.now() + Math.max(1000, policy.run.timeoutMs)
      while (Date.now() < deadline) {
        try {
          code = Number((await fs.readFile(codeFile, "utf8")).trim())
          break
        } catch { await sleep(200) }
      }
      if (!Number.isFinite(code) || code === -1) {
        timedOut = true
        // Leave the pane usable. Without this the stalled command keeps the
        // terminal, and the next send-keys is typed into ITS stdin.
        abortAgentTerminal()
      }
      try { stdout = await fs.readFile(outFile, "utf8") } catch {}
      try { await fs.unlink(outFile) } catch {}
      try { await fs.unlink(codeFile) } catch {}
    } else {
      const runArgv = launches ? onWorkspace([bin, ...argv], CONFINE_WS) : [bin, ...argv]
      const proc = Bun.spawn(runArgv, {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        env: process.env,
      })

      // A hung command must not hold the tool call open forever.
      const timer = setTimeout(() => {
        timedOut = true
        proc.kill(9)
      }, Math.max(1000, policy.run.timeoutMs))

      try {
        ;[stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
        code = await proc.exited
      } finally {
        clearTimeout(timer)
      }
    }

    const cap = policy.run.maxOutputBytes
    const clip = (t: string) =>
      cap > 0 && t.length > cap ? `${t.slice(0, cap)}\n\u2026 truncated at ${cap} characters (run.maxOutputBytes)` : t

    await audit(policy, `run ${shown} -> exit ${timedOut ? "timeout" : code}`)

    const out: string[] = [`$ ${shown}`, `cwd: ${cwd}`]
    if (timedOut) out.push(`KILLED after ${policy.run.timeoutMs}ms (run.timeoutMs)`)
    else out.push(`exit ${code}`)
    if (stdout.trim()) out.push("", clip(stdout.trimEnd()))
    if (stderr.trim()) out.push("", "stderr:", clip(stderr.trimEnd()))
    if (!stdout.trim() && !stderr.trim()) out.push("", "(no output)")

    return say(out.join("\n"))
  }),
)

// ---------------------------------------------------------------------------

/**
 * Shared front half of desktop_write and desktop_edit: resolve the path, put it
 * through the policy, and hand back what the caller needs to finish the job.
 *
 * Both tools go through gate() exactly like every other verb, so a write lands
 * in the same audit log, raises the same overlay, stops at the same kill switch,
 * and is promoted by the same lease. There is no second permission system here.
 */
async function openForWrite(tool: string, rawPath: string) {
  const { policy, error } = await loadPolicy()
  if (!rawPath?.trim()) throw new Error("pass a path")

  const abs = await realPath(rawPath)
  const d = decidePath(policy, "write", abs)
  await gate(
    tool,
    "write",
    d,
    error,
    `path:${abs}`,
    neverYoloPath(abs) ? `"${abs}" can break the system or the agent's own leash` : undefined,
  )
  return { policy, abs }
}

server.registerTool(
  "desktop_write",
  {
    title: "Write a file",
    description:
      "Create a file or replace its entire contents. The path is checked against the \"paths\" section of " +
      "the policy, so where you may write is the user's decision, not yours. An existing file is copied " +
      "aside first. Use desktop_edit when you only want to change part of a file.",
    inputSchema: {
      path: z.string().describe('Absolute path, or "~/..." — the file to write.'),
      content: z.string().describe("The complete new contents. This replaces the file, it does not append."),
    },
  },
  guard("desktop_write", async (args: { path: string; content: string }) => {
    const { policy, abs } = await openForWrite("desktop_write", args.path)
    const content = args.content ?? ""

    const bytes = Buffer.byteLength(content, "utf8")
    if (policy.write.maxBytes > 0 && bytes > policy.write.maxBytes) {
      throw new Error(`${bytes} bytes exceeds write.maxBytes (${policy.write.maxBytes})`)
    }

    let existed = false
    try {
      const st = await fs.stat(abs)
      if (st.isDirectory()) throw new Error(`"${abs}" is a directory`)
      existed = true
    } catch (e) {
      if (existed) throw e
    }

    const saved = existed ? await backupFile(policy, abs) : undefined
    await fs.mkdir(path.dirname(abs), { recursive: true })
    await fs.writeFile(abs, content, "utf8")
    await audit(policy, `write ${abs} -> ${existed ? "replaced" : "created"} ${bytes} bytes`)

    const out = [`${existed ? "Replaced" : "Created"} ${abs} (${bytes} bytes)`]
    if (existed) out.push(saved ? `previous contents: ${saved}` : "NOTE: no backup was written")
    return say(out.join("\n"))
  }),
)

server.registerTool(
  "desktop_edit",
  {
    title: "Edit part of a file",
    description:
      "Replace an exact string inside an existing file, leaving the rest untouched. Same \"paths\" rules as " +
      "desktop_write. The old text must appear exactly once unless you pass replace_all, so a near-miss " +
      "fails loudly instead of editing the wrong line.",
    inputSchema: {
      path: z.string().describe('Absolute path, or "~/..." — the file to edit. It must already exist.'),
      old_string: z.string().describe("Exact text to find, including indentation."),
      new_string: z.string().describe("Text to put in its place."),
      replace_all: z.boolean().optional().describe("Replace every occurrence instead of requiring exactly one."),
    },
  },
  guard(
    "desktop_edit",
    async (args: { path: string; old_string: string; new_string: string; replace_all?: boolean }) => {
      const { policy, abs } = await openForWrite("desktop_edit", args.path)
      const oldStr = args.old_string ?? ""
      const newStr = args.new_string ?? ""
      if (!oldStr) throw new Error("old_string is empty — use desktop_write to create or replace a whole file")
      if (oldStr === newStr) throw new Error("old_string and new_string are identical")

      let before: string
      try {
        before = await fs.readFile(abs, "utf8")
      } catch {
        throw new Error(`"${abs}" does not exist or is not readable text — use desktop_write to create it`)
      }

      const hits = before.split(oldStr).length - 1
      if (hits === 0) throw new Error(`old_string was not found in ${abs}`)
      if (hits > 1 && !args.replace_all) {
        throw new Error(`old_string appears ${hits} times in ${abs} — add more context, or pass replace_all`)
      }

      const after = args.replace_all ? before.split(oldStr).join(newStr) : before.replace(oldStr, newStr)
      const bytes = Buffer.byteLength(after, "utf8")
      if (policy.write.maxBytes > 0 && bytes > policy.write.maxBytes) {
        throw new Error(`result would be ${bytes} bytes, over write.maxBytes (${policy.write.maxBytes})`)
      }

      const saved = await backupFile(policy, abs)
      await fs.writeFile(abs, after, "utf8")
      await audit(policy, `edit ${abs} -> ${hits} replacement${hits === 1 ? "" : "s"}`)

      const out = [`Edited ${abs} — ${hits} replacement${hits === 1 ? "" : "s"}`]
      out.push(saved ? `previous contents: ${saved}` : "NOTE: no backup was written")
      return say(out.join("\n"))
    },
  ),
)


// ===========================================================================
//  The agent's own browser -- read pages as text, not pixels.
//
//  These tools never attach to a browser they did not start. See browser.ts:
//  Chromium is underneath 1Password, Obsidian and every Electron app here, so
//  "attach to any CDP endpoint" would read straight through the window rules
//  above that exist to keep the agent out of exactly those windows.
// ===========================================================================

/** One gate for the whole browser surface, so a refusal reads the same everywhere. */
async function gateBrowser(tool: string, what: string) {
  const { policy, error } = await loadPolicy()
  await gate(tool, "browser", decideGlobal(policy, "browser", what), error, `browser:${what}`)
  return policy
}

server.registerTool(
  "desktop_browser_open",
  {
    description:
      "Open the agent's own browser and optionally navigate it. This is YOUR browser: a separate, empty " +
      "profile with no extensions, no cookies and none of the user's logins or history. Nothing you do in " +
      "it touches their real browsing. Prefer it over driving the user's Chromium for anything on the web. " +
      "It cannot attach to a browser that was already running.",
    inputSchema: {
      url: z.string().optional().describe("URL to open. Omitted just starts the browser."),
    },
  },
  guard("desktop_browser_open", async (args: { url?: string }) => {
    const policy = await gateBrowser("desktop_browser_open", args.url ? `open ${args.url}` : "open")
    await browser.ensure({ command: policy.browser.command, headless: policy.browser.headless })
    const st = browser.status()
    if (!args.url) {
      await audit(policy, `browser open (pid ${st.pid})`)
      return say(`Agent browser is running (pid ${st.pid}).\nProfile: ${st.profile}\nWindow class: ${browser.AGENT_BROWSER_CLASS}`)
    }
    const page = await browser.navigate(args.url)
    await audit(policy, `browser navigate ${args.url}`)
    return say(`Opened ${page.url}\nTitle: ${page.title || "(none)"}\n\nRead it with desktop_browser_read.`)
  }),
)

server.registerTool(
  "desktop_browser_read",
  {
    description:
      "Read the current page in the agent browser as a list of elements -- role, name, value and a numeric " +
      "'ref' you pass to desktop_browser_click or _type. Use this INSTEAD of a screenshot for anything on " +
      "the web: it is far cheaper, the text is exact rather than read off pixels, it shows element state, " +
      "and it includes content scrolled out of view. Narrow with filter/roles rather than reading everything.",
    inputSchema: {
      filter: z.string().optional().describe('Only elements whose role, name or value contains this, e.g. "sign in".'),
      roles: z.array(z.string()).optional().describe('Only these roles, e.g. ["button","textbox","link"].'),
      interactive_only: z.boolean().optional().describe("Only things you can act on. Good first look at a page."),
      max: z.number().optional().describe("Cap on elements returned (default 200)."),
    },
  },
  guard(
    "desktop_browser_read",
    async (args: { filter?: string; roles?: string[]; interactive_only?: boolean; max?: number }) => {
      const policy = await gateBrowser("desktop_browser_read", "read")
      const r = await browser.read({
        filter: args.filter,
        roles: args.roles,
        interactiveOnly: args.interactive_only,
        max: args.max,
      })
      await audit(policy, `browser read ${r.url} (${r.nodes.length} elements)`)

      const lines = r.nodes.map(
        (n) => `  [${n.ref}] ${n.role}${n.name ? ` ${JSON.stringify(n.name)}` : ""}${n.value ? ` = ${JSON.stringify(n.value)}` : ""}`,
      )
      const head = [`${r.title || "(untitled)"} — ${r.url}`, ""]
      if (!r.nodes.length) {
        head.push("No elements matched. The page may still be loading, or the filter may be too narrow.")
      }
      const tail = r.truncated
        ? ["", `showing ${r.nodes.length} of ${r.total} — narrow with filter/roles, or raise max`]
        : []
      return say([...head, ...lines, ...tail].join("\n"))
    },
  ),
)

server.registerTool(
  "desktop_browser_click",
  {
    description:
      "Click an element in the agent browser by the 'ref' from desktop_browser_read. Targets the DOM node " +
      "directly, so there is no coordinate to get wrong and the element does not need to be in view. " +
      "Refs come from the last read of that page -- re-read after the page changes.",
    inputSchema: { ref: z.number().describe("The [ref] number from desktop_browser_read.") },
  },
  guard("desktop_browser_click", async (args: { ref: number }) => {
    const policy = await gateBrowser("desktop_browser_click", "click")
    const label = await browser.click(args.ref)
    await audit(policy, `browser click [${args.ref}] ${label}`)
    return say(`Clicked [${args.ref}]${label ? ` — ${JSON.stringify(label)}` : ""}\n\nRe-read the page to see what changed.`)
  }),
)

server.registerTool(
  "desktop_browser_type",
  {
    description:
      "Type into a field in the agent browser, by the 'ref' from desktop_browser_read. Clears the field " +
      "first, then fires the input/change events frameworks listen for. Never type a password, card number " +
      "or 2FA code with this -- hand back to the user instead.",
    inputSchema: {
      ref: z.number().describe("The [ref] number of the field."),
      text: z.string().describe("Text to enter."),
      submit: z.boolean().optional().describe("Press Enter afterwards."),
    },
  },
  guard("desktop_browser_type", async (args: { ref: number; text: string; submit?: boolean }) => {
    const policy = await gateBrowser("desktop_browser_type", "type")
    if (args.text.length > policy.maxTextLength) {
      throw new Refused(
        `REFUSED: desktop_browser_type\n  ${args.text.length} characters exceeds "maxTextLength" ` +
          `(${policy.maxTextLength}) in ${policyPath()}`,
      )
    }
    // Ask the field what it is before typing into it.
    //
    // No declaration to trust and no heuristic on the text: the page already
    // knows whether this is a password box, so the gate is driven by the DOM.
    // An agent that "forgets" to flag a credential cannot get past this one.
    const { error: perr } = await loadPolicy()
    if (await browser.isSecretField(args.ref)) {
      await gate(
        "desktop_browser_type", "secret",
        decideGlobal(policy, "secret", `a password into the page at [${args.ref}]`),
        perr, `secret:browser`,
        undefined,
        "a password is never typed unattended",
      )
    }

    const msg = await browser.type(args.ref, args.text, args.submit === true)
    await audit(policy, `browser type ${args.text.length} chars into [${args.ref}]`)
    return say(`${msg}\n\nRe-read the page to see what changed.`)
  }),
)

server.registerTool(
  "desktop_browser_screenshot",
  {
    description:
      "See the page as an image, rendered by the browser itself. " +
      "Use this for anything on the web instead of desktop_screenshot: it draws the page rather than " +
      "photographing the monitor, so no other window can appear in it and it works with the browser " +
      "on another workspace or behind everything else. " +
      "desktop_browser_read is still the better tool for CONTENT — text, links, form fields, and the " +
      "refs you click and type into. Reach for this one when the question is visual: layout, spacing, " +
      "colour, whether something actually looks right.",
    inputSchema: {
      full_page: z
        .boolean()
        .optional()
        .describe("Capture the whole scrollable page rather than just the visible part. Very long pages are clipped."),
      save: z
        .boolean()
        .optional()
        .describe("Also keep it as a PNG the person can open afterwards, and report the path."),
    },
  },
  guard("desktop_browser_screenshot", async (args: { full_page?: boolean; save?: boolean }) => {
    const policy = await gateBrowser("desktop_browser_screenshot", "screenshot")
    const page = await browser.currentPage()
    const { data, w, h } = await browser.shot(args.full_page === true)

    const notes = [`rendered ${page.url}`, `"${page.title}"`, `${w}x${h} css px`]

    if (args.save) {
      await fs.mkdir(SHOTS, { recursive: true, mode: 0o700 })
      await fs.chmod(SHOTS, 0o700).catch(() => {})
      const file = path.join(SHOTS, `page-${Date.now()}-${process.pid}.png`)
      await fs.writeFile(file, Buffer.from(data, "base64"))
      await fs.chmod(file, 0o600).catch(() => {})
      await pruneShots()
      notes.splice(1, 0, `saved to ${file}`)
    }

    // No redaction note and no coordinate mapping, because neither applies:
    // nothing but this page is in the image, and you act on it through refs
    // from desktop_browser_read rather than by pointing at pixels.
    notes.push("", "This is the page only — no other window can be in it. Use desktop_browser_read for the refs to click.")

    await audit(policy, `browser screenshot ${page.url}${args.save ? " (saved)" : ""}`)
    return say(notes.join("\n"), [{ type: "image", data, mimeType: "image/png" }])
  }),
)

server.registerTool(
  "desktop_browser_close",
  {
    description: "Close the agent browser. Its profile is kept, so the next open starts where this left off.",
    inputSchema: {},
  },
  guard("desktop_browser_close", async () => {
    const policy = await gateBrowser("desktop_browser_close", "close")
    const was = await browser.close()
    await audit(policy, "browser close")
    return say(was ? "Agent browser closed." : "The agent browser was not running.")
  }),
)

// ---------------------------------------------------------------------------

/**
 * Clear captures orphaned by a run that died before its finally block -- a
 * SIGKILL, a power loss. Age-gated because a concurrent session's server may
 * have a capture in flight in the same directory right now.
 */
async function sweepStaleCaptures() {
  try {
    const now = Date.now()
    for (const name of await fs.readdir(TMP)) {
      if (!name.startsWith("shot-")) continue
      const f = path.join(TMP, name)
      try {
        const st = await fs.stat(f)
        if (now - st.mtimeMs > 5 * 60_000) await fs.rm(f, { force: true })
      } catch {
        /* someone else cleaned it first */
      }
    }
  } catch {
    /* directory does not exist yet -- nothing to sweep */
  }
}

await sweepStaleCaptures()
sweepMarkers()

await server.connect(new StdioServerTransport())
note(`ready — identity "${IDENTITY}", policy ${policyPath()}`)
{
  const { policy } = await loadPolicy()
  const y = await yoloState(policy)
  if (y.active) note(`YOLO lease is active — ${minutesLeft(y.remainingMs)} min left`)
}
